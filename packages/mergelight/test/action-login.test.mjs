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

/** Runs the login step. A stand-in for gh records any call, because the step should need none. */
function login({ event, authJson = "", apiKey = "", headRepo = "", actor = "someone", run }) {
  const dir = mkdtempSync(join(tmpdir(), "mergelight-action-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const asked = join(dir, "gh-asked");
  const stub = (name, body) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub("gh", `echo "$*" >> "${asked}"`);
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
      GITHUB_ACTOR: actor,
      HEAD_REPO: headRepo,
      AUTH_JSON: authJson,
      API_KEY: apiKey,
      ...(run ? { RUN: run } : {}),
    },
  });
  const env = Object.fromEntries(readFileSync(envFile, "utf8").trim().split("\n").filter(Boolean).map((l) => l.split("=")));
  return { code: r.status, out: r.stdout, env, askedGh: existsSync(asked), saved: existsSync(join(dir, "codex-home", "auth.json")) };
}

test("the jobs step never starts a sign-in: with no login it skips, and the review connects one", () => {
  const r = login({ event: "pull_request", headRepo: "acme/widgets", run: "jobs" });
  assert.equal(r.code, 0);
  assert.equal(r.env.MERGELIGHT_NO_LOGIN, "1");
  assert.notEqual(r.env.MERGELIGHT_CONNECT, "1");
  assert.match(r.out, /Skipping the jobs: there's no AI login yet/);
  assert.equal(login({ event: "pull_request", headRepo: "acme/widgets", run: "review" }).env.MERGELIGHT_CONNECT, "1", "the review still connects");
});

test("the refresh job with no login has nothing to do, and doesn't fail", () => {
  for (const event of ["schedule", "workflow_dispatch"]) {
    const r = login({ event });
    assert.equal(r.code, 0, event);
    assert.equal(r.env.MERGELIGHT_NO_LOGIN, "1");
    assert.match(r.out, /nothing to keep fresh/);
  }
});

test("a pull request with no login connects, on any repository, without asking GitHub what kind it is", () => {
  const r = login({ event: "pull_request", headRepo: "acme/widgets" });
  assert.equal(r.code, 0);
  assert.equal(r.env.MERGELIGHT_CONNECT, "1");
  assert.equal(r.askedGh, false);
  assert.doesNotMatch(action, /REPO_PRIVATE|private repositories only/);
});

test("a ChatGPT login is used on every event", () => {
  for (const event of ["pull_request", "schedule", "workflow_dispatch"]) {
    const r = login({ event, authJson: "{}" });
    assert.equal(r.code, 0, event);
    assert.equal(r.env.MERGELIGHT_CHATGPT, "1");
    assert.equal(r.saved, true);
  }
});

test("a pull request from a fork or from Dependabot never starts a sign-in", () => {
  for (const event of ["pull_request", "pull_request_target"]) {
    const fork = login({ event, headRepo: "stranger/widgets" });
    assert.equal(fork.code, 0);
    assert.equal(fork.env.MERGELIGHT_CONNECT, "0");
    assert.equal(fork.env.MERGELIGHT_NO_LOGIN, "1");
    assert.match(fork.out, /forks no secrets/);
  }
  const bot = login({ event: "pull_request", headRepo: "acme/widgets", actor: "dependabot[bot]" });
  assert.equal(bot.env.MERGELIGHT_CONNECT, "0");
  assert.equal(bot.env.MERGELIGHT_NO_LOGIN, "1");
});

test("a fork's pull request is still reviewed when the workflow gives it a login", () => {
  const r = login({ event: "pull_request_target", headRepo: "stranger/widgets", authJson: "{}" });
  assert.equal(r.env.MERGELIGHT_CHATGPT, "1");
  assert.equal(r.env.MERGELIGHT_NO_LOGIN, "0");
});

test("the refresh and its save come before the review", () => {
  assert.ok(action.indexOf("- name: Refresh the Codex login if it's due") < action.indexOf("- name: Review\n"));
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


test("action.yml is valid YAML, so GitHub can load the action at all", (t) => {
  // GitHub reads action.yml only when a workflow uses the action: a broken one fails in every customer's
  // run, and in no test of this repository. Ruby's YAML parser is on GitHub's runners and on macOS.
  for (const file of ["action.yml", "push-jobs/action.yml"]) {
    const ruby = spawnSync("ruby", ["-ryaml", "-e", "YAML.load_file(ARGV[0])", join(root, file)], { encoding: "utf8" });
    if (ruby.error) return t.skip("ruby isn't installed here; the tests on GitHub check this too");
    assert.equal(ruby.status, 0, `${file}: ${ruby.stderr.split("\n")[0]}`);
  }
});

test("the push step for jobs installs no AI and is given no AI login", () => {
  const push = readFileSync(join(root, "push-jobs/action.yml"), "utf8");
  assert.doesNotMatch(push, /codex|claude|anthropic|openai|auth-json|oauth/i);
  assert.match(push, /push-jobs "\$GITHUB_REPOSITORY#\$PR" --from "\$RESULT"/);
});
