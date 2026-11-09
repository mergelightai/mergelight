import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
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

