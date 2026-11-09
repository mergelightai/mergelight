import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { claudeEnv, runClaude } from "../dist/providers/claude.js";
import { codexEnv, LoginError, loginFailureMessage, runCodex, SandboxError, sandboxArgs, scrubSecrets } from "../dist/providers/codex.js";

/** Puts a stand-in codex first on the PATH that fails with this message, on a run with this login. */
async function failingCodex(stderr, { stdout = "", chatgpt = "1" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mergelight-fake-codex-"));
  writeFileSync(join(dir, "out"), stdout);
  writeFileSync(join(dir, "err"), stderr);
  writeFileSync(join(dir, "codex"), `#!/usr/bin/env bash\ncat > /dev/null\ncat "${dir}/out"\ncat "${dir}/err" >&2\nexit 1\n`);
  chmodSync(join(dir, "codex"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${path}`;
  process.env.MERGELIGHT_CHATGPT = chatgpt;
  try {
    return await runCodex({ cwd: dir, prompt: "p", schema: {} }).catch((e) => e);
  } finally {
    process.env.PATH = path;
    delete process.env.MERGELIGHT_CHATGPT;
  }
}

test("a login Codex can't use becomes a clear message", async () => {
  for (const said of ["Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.", "unexpected status 401 Unauthorized: token expired"]) {
    const err = await failingCodex(said);
    assert.ok(err instanceof LoginError, said);
    assert.match(err.message, /Re-run the Mergelight job from the Actions tab/);
    assert.match(err.message, /delete the CODEX_AUTH_JSON secret/);
  }
});

test("Codex's own error events count", async () => {
  for (const event of [{ type: "error", message: "unexpected status 401 Unauthorized" }, { type: "turn.failed", error: { message: "unexpected status 401 Unauthorized" } }]) {
    assert.ok((await failingCodex("", { stdout: `${JSON.stringify(event)}\n` })) instanceof LoginError, event.type);
  }
});

test("code that mentions a 401 isn't a login problem", async () => {
  const read = { type: "item.completed", item: { type: "command_execution", exit_code: 0, aggregated_output: 'throw new Error("401 Unauthorized")' } };
  const err = await failingCodex("", { stdout: `${JSON.stringify(read)}\n` });
  assert.ok(!(err instanceof LoginError));
});

test("a refused API key isn't a ChatGPT login problem", async () => {
  const err = await failingCodex("unexpected status 401 Unauthorized: Incorrect API key", { chatgpt: "0" });
  assert.ok(!(err instanceof LoginError));
  assert.match(err.message, /Incorrect API key/);
});

test("other failures keep their own message", async () => {
  const err = await failingCodex("stream disconnected");
  assert.ok(!(err instanceof LoginError));
  assert.ok(!(err instanceof SandboxError));
  assert.match(err.message, /stream disconnected/);
});

test("the message names the secret this repository uses", () => {
  assert.match(loginFailureMessage("MY_LOGIN"), /delete the MY_LOGIN secret/);
});

test("the sandbox can read everything except the login folder", () => {
  const args = sandboxArgs('/tmp/co"dex');
  assert.deepEqual(args.slice(0, 2), ["-c", 'default_permissions="mergelight_review"']);
  assert.equal(args[3], 'permissions.mergelight_review.filesystem={":root"="read","/tmp/co\\"dex"="none"}');
});

test("commands Codex runs don't get the runner's tokens, and keep everything else", () => {
  const env = codexEnv({ GH_TOKEN: "x", GITHUB_TOKEN: "x", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "x", ACTIONS_ID_TOKEN_REQUEST_URL: "x", SECRETS_TOKEN: "x", PATH: "/bin", CODEX_HOME: "/h", MY_PROXY_URL: "u" });
  assert.deepEqual(env, { PATH: "/bin", CODEX_HOME: "/h", MY_PROXY_URL: "u" });
});

test("login tokens are removed from anything about to be posted", () => {
  const home = mkdtempSync(join(tmpdir(), "mergelight-scrub-"));
  const secret = "rt_abcdefghijklmnopqrstuvwxyz";
  writeFileSync(join(home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: null, tokens: { refresh_token: secret, account_id: "short" } }));
  const jwt = "eyJhbGciOiJSUzI1NiIs.eyJzdWIiOiIxMjM0NTY3.abcDEF_123-xyz";
  const out = scrubSecrets(`see ${secret} and ${jwt} and short`, home);
  assert.equal(out, "see [removed] and [removed] and short");
  assert.equal(scrubSecrets(`only ${jwt}`, join(home, "missing")), "only [removed]");
});

test("Codex never gets a Claude login", () => {
  assert.deepEqual(codexEnv({ PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "t", ANTHROPIC_API_KEY: "k", GH_TOKEN: "g" }), { PATH: "/bin" });
});

test("Claude gets its login and no runner tokens, and a plan comes before a paid key", () => {
  assert.deepEqual(claudeEnv({ PATH: "/bin", GH_TOKEN: "g", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "x", CLAUDE_CODE_OAUTH_TOKEN: "t", ANTHROPIC_API_KEY: "k" }), { PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "t" });
  assert.deepEqual(claudeEnv({ PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "", ANTHROPIC_API_KEY: "k" }), { PATH: "/bin", ANTHROPIC_API_KEY: "k" });
  assert.deepEqual(claudeEnv({ PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "", ANTHROPIC_API_KEY: "" }), { PATH: "/bin" });
});

test("Claude logins are removed from anything about to be posted", () => {
  const token = "abcdefghijklmnopqrstuvwxyz0123";
  assert.equal(scrubSecrets(`a ${token} b`, "/nonexistent", { CLAUDE_CODE_OAUTH_TOKEN: token }), "a [removed] b");
  assert.equal(scrubSecrets("x sk-ant-oat01-abcdefghijklmnopqrstuvwxyz y", "/nonexistent", {}), "x [removed] y");
});

/** Puts a stand-in claude first on the PATH that prints this and records its arguments and environment. */
async function fakeClaude(stdout, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mergelight-fake-claude-"));
  writeFileSync(join(dir, "out"), stdout);
  writeFileSync(join(dir, "claude"), `#!/usr/bin/env bash\ncat > /dev/null\nprintf '%s\\n' "$@" > "${dir}/args"\nenv > "${dir}/env"\ncat "${dir}/out"\nexit 1\n`);
  chmodSync(join(dir, "claude"), 0o755);
  const saved = { ...process.env };
  process.env.PATH = `${dir}${delimiter}${saved.PATH}`;
  Object.assign(process.env, extraEnv);
  try {
    const result = await runClaude({ cwd: dir, prompt: "p", schema: {} }).catch((e) => e);
    return { result, args: readFileSync(join(dir, "args"), "utf8").split("\n"), env: readFileSync(join(dir, "env"), "utf8") };
  } finally {
    process.env = saved;
  }
}

const refused = JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Invalid API key. Please run /login" });

test("a Claude login that doesn't work becomes a clear message", async () => {
  const { result } = await fakeClaude(refused, { MERGELIGHT_PROVIDER: "claude" });
  assert.ok(result instanceof LoginError);
  assert.match(result.message, /claude setup-token/);
  assert.match(result.message, /CLAUDE_CODE_OAUTH_TOKEN/);
});

test("a plan that hit its limit says so, not Claude's status word", async () => {
  const { result } = await fakeClaude(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "You've hit your weekly limit" }), { MERGELIGHT_PROVIDER: "claude" });
  assert.match(result.message, /Your Claude plan hit its usage limit/);
  assert.match(result.message, /weekly limit/);
  assert.doesNotMatch(result.message, /\(success\)/);
});

test("Claude runs with file tools only and without the runner's tokens", async () => {
  const { args, env } = await fakeClaude(refused, { GH_TOKEN: "FAKE_GH", CLAUDE_CODE_OAUTH_TOKEN: "FAKE_LOGIN" });
  assert.equal(args[args.indexOf("--tools") + 1], "Read,Grep,Glob");
  assert.ok(args.includes("--restricted") && args.includes("--safe-mode") && args.includes("--strict-mcp-config"));
  assert.ok(!env.includes("FAKE_GH"));
  assert.ok(env.includes("FAKE_LOGIN"));
});

