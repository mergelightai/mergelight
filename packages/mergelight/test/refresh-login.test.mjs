import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { accessTokenExpiry, forceRefresh, isDue, refreshLogin } from "../scripts/refresh-login.mjs";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const jwt = (exp) => `h.${Buffer.from(JSON.stringify({ exp: exp / 1000 })).toString("base64url")}.s`;
const login = (msLeft, refreshToken = "old") => JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: jwt(NOW + msLeft), refresh_token: refreshToken } });

function setup({ event, msLeft, rotates = true, secretsToken = "tok", appToken = null, saveCode = 0, reason = null }) {
  const home = mkdtempSync(join(tmpdir(), "mergelight-refresh-"));
  const file = join(home, "auth.json");
  const envFile = join(home, "env");
  writeFileSync(file, login(msLeft));
  writeFileSync(envFile, "");
  const calls = { refresh: 0, saved: [], logs: [] };
  return {
    calls,
    file,
    envFile,
    run: () =>
      refreshLogin({
        env: { CODEX_HOME: home, GITHUB_EVENT_NAME: event, SECRETS_TOKEN: secretsToken, SECRET_NAME: "CODEX_AUTH_JSON", GITHUB_ENV: envFile },
        now: () => NOW,
        log: (l) => calls.logs.push(l),
        appToken: async () => appToken,
        refresh: async () => {
          calls.refresh++;
          if (rotates) writeFileSync(file, login(240 * HOUR, "new"));
          return reason;
        },
        save: (token) => {
          calls.saved.push(token);
          return saveCode;
        },
      }),
  };
}
const said = (calls, re) => calls.logs.some((l) => re.test(l));

test("reads when the access token expires, and copes with one it can't read", () => {
  assert.equal(accessTokenExpiry(JSON.parse(login(HOUR))), NOW + HOUR);
  for (const bad of [{}, { tokens: {} }, { tokens: { access_token: "nope" } }, { tokens: { access_token: "a.b.c" } }]) assert.equal(accessTokenExpiry(bad), null);
});

test("when a refresh is due", () => {
  const DAY = 24 * HOUR;
  assert.equal(isDue("pull_request", NOW + 59 * 60_000, NOW), true, "under an hour left, so it could run out during the review");
  assert.equal(isDue("pull_request", NOW + 61 * 60_000, NOW), false);
  assert.equal(isDue("pull_request_target", NOW + 59 * 60_000, NOW), true);
  assert.equal(isDue("pull_request", null, NOW), false, "unknown expiry: a review leaves it to Codex");
  for (const event of ["schedule", "workflow_dispatch"]) {
    assert.equal(isDue(event, NOW + 10 * DAY, NOW), true, "the job always refreshes, so it notices a dead login");
    assert.equal(isDue(event, null, NOW), true);
  }
});

test("a login with time left isn't touched", async () => {
  const s = setup({ event: "pull_request", msLeft: 100 * HOUR });
  assert.equal(await s.run(), 0);
  assert.equal(s.calls.refresh, 0);
  assert.deepEqual(s.calls.saved, []);
  assert.ok(said(s.calls, /good for another 4 days/));
});

test("a due login is refreshed and saved before the review starts", async () => {
  const s = setup({ event: "pull_request", msLeft: 30 * 60_000 });
  assert.equal(await s.run(), 0);
  assert.equal(s.calls.refresh, 1);
  assert.deepEqual(s.calls.saved, ["tok"]);
  assert.equal(readFileSync(s.envFile, "utf8"), "");
});

test("the job refreshes a login with plenty of time left", async () => {
  const s = setup({ event: "schedule", msLeft: 9 * 24 * HOUR });
  assert.equal(await s.run(), 0);
  assert.equal(s.calls.refresh, 1);
  assert.equal(s.calls.saved.length, 1);
});

test("the app's token saves it when there's no secrets token", async () => {
  const s = setup({ event: "schedule", msLeft: HOUR, secretsToken: "", appToken: "app" });
  assert.equal(await s.run(), 0);
  assert.deepEqual(s.calls.saved, ["app"]);
});

test("the job fails with nowhere to save, and never refreshes, because that would throw away a working login", async () => {
  for (const event of ["schedule", "workflow_dispatch"]) {
    const s = setup({ event, msLeft: 100 * HOUR, secretsToken: "", appToken: null });
    assert.equal(await s.run(), 1);
    assert.equal(s.calls.refresh, 0);
    assert.ok(said(s.calls, /::error::.*nowhere to save/));
  }
});

test("a review with nowhere to save only warns, because it can still work", async () => {
  const s = setup({ event: "pull_request", msLeft: HOUR / 2, secretsToken: "", appToken: null });
  assert.equal(await s.run(), 0);
  assert.equal(s.calls.refresh, 0);
  assert.ok(said(s.calls, /::warning::.*nowhere to save/));
});

test("a failed save doesn't stop the review, and the end of the run tries again", async () => {
  const s = setup({ event: "pull_request", msLeft: HOUR / 2, saveCode: 1 });
  assert.equal(await s.run(), 0);
  assert.ok(said(s.calls, /tries again when it ends/));
  assert.equal(readFileSync(s.envFile, "utf8"), "");
});

test("a review that loses the race carries on while its token still works", async () => {
  const s = setup({ event: "pull_request", msLeft: 30 * 60_000, rotates: false });
  assert.equal(await s.run(), 0);
  assert.deepEqual(s.calls.saved, []);
  assert.ok(said(s.calls, /carries on.*30 minutes/));
  assert.equal(readFileSync(s.envFile, "utf8"), "", "the review still runs");
});

test("a review that loses the race with no time left doesn't start Codex", async () => {
  for (const msLeft of [19 * 60_000, 4 * 60_000, -HOUR]) {
    const s = setup({ event: "pull_request", msLeft, rotates: false });
    assert.equal(await s.run(), 0, "the review step reports it on the pull request");
    assert.equal(readFileSync(s.envFile, "utf8"), "MERGELIGHT_LOGIN_LOST=1\n");
  }
});

test("the job fails visibly when it can't refresh, and says how to recover", async () => {
  for (const event of ["schedule", "workflow_dispatch"]) {
    const s = setup({ event, msLeft: HOUR, rotates: false });
    assert.equal(await s.run(), 1);
    assert.ok(said(s.calls, /::error::.*delete the CODEX_AUTH_JSON secret/));
  }
});

test("logs never hold a token", async () => {
  const s = setup({ event: "pull_request", msLeft: 30 * 60_000 });
  await s.run();
  const logs = s.calls.logs.join("\n");
  assert.doesNotMatch(logs, /old|new\b|h\.[A-Za-z0-9_-]+\.s/);
});

/** A fake codex app-server speaking its line protocol. */
function fakeServer(answer) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.killed = 0;
  child.kill = () => child.killed++;
  const seen = [];
  let buffer = "";
  child.stdin.on("data", (d) => {
    buffer += d;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const m = JSON.parse(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      seen.push(m);
      answer(m, child);
    }
  });
  return { child, seen };
}

test("what comes back decides whether it worked, not just that a token changed", async () => {
  const outcome = async (content) => {
    const s = setup({ event: "workflow_dispatch", msLeft: HOUR, rotates: false });
    return { s, content };
  };
  for (const [name, content, ok] of [
    ["tokens wiped", JSON.stringify({ auth_mode: "chatgpt" }), false],
    ["cut off mid-write", '{"auth_mode":"chat', false],
    ["same tokens", login(HOUR), false],
    ["new access token, same refresh token", login(240 * HOUR, "old"), true],
  ]) {
    const { s } = await outcome(content);
    const code = await refreshLogin({
      env: { CODEX_HOME: dirname(s.file), GITHUB_EVENT_NAME: "workflow_dispatch", SECRETS_TOKEN: "tok", SECRET_NAME: "CODEX_AUTH_JSON", GITHUB_ENV: s.envFile },
      now: () => NOW,
      log: (l) => s.calls.logs.push(l),
      refresh: async () => {
        writeFileSync(s.file, content);
        return null;
      },
      save: (token) => {
        s.calls.saved.push(token);
        return 0;
      },
    });
    assert.equal(code, ok ? 0 : 1, name);
    assert.deepEqual(s.calls.saved, ok ? ["tok"] : [], `${name}: only a working login is saved`);
  }
});

test("the reason a refresh failed reaches the log", async () => {
  const s = setup({ event: "schedule", msLeft: HOUR, rotates: false, reason: "method not found" });
  assert.equal(await s.run(), 1);
  assert.ok(said(s.calls, /Couldn't refresh the Codex login \(method not found\)/));
});

test("forces the refresh through the app-server: initialize, then account/read", async () => {
  const { child, seen } = fakeServer((m, c) => {
    if (m.id) c.stdout.write(`noise that isn't JSON\n${JSON.stringify({ method: "account/updated" })}\n${JSON.stringify({ id: m.id, result: {} })}\n`);
  });
  await forceRefresh({ spawnImpl: (cmd, args) => (assert.deepEqual([cmd, args], ["codex", ["app-server"]]), child) });
  assert.deepEqual(seen.map((m) => m.method), ["initialize", "initialized", "account/read"]);
  assert.deepEqual(seen[2].params, { refreshToken: true });
  assert.equal(child.killed, 1, "the server doesn't outlive the refresh");
});

test("a server that hangs or never starts doesn't hang the run", async () => {
  const hung = fakeServer(() => {});
  assert.match(await forceRefresh({ spawnImpl: () => hung.child, timeoutMs: 10 }), /didn't answer/);
  assert.equal(hung.child.killed, 1);
  const missing = fakeServer(() => {});
  setImmediate(() => missing.child.emit("error", new Error("ENOENT")));
  assert.equal(await forceRefresh({ spawnImpl: () => missing.child }), "ENOENT");
});

test("an error from the app-server comes back as the reason", async () => {
  const { child } = fakeServer((m, c) => {
    if (m.id === 1) c.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
    if (m.id === 2) c.stdout.write(`${JSON.stringify({ id: 2, error: { code: -32601, message: "method not found" } })}\n`);
  });
  assert.equal(await forceRefresh({ spawnImpl: () => child }), "method not found");
});

test("a saved login it can't use is left alone", async () => {
  for (const content of ["not json", JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "k" })]) {
    const s = setup({ event: "schedule", msLeft: HOUR });
    writeFileSync(s.file, content);
    assert.equal(await s.run(), 0);
    assert.equal(s.calls.refresh, 0);
  }
});
