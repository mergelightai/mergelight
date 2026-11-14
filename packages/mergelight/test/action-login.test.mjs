import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  assert.notEqual(r.env.MERGELIGHT_NO_LOGIN, "1");
});

test("the Codex login never clears the choice step's skip, which a Claude reviewer with no login sets", () => {
  // A fork's pull request with Claude to review and Codex to check, and no secrets: the choice step skips.
  const skip = choose({ wanted: "claude", checker: "codex", headRepo: "stranger/widgets" });
  assert.equal(skip.env.MERGELIGHT_NO_LOGIN, "1");
  assert.doesNotMatch(stepScript("Log in to Codex"), /MERGELIGHT_NO_LOGIN=0/);
});

test("the refresh and its save come before the review", () => {
  assert.ok(action.indexOf("- name: Refresh the Codex login if it's due") < action.indexOf("- name: Review\n"));
  assert.match(stepScript("Log in to Codex"), /MERGELIGHT_LOGIN_LOST=0/, "nothing carries over from an earlier run in the job");
  assert.doesNotMatch(action, /Reply with the single word OK/, "the job no longer spends plan quota on a model call");
});

function choose({ wanted = "", checker = "", claude = "", codex = "", event = "pull_request", headRepo = "acme/widgets", actor = "someone", visibility = "private" }) {
  const dir = mkdtempSync(join(tmpdir(), "mergelight-choose-"));
  const envFile = join(dir, "env");
  writeFileSync(envFile, "");
  const r = spawnSync("bash", ["-c", stepScript("Choose who reviews and who checks")], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, GITHUB_ENV: envFile, WANTED: wanted, WANTED_CHECKER: checker, HAS_CLAUDE: claude, HAS_CODEX: codex, GITHUB_EVENT_NAME: event, GITHUB_REPOSITORY: "acme/widgets", GITHUB_ACTOR: actor, HEAD_REPO: headRepo, VISIBILITY: visibility },
  });
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
  // provider: claude with no Claude login: the pull request asks to connect Claude, as a missing ChatGPT
  // login does for Codex. Forks, Dependabot and other events skip the review instead of failing.
  const none = choose({ wanted: "claude", codex: "1" });
  assert.equal(none.code, 0);
  assert.equal(none.env.MERGELIGHT_PROVIDER, "claude");
  assert.equal(none.env.MERGELIGHT_CONNECT_CLAUDE, "1");
  assert.equal(none.env.MERGELIGHT_NO_LOGIN, "0");
  assert.equal(none.env.MERGELIGHT_CONNECT_CHECK, "", "one sign-in a run");
  assert.equal(none.env.MERGELIGHT_USES_CLAUDE, "1", "Claude Code is installed for the sign-in");
  for (const other of [{ headRepo: "stranger/widgets" }, { actor: "dependabot[bot]" }, { event: "schedule" }]) {
    const skip = choose({ wanted: "claude", codex: "1", ...other });
    assert.equal(skip.code, 0, JSON.stringify(other));
    assert.equal(skip.env.MERGELIGHT_CONNECT_CLAUDE, "0", JSON.stringify(other));
    assert.equal(skip.env.MERGELIGHT_NO_LOGIN, "1", JSON.stringify(other));
    assert.match(skip.out, /Skipping the review/);
  }
  const typo = choose({ wanted: "gemini" });
  assert.equal(typo.code, 1);
  assert.match(typo.out, /provider must be claude or codex/);
});


test("with a login for both AIs, the one that doesn't review checks, and a value set always wins", () => {
  const both = choose({ claude: "1", codex: "1" });
  assert.equal(both.env.MERGELIGHT_PROVIDER, "codex", "adding a login never moves the reviewer");
  assert.equal(both.env.MERGELIGHT_VERIFY, "claude");
  assert.equal(both.env.MERGELIGHT_USES_CODEX, "1");
  assert.equal(both.env.MERGELIGHT_USES_CLAUDE, "1");
  const claudeReviews = choose({ wanted: "claude", claude: "1", codex: "1" });
  assert.equal(claudeReviews.env.MERGELIGHT_VERIFY, "codex", "Codex can check a Claude review");
  assert.equal(choose({ wanted: "claude", checker: "claude", claude: "1", codex: "1" }).env.MERGELIGHT_VERIFY, "claude");
  assert.equal(choose({ checker: "codex", claude: "1", codex: "1" }).env.MERGELIGHT_VERIFY, "codex");
  // One login: the reviewer checks its own findings, and only that AI is installed.
  const one = choose({ claude: "1" });
  assert.equal(one.env.MERGELIGHT_VERIFY, "claude");
  assert.equal(one.env.MERGELIGHT_VERIFY_FOLLOWS, "1");
  assert.equal(one.env.MERGELIGHT_USES_CODEX, "0");
  assert.equal(one.env.MERGELIGHT_CONNECT_CHECK, "");
  const typo = choose({ checker: "gemini", codex: "1" });
  assert.equal(typo.code, 1);
  assert.match(typo.out, /verify-with must be claude or codex/);
});

test("a checker with no login is connected from the repository's own pull request, and nowhere else", () => {
  const ask = choose({ wanted: "claude", claude: "1", checker: "codex" });
  assert.equal(ask.env.MERGELIGHT_PROVIDER, "claude");
  assert.equal(ask.env.MERGELIGHT_CONNECT_CHECK, "codex");
  assert.equal(ask.env.MERGELIGHT_USES_CODEX, "1", "Codex is installed, its sandbox opened and its login asked for");
  assert.equal(ask.env.MERGELIGHT_VERIFY_FOLLOWS, "0");
  assert.equal(choose({ codex: "1", checker: "claude" }).env.MERGELIGHT_CONNECT_CHECK, "claude");
  assert.equal(choose({ wanted: "claude", claude: "1", checker: "codex", headRepo: "stranger/widgets" }).env.MERGELIGHT_CONNECT_CHECK, "", "a fork");
  assert.equal(choose({ wanted: "claude", claude: "1", checker: "codex", actor: "dependabot[bot]" }).env.MERGELIGHT_CONNECT_CHECK, "", "Dependabot");
  assert.equal(choose({ wanted: "claude", claude: "1", checker: "codex", event: "schedule" }).env.MERGELIGHT_CONNECT_CHECK, "", "not a pull request");
  // One sign-in a run: a Codex reviewer with no login connects first.
  assert.equal(choose({ checker: "claude" }).env.MERGELIGHT_CONNECT_CHECK, "");
});

test("Codex that only checks, with no login, holds nothing up", () => {
  const dir = mkdtempSync(join(tmpdir(), "mergelight-action-check-"));
  const envFile = join(dir, "env");
  writeFileSync(envFile, "");
  for (const connectCheck of ["codex", ""]) {
    const r = spawnSync("bash", ["-c", stepScript("Log in to Codex")], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, RUNNER_TEMP: dir, GITHUB_ENV: envFile, GITHUB_EVENT_NAME: "pull_request", GITHUB_REPOSITORY: "acme/widgets", GITHUB_ACTOR: "someone", HEAD_REPO: "acme/widgets", AUTH_JSON: "", API_KEY: "", MERGELIGHT_PROVIDER: "claude", MERGELIGHT_CONNECT_CHECK: connectCheck },
    });
    assert.equal(r.status, 0, r.stderr);
    const env = Object.fromEntries(readFileSync(envFile, "utf8").trim().split("\n").filter(Boolean).map((l) => l.split("=")));
    assert.notEqual(env.MERGELIGHT_NO_LOGIN, "1", "the Claude review still runs");
    assert.equal(env.MERGELIGHT_CONNECT, "0", "no reviewer's sign-in");
    assert.equal(existsSync(join(dir, "codex-home", "config.toml")), connectCheck === "codex", connectCheck);
    rmSync(join(dir, "codex-home"), { recursive: true, force: true });
  }
});

/** Runs the review step with stand-ins for node, which prints what it was asked, and codex. */
function reviewArgs({ provider, verify, follows = "0", claudeToken = "", codexLoggedIn = false, lost = "0", usesCodex = "1", usesClaude = "1", notInstalled = "0" }) {
  const dir = mkdtempSync(join(tmpdir(), "mergelight-review-step-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "node"), '#!/usr/bin/env bash\nshift\necho "$*"\n');
  writeFileSync(join(bin, "codex"), `#!/usr/bin/env bash\nexit ${codexLoggedIn ? 0 : 1}\n`);
  chmodSync(join(bin, "node"), 0o755);
  chmodSync(join(bin, "codex"), 0o755);
  const r = spawnSync("bash", ["-c", stepScript("Review")], {
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: dir, GITHUB_ACTION_PATH: dir, GITHUB_REPOSITORY: "acme/widgets", PR: "7", MODEL: "", EFFORT: "", YELLOW_BLOCKS: "false", AUTO_APPROVE: "true", CLAUDE_CODE_OAUTH_TOKEN: claudeToken, ANTHROPIC_API_KEY: "", MERGELIGHT_PROVIDER: provider, MERGELIGHT_VERIFY: verify, MERGELIGHT_VERIFY_FOLLOWS: follows, MERGELIGHT_LOGIN_LOST: lost, MERGELIGHT_USES_CODEX: usesCodex, MERGELIGHT_USES_CLAUDE: usesClaude, MERGELIGHT_CHECKER_NOT_INSTALLED: notInstalled, COMMIT: "", JOBS_RESULT: "", JOBS_COMMIT: "", JOBS_WHY: "" },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test("the review checks with the other AI when it has a login, and with the reviewer when it hasn't, saying so", () => {
  assert.match(reviewArgs({ provider: "claude", verify: "codex", claudeToken: "t", codexLoggedIn: true }), /--provider claude --verify-with codex --out/);
  const missed = reviewArgs({ provider: "claude", verify: "codex", claudeToken: "t" });
  assert.match(missed, /--provider claude --verify-with claude --out .* --verify-missed codex/);
  assert.match(reviewArgs({ provider: "claude", verify: "codex", claudeToken: "t", codexLoggedIn: true, lost: "1" }), /--verify-with claude .*--verify-missed codex/, "a lost ChatGPT login");
  assert.match(reviewArgs({ provider: "codex", verify: "claude", codexLoggedIn: true }), /--verify-with codex .*--verify-missed claude/);
  assert.match(reviewArgs({ provider: "codex", verify: "claude", claudeToken: "t", codexLoggedIn: true }), /--verify-with claude --out/);
  // A checker left to follow the reviewer follows it, also when connecting Claude made Claude the reviewer.
  const follows = reviewArgs({ provider: "claude", verify: "codex", follows: "1", claudeToken: "t" });
  assert.match(follows, /--verify-with claude --out/);
  assert.doesNotMatch(follows, /verify-missed/);
  assert.doesNotMatch(action, /VERIFY_WITH=claude/, "a Claude review is no longer always checked by Claude");
  // A Codex login the runner itself has never counts: only one this Action set up.
  assert.match(reviewArgs({ provider: "claude", verify: "codex", claudeToken: "t", codexLoggedIn: true, usesCodex: "0" }), /--verify-with claude .*--verify-missed codex/);
  assert.match(reviewArgs({ provider: "codex", verify: "claude", claudeToken: "t", codexLoggedIn: true, usesClaude: "0" }), /--verify-with codex .*--verify-missed claude/);
  assert.match(reviewArgs({ provider: "claude", verify: "codex", claudeToken: "t", usesCodex: "0", notInstalled: "1" }), /--verify-missed codex --verify-missed-why not-installed/);
  assert.match(reviewArgs({ provider: "claude", verify: "codex", claudeToken: "t", codexLoggedIn: true, lost: "1" }), /--verify-missed codex --verify-missed-why login-failed/);
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

test("only the Codex login this Action set up is ever saved", () => {
  const dir = mkdtempSync(join(tmpdir(), "mergelight-save-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const asked = join(dir, "gh-asked");
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash\necho "$*" >> "${asked}"\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const other = join(dir, "runner-own-codex");
  mkdirSync(other);
  writeFileSync(join(other, "auth.json"), "{}");
  const r = spawnSync("bash", [join(root, "packages/mergelight/scripts/save-login.sh")], {
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, CODEX_HOME: other, RUNNER_TEMP: dir, SECRET_NAME: "CODEX_AUTH_JSON", SECRETS_TOKEN: "t", GITHUB_REPOSITORY: "acme/widgets" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(asked), false, "nothing was saved");
});

test("a checker is set up only when it can check, and connecting ChatGPT never moves an automatic Claude reviewer", () => {
  // Claude reviews only because it has the one login: asking for ChatGPT would make Codex review next time.
  const auto = choose({ claude: "1", checker: "codex" });
  assert.equal(auto.env.MERGELIGHT_CONNECT_CHECK, "");
  assert.match(auto.out, /Set provider: claude in the workflow/);
  assert.equal(auto.env.MERGELIGHT_USES_CODEX, "0", "nothing is installed for a checker that can't check");
  // Said in the workflow, Claude stays the reviewer, so ChatGPT is asked for.
  const said = choose({ wanted: "claude", claude: "1", checker: "codex" });
  assert.equal(said.env.MERGELIGHT_CONNECT_CHECK, "codex");
  assert.equal(said.env.MERGELIGHT_USES_CODEX, "1");
  // A fork can't ask, so the checker isn't set up either.
  assert.equal(choose({ wanted: "claude", claude: "1", checker: "codex", headRepo: "stranger/widgets" }).env.MERGELIGHT_USES_CODEX, "0");
  assert.ok(action.indexOf("- name: Refresh the Codex login again after the sign-in") > action.indexOf("- name: Connect the checker"));
});

test("a checker that can't be installed lets the reviewer check, and a reviewer that can't be installed fails", () => {
  for (const [step, provider, flag] of [["Install Codex", "claude", "MERGELIGHT_USES_CODEX"], ["Install Claude Code", "codex", "MERGELIGHT_USES_CLAUDE"]]) {
    const dir = mkdtempSync(join(tmpdir(), "mergelight-install-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "npm"), "#!/usr/bin/env bash\nexit 1\n");
    chmodSync(join(bin, "npm"), 0o755);
    const envFile = join(dir, "env");
    writeFileSync(envFile, "");
    const script = stepScript(step).replace(/\$\{\{[^}]*\}\}/g, "1.0.0");
    const checker = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}`, GITHUB_ENV: envFile, MERGELIGHT_PROVIDER: provider, MERGELIGHT_CONNECT_CHECK: provider === "claude" ? "codex" : "claude" } });
    assert.equal(checker.status, 0, step);
    assert.match(readFileSync(envFile, "utf8"), new RegExp(`${flag}=0\\nMERGELIGHT_CHECKER_NOT_INSTALLED=1\\nMERGELIGHT_CONNECT_CHECK=\\n`), step);
    const reviewer = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}`, GITHUB_ENV: envFile, MERGELIGHT_PROVIDER: provider === "claude" ? "codex" : "claude" } });
    assert.equal(reviewer.status, 1, `${step} for the reviewer`);
  }
});

test("on a public repository no ChatGPT code is shown for a checker, and Claude's link still is", () => {
  const open = choose({ wanted: "claude", claude: "1", checker: "codex", visibility: "public" });
  assert.equal(open.env.MERGELIGHT_CONNECT_CHECK, "");
  assert.match(open.out, /anyone who can see the pull request could enter it/);
  // Only a private repository shows one: an internal one, or one that can't be told, doesn't.
  for (const visibility of ["internal", ""]) assert.equal(choose({ wanted: "claude", claude: "1", checker: "codex", visibility }).env.MERGELIGHT_CONNECT_CHECK, "", visibility);
  assert.equal(open.env.MERGELIGHT_USES_CODEX, "0");
  assert.equal(choose({ wanted: "codex", codex: "1", checker: "claude", visibility: "public" }).env.MERGELIGHT_CONNECT_CHECK, "claude", "Claude's link goes through mergelight.dev, where you sign in");
});

test("a check left running when the run ends is cancelled, so an older approval can't pass it", () => {
  const step = action.slice(action.indexOf("- name: Finish a check left running"), action.indexOf("- name: Save the refreshed Codex login"));
  assert.match(step, /conclusion=cancelled/);
  assert.match(step, /"\$status" != in_progress \] && \[ "\$status" != queued/, "only a check known to be running");
});

test("the last step finishes the connect's check too, when the review couldn't close it", () => {
  const dir = mkdtempSync(join(tmpdir(), "mergelight-finish-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const calls = join(dir, "calls");
  // The review's own check 10 has its verdict; the connect's check 9 still runs.
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash\necho "$*" >> "${calls}"\ncase "$*" in *check-runs/10\\ --jq*) echo completed ;; *check-runs/9\\ --jq*) echo in_progress ;; esac\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const r = spawnSync("bash", ["-c", stepScript("Finish a check left running")], { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}`, GITHUB_REPOSITORY: "acme/widgets", MERGELIGHT_CHECK_RUN: "10 9" } });
  assert.equal(r.status, 0, r.stderr);
  const patched = readFileSync(calls, "utf8").split("\n").filter((l) => l.includes("PATCH"));
  assert.equal(patched.length, 1);
  assert.match(patched[0], /check-runs\/9 .*conclusion=cancelled/);
});

test("a reviewer's ChatGPT login that couldn't be refreshed isn't spent waiting for the checker's sign-in", () => {
  const r = spawnSync("bash", ["-c", stepScript("Connect the checker")], { encoding: "utf8", env: { PATH: process.env.PATH, MERGELIGHT_LOGIN_SHORT: "1", MERGELIGHT_CONNECT_CHECK: "claude", MERGELIGHT_PROVIDER: "codex", GITHUB_ACTION_PATH: "/nowhere" } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /::warning::.*too little time left/);
  // Nor is its used refresh token tried a second time, with no sign-in in between.
  const again = action.slice(action.indexOf("- name: Refresh the Codex login again after the sign-in"));
  assert.match(again.slice(0, again.indexOf("shell:")), /env\.MERGELIGHT_LOGIN_SHORT != '1'/);
});

test("the notice for saving a checker's login names the secret this workflow reads", () => {
  const r = spawnSync("bash", ["-c", stepScript("Choose who reviews and who checks")], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, GITHUB_ENV: join(mkdtempSync(join(tmpdir(), "mergelight-secret-")), "env"), WANTED: "claude", WANTED_CHECKER: "codex", HAS_CLAUDE: "1", HAS_CODEX: "", GITHUB_EVENT_NAME: "pull_request", GITHUB_REPOSITORY: "acme/widgets", GITHUB_ACTOR: "someone", HEAD_REPO: "acme/widgets", VISIBILITY: "public", SECRET_NAME: "TEAM_CHATGPT" },
  });
  assert.match(r.stdout, /gh secret set TEAM_CHATGPT --repo acme\/widgets < \$d\/auth\.json/);
  // The command as printed, run with stand-ins: a login of its own, kept in a file even where Codex would
  // use the keychain, saved, and then deleted. The person's own shell keeps its CODEX_HOME.
  const command = r.stdout.match(/never the one your own Codex uses: (.*)\. This review/)[1];
  const dir = mkdtempSync(join(tmpdir(), "mergelight-notice-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const saved = join(dir, "saved");
  const homes = join(dir, "homes");
  writeFileSync(join(bin, "codex"), `#!/usr/bin/env bash\necho "$CODEX_HOME" > "${homes}"\ngrep -q 'cli_auth_credentials_store = "file"' "$CODEX_HOME/config.toml" && echo '{"tokens":{}}' > "$CODEX_HOME/auth.json"\n`);
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash\necho "$*" > "${saved}.args"\ncat > "${saved}"\n`);
  chmodSync(join(bin, "codex"), 0o755);
  chmodSync(join(bin, "gh"), 0o755);
  const ran = spawnSync("bash", ["-c", `${command}; echo "after=$CODEX_HOME"`], { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}`, CODEX_HOME: "/home/me/.codex" } });
  assert.equal(readFileSync(saved, "utf8"), '{"tokens":{}}\n', "the file the login wrote is what is saved");
  assert.match(readFileSync(`${saved}.args`, "utf8"), /^secret set TEAM_CHATGPT --repo acme\/widgets/);
  const home = readFileSync(homes, "utf8").trim();
  assert.notEqual(home, "/home/me/.codex", "never the person's own Codex login");
  assert.ok(!existsSync(home), "the login's folder is deleted once it is saved");
  assert.match(ran.stdout, /after=\/home\/me\/\.codex/);
});

test("the jobs never get the Mergelight AI app's token, only the workflow's own, which can only read", () => {
  const step = action.slice(action.indexOf("- name: Get the Mergelight AI app token"), action.indexOf("shell:", action.indexOf("- name: Get the Mergelight AI app token")));
  assert.match(step, /inputs\.run != 'jobs'/);
});

test("jobs mode never turns a check green on an approval, nor refreshes the login before the jobs", () => {
  const condition = (name) => action.slice(action.indexOf(`- name: ${name}`), action.indexOf("shell:", action.indexOf(`- name: ${name}`)));
  assert.match(condition("Approve the check"), /inputs\.run != 'jobs'/);
  assert.match(condition("Refresh the Codex login if it's due"), /inputs\.run != 'jobs'/);
});

test("the jobs wait for a ChatGPT login that lasts through them and the review", () => {
  const dir = mkdtempSync(join(tmpdir(), "mergelight-lasts-"));
  const script = stepScript("Check the login lasts through the jobs");
  const run = (hours) => {
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + hours * 3600 })).toString("base64url");
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { access_token: `h.${payload}.s` } }));
    const out = join(dir, `out-${hours}`);
    writeFileSync(out, "");
    const r = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { PATH: process.env.PATH, CODEX_HOME: dir, GITHUB_ACTION_PATH: root, GITHUB_OUTPUT: out } });
    assert.equal(r.status, 0, r.stderr);
    return readFileSync(out, "utf8");
  };
  assert.equal(run(1), "skip=true\n", "runs out within the jobs and the review");
  assert.equal(run(24), "");
  assert.ok(action.includes("steps.lasts.outputs.skip != 'true'"));
});

test("in jobs mode no second AI is set up, and a Claude reviewer with no login skips the jobs without a sign-in", () => {
  const jobs = (o) => {
    const dir = mkdtempSync(join(tmpdir(), "mergelight-choose-jobs-"));
    const envFile = join(dir, "env");
    writeFileSync(envFile, "");
    const r = spawnSync("bash", ["-c", stepScript("Choose who reviews and who checks")], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, GITHUB_ENV: envFile, RUN: "jobs", WANTED: o.wanted ?? "", WANTED_CHECKER: o.checker ?? "", HAS_CLAUDE: o.claude ?? "", HAS_CODEX: o.codex ?? "", GITHUB_EVENT_NAME: "pull_request", GITHUB_REPOSITORY: "acme/widgets", GITHUB_ACTOR: "someone", HEAD_REPO: "acme/widgets", VISIBILITY: "private" },
    });
    return { out: r.stdout, env: Object.fromEntries(readFileSync(envFile, "utf8").trim().split("\n").filter(Boolean).map((l) => l.split("="))) };
  };
  const both = jobs({ wanted: "claude", claude: "1", codex: "1" });
  assert.equal(both.env.MERGELIGHT_VERIFY, "claude");
  assert.equal(both.env.MERGELIGHT_USES_CODEX, "0");
  const none = jobs({ wanted: "claude", codex: "1" });
  assert.equal(none.env.MERGELIGHT_CONNECT_CLAUDE, "0");
  assert.equal(none.env.MERGELIGHT_NO_LOGIN, "1");
  assert.match(none.out, /Skipping the jobs: there's no Claude login yet/);
});
