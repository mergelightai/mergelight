import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { LoginError, loginFailureMessage, runCodex, SandboxError } from "../dist/providers/codex.js";

/** Puts a stand-in codex first on the PATH that fails with this message. */
async function failingCodex(stderr) {
  const dir = mkdtempSync(join(tmpdir(), "mergelight-fake-codex-"));
  writeFileSync(join(dir, "codex"), `#!/usr/bin/env bash\ncat > /dev/null\necho "${stderr}" >&2\nexit 1\n`);
  chmodSync(join(dir, "codex"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${path}`;
  try {
    return await runCodex({ cwd: dir, prompt: "p", schema: {} }).catch((e) => e);
  } finally {
    process.env.PATH = path;
  }
}

test("a login Codex can't use becomes a clear message", async () => {
  for (const said of ["Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.", "unexpected status 401 Unauthorized: token expired"]) {
    const err = await failingCodex(said);
    assert.ok(err instanceof LoginError, said);
    assert.match(err.message, /Re-run this check/);
    assert.match(err.message, /delete the CODEX_AUTH_JSON secret/);
  }
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
