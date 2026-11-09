import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const action = readFileSync(join(root, "action.yml"), "utf8");

/** The shell script of one step in action.yml, so the tests run what really ships. */
function stepScript(name) {
  const start = action.indexOf(`- name: ${name}\n`);
  assert.notEqual(start, -1, name);
  const lines = action.slice(start).split("\n");
  const from = lines.findIndex((l) => l.trim() === "run: |") + 1;
  const indent = lines[from].match(/^ */)[0].length;
  const body = [];
  for (const line of lines.slice(from)) {
    if (line.trim() && line.match(/^ */)[0].length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join("\n");
}

/** Runs the login step with a stand-in for gh that answers whether the repository is private. */
function login({ event, repoPrivate, apiSays, authJson = "", apiKey = "" }) {
  const dir = mkdtempSync(join(tmpdir(), "mergelight-action-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const asked = join(dir, "gh-asked");
  const stub = (name, body) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub("gh", `echo "$*" >> "${asked}"\necho "${apiSays}"`);
  stub("codex", "cat > /dev/null");
  const envFile = join(dir, "env");
  writeFileSync(envFile, "");
  const r = spawnSync("bash", ["-c", stepScript("Log in to Codex")], {
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: dir,
      GITHUB_ENV: envFile,
      GITHUB_EVENT_NAME: event,
      GITHUB_REPOSITORY: "acme/widgets",
      GITHUB_ACTOR: "someone",
      REPO_PRIVATE: repoPrivate,
      AUTH_JSON: authJson,
      API_KEY: apiKey,
    },
  });
  const env = Object.fromEntries(readFileSync(envFile, "utf8").trim().split("\n").filter(Boolean).map((l) => l.split("=")));
  return { code: r.status, out: r.stdout, env, askedGh: existsSync(asked), saved: existsSync(join(dir, "codex-home", "auth.json")) };
}

test("the refresh job on a public repository has nothing to do, and doesn't fail", () => {
  for (const event of ["schedule", "workflow_dispatch"]) {
    const r = login({ event, repoPrivate: "false" });
    assert.equal(r.code, 0, event);
    assert.equal(r.env.MERGELIGHT_NO_LOGIN, "1");
    assert.match(r.out, /nothing to do/);
  }
});

test("a pull request on a public repository with no key still gets the error", () => {
  const r = login({ event: "pull_request", repoPrivate: "false" });
  assert.equal(r.code, 1);
  assert.match(r.out, /Public repositories need openai-api-key/);
});

test("a ChatGPT login on a public repository is still refused, on every event", () => {
  for (const event of ["pull_request", "schedule", "workflow_dispatch"]) {
    const r = login({ event, repoPrivate: "false", authJson: "{}" });
    assert.equal(r.code, 1, event);
    assert.equal(r.saved, false);
  }
});

test("an event that doesn't say whether the repository is private: asks GitHub", () => {
  const priv = login({ event: "schedule", repoPrivate: "", apiSays: "true", authJson: "{}" });
  assert.equal(priv.code, 0);
  assert.equal(priv.askedGh, true);
  assert.equal(priv.env.MERGELIGHT_CHATGPT, "1");
  assert.equal(priv.saved, true);

  const pub = login({ event: "schedule", repoPrivate: "", apiSays: "false" });
  assert.equal(pub.code, 0);
  assert.equal(pub.env.MERGELIGHT_NO_LOGIN, "1");
});

test("an event that does say doesn't cost a call to GitHub", () => {
  const r = login({ event: "pull_request", repoPrivate: "true", authJson: "{}" });
  assert.equal(r.askedGh, false);
  assert.equal(r.env.MERGELIGHT_CHATGPT, "1");
});

test("a private repository with no login yet connects on a pull request, and idles on the job", () => {
  assert.equal(login({ event: "pull_request", repoPrivate: "true" }).env.MERGELIGHT_CONNECT, "1");
  assert.equal(login({ event: "schedule", repoPrivate: "true" }).env.MERGELIGHT_NO_LOGIN, "1");
});

test("the refresh and its save come before the review, and the login step can call gh", () => {
  assert.ok(action.indexOf("- name: Refresh the Codex login if it's due") < action.indexOf("- name: Review\n"));
  assert.match(action.slice(action.indexOf("- name: Log in to Codex"), action.indexOf("- name: Refresh the Codex login")), /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(stepScript("Log in to Codex"), /MERGELIGHT_LOGIN_LOST=0/, "nothing carries over from an earlier run in the job");
  assert.doesNotMatch(action, /Reply with the single word OK/, "the job no longer spends plan quota on a model call");
});

function choose({ wanted = "", claude = "", codex = "" }) {
  const dir = mkdtempSync(join(tmpdir(), "mergelight-choose-"));
  const envFile = join(dir, "env");
  writeFileSync(envFile, "");
  const r = spawnSync("bash", ["-c", stepScript("Choose the reviewer")], { encoding: "utf8", env: { PATH: process.env.PATH, GITHUB_ENV: envFile, WANTED: wanted, HAS_CLAUDE: claude, HAS_CODEX: codex } });
  const env = Object.fromEntries(readFileSync(envFile, "utf8").trim().split("\n").filter(Boolean).map((l) => l.split("=")));
  return { code: r.status, out: r.stdout, env };
}

test("a repository with only a Claude login reviews with Claude, and nothing from an earlier run carries over", () => {
  const r = choose({ claude: "1" });
  assert.equal(r.code, 0);
  assert.equal(r.env.MERGELIGHT_PROVIDER, "claude");
  assert.equal(r.env.MERGELIGHT_CONNECT, "0");
  assert.equal(r.env.MERGELIGHT_NO_LOGIN, "0");
});

test("Codex stays the choice when it has a login, or when there's no login at all", () => {
  assert.equal(choose({ codex: "1" }).env.MERGELIGHT_PROVIDER, "codex");
  assert.equal(choose({ claude: "1", codex: "1" }).env.MERGELIGHT_PROVIDER, "codex", "a repository that had Codex doesn't switch by itself");
  assert.equal(choose({}).env.MERGELIGHT_PROVIDER, "codex", "no login still leads to the ChatGPT connect flow");
});

test("the provider input wins, and a wrong one says what's wrong", () => {
  assert.equal(choose({ wanted: "claude", claude: "1", codex: "1" }).env.MERGELIGHT_PROVIDER, "claude");
  const none = choose({ wanted: "claude", codex: "1" });
  assert.equal(none.code, 1);
  assert.match(none.out, /no Claude login/);
  const typo = choose({ wanted: "gemini" });
  assert.equal(typo.code, 1);
  assert.match(typo.out, /provider must be claude or codex/);
});

