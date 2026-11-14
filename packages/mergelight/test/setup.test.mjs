import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkAuthJson, setup, workflowFiles } from "../dist/setup.js";

const here = dirname(fileURLToPath(import.meta.url));
const GOOD_AUTH = JSON.stringify({ auth_mode: "chatgpt", tokens: { refresh_token: "r" } });
const PIN = { tag: "v0.1.0", sha: "a".repeat(40) };

/** A fake gh. Records calls, and knows about one repository. */
function fake({ secrets = [], isPrivate = true, files = {}, openPrs = [] } = {}) {
  const calls = [];
  const logs = [];
  const deps = {
    gh: async (args, input) => {
      calls.push({ args, input });
      const [a, b] = args;
      if (a === "secret" && b === "list") return JSON.stringify(secrets.map((name) => ({ name })));
      if (a === "secret" && b === "set") return "";
      const path = args.find((x) => x.startsWith("repos/")) ?? "";
      if (path === "repos/mergelightai/mergelight/releases/latest") return `${PIN.tag}\n`;
      if (path === `repos/mergelightai/mergelight/commits/${PIN.tag}`) return `${PIN.sha}\n`;
      if (path === "repos/acme/widgets") return JSON.stringify({ private: isPrivate, default_branch: "main" });
      if (path.includes("/contents/") && !args.includes("PUT")) {
        const name = path.split("/").pop().split("?")[0];
        if (files[name] === undefined) throw new Error("404");
        return JSON.stringify({ sha: "abc", content: Buffer.from(files[name]).toString("base64") });
      }
      if (path.includes("/git/ref/heads/")) return "base-sha\n";
      if (path.includes("/pulls?")) return JSON.stringify(openPrs);
      if (path.endsWith("/pulls")) return "https://github.com/acme/widgets/pull/1\n";
      return "{}";
    },
    codexLogin: async () => GOOD_AUTH,
    open: async (url) => logs.push(`open ${url}`),
    confirm: async () => logs.push("confirm"),
    log: (m) => logs.push(m),
  };
  return { calls, logs, deps };
}

const puts = (calls) => calls.filter((c) => c.args.includes("PUT")).map((c) => c.args[3]);

test("the templates are the example workflows", () => {
  for (const name of ["mergelight.yml", "mergelight-jobs.yml", "mergelight-approve.yml", "mergelight-refresh.yml"]) {
    assert.equal(
      readFileSync(join(here, "..", "templates", name), "utf8"),
      readFileSync(join(here, "..", "..", "..", "examples", name), "utf8"),
      `${name} differs from examples/`,
    );
  }
});

test("the workflow still has the lines the setup page adds to", () => {
  const root = join(here, "..", "..", "..");
  const file = readFileSync(join(root, "examples", "mergelight.yml"), "utf8");
  const markers = [...readFileSync(join(root, "site", "src", "setup", "Setup.tsx"), "utf8").matchAll(/_MARKER = '(.+)'/g)].map((m) => m[1]);
  assert.equal(markers.length, 2);
  for (const marker of markers) assert.ok(file.includes(marker), marker);
});

test("no workflow needs a personal token any more", () => {
  for (const f of workflowFiles()) assert.doesNotMatch(f.content, /secrets-token|MERGELIGHT_SECRETS_TOKEN/, f.name);
});

test("the workflows that write a login can ask for the app's token", () => {
  for (const f of workflowFiles().filter((x) => x.name !== "mergelight-approve.yml")) assert.match(f.content, /id-token: write/, f.name);
});

test("by default every workflow follows @v0, and says why it isn't pinned", () => {
  for (const f of workflowFiles()) {
    assert.match(f.content, /uses: mergelightai\/mergelight@v0\n/, f.name);
    assert.match(f.content, /# Not pinned, on purpose\./, f.name);
  }
});

test("pinning uses the release's commit, with the version beside it, and says why it's pinned", () => {
  for (const f of workflowFiles([], PIN)) {
    assert.match(f.content, new RegExp(`uses: mergelightai/mergelight@${PIN.sha} # ${PIN.tag}\\n`), f.name);
    assert.doesNotMatch(f.content, /mergelight@v0/, f.name);
    assert.doesNotMatch(f.content, /Not pinned|releases\n/, f.name);
    assert.match(f.content, /steps:\n\s+# Pinned to a release, so new code only runs here once you merge an update\.\n\s+# Mergelight says on your pull requests when a new version is out\.\n\s+- uses:/, f.name);
  }
});

test("odd branch names can't break the review's condition", () => {
  const review = workflowFiles(["release/o'clock", "feature/$&"]).find((f) => f.name === "mergelight.yml");
  assert.ok(review.content.includes(`fromJSON('["release/o''clock","feature/$&"]')`), review.content);
});

test("Dependabot runs are skipped, and there's room for the first login", () => {
  const review = workflowFiles().find((f) => f.name === "mergelight.yml");
  assert.match(review.content, /github\.actor != 'dependabot\[bot\]'/);
  assert.equal(Number(review.content.match(/timeout-minutes: (\d+)/)[1]) >= 45, true);
});

test("skipped branches end up in the review's condition, as valid expression syntax", () => {
  const review = workflowFiles(["staging", "development"]).find((f) => f.name === "mergelight.yml");
  assert.match(review.content, /!contains\(fromJSON\('\["staging","development"\]'\), github\.head_ref\)/);
  const plain = workflowFiles().find((f) => f.name === "mergelight.yml");
  assert.doesNotMatch(plain.content, /fromJSON/);
});

test("checks the login is a ChatGPT login that can refresh", () => {
  assert.doesNotThrow(() => checkAuthJson(GOOD_AUTH));
  assert.throws(() => checkAuthJson(JSON.stringify({ auth_mode: "apikey" })), /ChatGPT login/);
  assert.throws(() => checkAuthJson(JSON.stringify({ auth_mode: "chatgpt", tokens: {} })), /ChatGPT login/);
  assert.throws(() => checkAuthJson("not json"), /can't be read/);
});

test("a new repository: asks about the app, saves the login, opens a pull request", async () => {
  const f = fake();
  assert.equal(await setup({ repo: "acme/widgets" }, f.deps), 0);
  assert.ok(f.logs.includes("confirm"));
  assert.ok(f.logs.some((l) => l.startsWith("open https://github.com/apps/mergelight-ai")));
  const saved = f.calls.find((c) => c.args[0] === "secret" && c.args[1] === "set");
  assert.deepEqual(saved.args, ["secret", "set", "CODEX_AUTH_JSON", "--repo", "acme/widgets"]);
  assert.equal(saved.input, GOOD_AUTH);
  assert.equal(puts(f.calls).length, 3);
  assert.ok(f.logs.some((l) => l.includes("https://github.com/acme/widgets/pull/1")));
  assert.ok(!f.logs.some((l) => l.includes("refresh_token")), "never prints the login");
});

test("keeps an existing login unless asked to log in again", async () => {
  let logins = 0;
  const f = fake({ secrets: ["CODEX_AUTH_JSON"] });
  f.deps.codexLogin = async () => (logins++, GOOD_AUTH);
  await setup({ repo: "acme/widgets", yes: true }, f.deps);
  assert.equal(logins, 0);
  await setup({ repo: "acme/widgets", yes: true, relogin: true }, f.deps);
  assert.equal(logins, 1);
});

test("--yes doesn't stop to ask", async () => {
  const f = fake({ secrets: ["CODEX_AUTH_JSON"] });
  await setup({ repo: "acme/widgets", yes: true }, f.deps);
  assert.ok(!f.logs.includes("confirm"));
});

test("a public repository connects ChatGPT the same way", async () => {
  let logins = 0;
  const f = fake({ isPrivate: false });
  f.deps.codexLogin = async () => (logins++, GOOD_AUTH);
  assert.equal(await setup({ repo: "acme/widgets", yes: true }, f.deps), 0);
  assert.equal(logins, 1);
});

test("the workflows go to the chosen branch", async () => {
  const f = fake({ secrets: ["CODEX_AUTH_JSON"] });
  await setup({ repo: "acme/widgets", yes: true, base: "staging" }, f.deps);
  const pr = f.calls.find((c) => c.args.includes("POST") && c.args.includes("repos/acme/widgets/pulls"));
  assert.ok(pr.args.includes("base=staging"));
});

test("does nothing when the workflows are already there", async () => {
  const files = Object.fromEntries(workflowFiles([], PIN).map((x) => [x.name, x.content]));
  const f = fake({ secrets: ["CODEX_AUTH_JSON"], files });
  assert.equal(await setup({ repo: "acme/widgets", yes: true }, f.deps), 0);
  assert.equal(puts(f.calls).length, 0);
  assert.ok(f.logs.some((l) => l.includes("already has the workflows")));
});

test("setup pins what it adds by default, and with pin: false the latest release isn't even looked up", async () => {
  const content = (calls) => calls.filter((c) => c.args.includes("PUT")).map((c) => Buffer.from(c.args.find((a) => a.startsWith("content=")).slice(8), "base64").toString());
  const follows = fake({ secrets: ["CODEX_AUTH_JSON"] });
  await setup({ repo: "acme/widgets", yes: true, pin: false }, follows.deps);
  assert.ok(!follows.calls.some((c) => c.args.some((a) => a.includes("releases/latest"))));
  for (const file of content(follows.calls)) assert.match(file, /mergelight@v0/);
  const pinned = fake({ secrets: ["CODEX_AUTH_JSON"] });
  await setup({ repo: "acme/widgets", yes: true }, pinned.deps);
  assert.equal(content(pinned.calls).length, 3);
  for (const file of content(pinned.calls)) assert.ok(file.includes(`mergelight@${PIN.sha} # ${PIN.tag}`));
});

test("reuses a pull request from an earlier setup", async () => {
  const f = fake({ secrets: ["CODEX_AUTH_JSON"], openPrs: [{ html_url: "https://github.com/acme/widgets/pull/9" }] });
  await setup({ repo: "acme/widgets", yes: true }, f.deps);
  assert.ok(f.logs.some((l) => l.includes("/pull/9")));
  assert.ok(!f.calls.some((c) => c.args.includes("POST") && c.args.includes("repos/acme/widgets/pulls")));
});

test("a public repository gets the refresh job too", async () => {
  const f = fake({ isPrivate: false, secrets: ["CODEX_AUTH_JSON"] });
  assert.equal(await setup({ repo: "acme/widgets", yes: true }, f.deps), 0);
  const added = puts(f.calls).join();
  assert.match(added, /mergelight\.yml/);
  assert.match(added, /mergelight-refresh\.yml/);
});

test("with jobs, the workflow runs them, and every Mergelight line is pinned and skips the same branches", () => {
  const [main] = workflowFiles(["staging"], { sha: "c".repeat(40), tag: "v0.2.0" }, true);
  assert.equal(main.name, "mergelight.yml");
  assert.match(main.content, /run: jobs/);
  assert.equal([...main.content.matchAll(new RegExp(`mergelightai/mergelight@${"c".repeat(40)} # v0\\.2\\.0`, "g"))].length, 2);
  assert.match(main.content, new RegExp(`mergelightai/mergelight/push-jobs@${"c".repeat(40)} # v0\\.2\\.0`));
  assert.doesNotMatch(main.content, /@v0\b/);
  assert.equal([...main.content.matchAll(/!contains\(fromJSON\('\["staging"\]'\), github\.head_ref\)/g)].length, 2, "the jobs and the review both skip staging");
  assert.doesNotMatch(workflowFiles()[0].content, /run: jobs/, "without jobs, the plain workflow");
});
