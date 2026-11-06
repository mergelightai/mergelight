import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkAuthJson, setup, workflowFiles } from "../dist/setup.js";

const here = dirname(fileURLToPath(import.meta.url));
const GOOD_AUTH = JSON.stringify({ auth_mode: "chatgpt", tokens: { refresh_token: "r" } });

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
  for (const name of ["mergelight.yml", "mergelight-approve.yml", "mergelight-refresh.yml"]) {
    assert.equal(
      readFileSync(join(here, "..", "templates", name), "utf8"),
      readFileSync(join(here, "..", "..", "..", "examples", name), "utf8"),
      `${name} differs from examples/`,
    );
  }
});

test("no workflow needs a personal token any more", () => {
  for (const f of workflowFiles()) assert.doesNotMatch(f.content, /secrets-token|MERGELIGHT_SECRETS_TOKEN/, f.name);
});

test("the workflows that write a login can ask for the app's token", () => {
  for (const f of workflowFiles().filter((x) => x.name !== "mergelight-approve.yml")) assert.match(f.content, /id-token: write/, f.name);
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

test("a ChatGPT login is refused on a public repository, before any login", async () => {
  let logins = 0;
  const f = fake({ isPrivate: false });
  f.deps.codexLogin = async () => (logins++, GOOD_AUTH);
  assert.equal(await setup({ repo: "acme/widgets", yes: true }, f.deps), 1);
  assert.equal(logins, 0);
  assert.ok(f.logs.some((l) => l.includes("openai-api-key")));
});

test("the workflows go to the chosen branch", async () => {
  const f = fake({ secrets: ["CODEX_AUTH_JSON"] });
  await setup({ repo: "acme/widgets", yes: true, base: "staging" }, f.deps);
  const pr = f.calls.find((c) => c.args.includes("POST") && c.args.includes("repos/acme/widgets/pulls"));
  assert.ok(pr.args.includes("base=staging"));
});

test("does nothing when the workflows are already there", async () => {
  const files = Object.fromEntries(workflowFiles().map((x) => [x.name, x.content]));
  const f = fake({ secrets: ["CODEX_AUTH_JSON"], files });
  assert.equal(await setup({ repo: "acme/widgets", yes: true }, f.deps), 0);
  assert.equal(puts(f.calls).length, 0);
  assert.ok(f.logs.some((l) => l.includes("already has the workflows")));
});

test("reuses a pull request from an earlier setup", async () => {
  const f = fake({ secrets: ["CODEX_AUTH_JSON"], openPrs: [{ html_url: "https://github.com/acme/widgets/pull/9" }] });
  await setup({ repo: "acme/widgets", yes: true }, f.deps);
  assert.ok(f.logs.some((l) => l.includes("/pull/9")));
  assert.ok(!f.calls.some((c) => c.args.includes("POST") && c.args.includes("repos/acme/widgets/pulls")));
});
