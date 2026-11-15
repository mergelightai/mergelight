import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { accessTokenExpiry, forceRefresh, isDue, refreshLogin } from "../scripts/refresh-login.mjs";
import { maskLogin } from "../scripts/mask-login.mjs";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const jwt = (exp) => `h.${Buffer.from(JSON.stringify({ exp: exp / 1000 })).toString("base64url")}.s`;
const login = (msLeft, refreshToken = "old") => JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: jwt(NOW + msLeft), refresh_token: refreshToken } });

function setup({ event, msLeft, rotates = true, secretsToken = "tok", appToken = null, saveCode = 0, reason = null, held = "yes", environment = "", outage = false }) {
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
        env: { CODEX_HOME: home, GITHUB_EVENT_NAME: event, SECRETS_TOKEN: secretsToken, SECRET_NAME: "CODEX_AUTH_JSON", GITHUB_ENV: envFile, GITHUB_REPOSITORY: "acme/api" },
        now: () => NOW,
        log: (l) => calls.logs.push(l),
        appToken: async () => appToken,
        held: async (token) => {
          calls.heldToken = token;
          return held;
        },
        environment: async () => (outage ? undefined : environment),
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
  // Under 2.5 hours left: it could run out during the review, and it is the window in which the jobs
  // wait for the review to refresh it.
  assert.equal(isDue("pull_request", NOW + 149 * 60_000, NOW), true, "could run out during the jobs and the review");
  assert.equal(isDue("pull_request", NOW + 151 * 60_000, NOW), false);
  assert.equal(isDue("pull_request_target", NOW + 149 * 60_000, NOW), true);
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
  // A refresh that worked clears a failed one from earlier in the run, and the saved login is this run's own.
  assert.equal(readFileSync(s.envFile, "utf8"), `MERGELIGHT_LOGIN_LOST=0\nMERGELIGHT_LOGIN_SHORT=0\nMERGELIGHT_LOGIN_SAVED_AT=${Math.floor(NOW / 1000)}\n`);
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
  assert.equal(readFileSync(s.envFile, "utf8"), "MERGELIGHT_LOGIN_LOST=0\nMERGELIGHT_LOGIN_SHORT=0\n");
});

test("a review that loses the race carries on while its token still works", async () => {
  const s = setup({ event: "pull_request", msLeft: 30 * 60_000, rotates: false });
  assert.equal(await s.run(), 0);
  assert.deepEqual(s.calls.saved, []);
  assert.ok(said(s.calls, /carries on.*30 minutes/));
  // The review still runs, and nothing else may wait on what's left, as the checker's sign-in would.
  assert.equal(readFileSync(s.envFile, "utf8"), "MERGELIGHT_LOGIN_SHORT=1\n");
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
  // A hide command holds the token for the runner, which swallows the value.
  const logs = s.calls.logs.filter((l) => !l.startsWith("::add-mask::")).join("\n");
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
      held: async () => "yes",
      environment: async () => "",
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

function masked(contents) {
  const home = mkdtempSync(join(tmpdir(), "mergelight-mask-"));
  if (contents !== undefined) writeFileSync(join(home, "auth.json"), contents);
  const logs = [];
  maskLogin({ env: { CODEX_HOME: home }, log: (l) => logs.push(l) });
  return logs;
}

test("hides each token in the login, and nothing else", () => {
  const logs = masked(JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "aaa", refresh_token: "rrr", id_token: "iii", account_id: "acct" } }));
  assert.deepEqual(logs, ["::add-mask::aaa", "::add-mask::rrr", "::add-mask::iii"]);
});

test("an API key login, a broken file or a missing file hides nothing and doesn't fail", () => {
  assert.deepEqual(masked(JSON.stringify({ OPENAI_API_KEY: "k", tokens: null })), []);
  assert.deepEqual(masked("not json"), []);
  assert.deepEqual(masked(undefined), []);
});

test("a token with a line break can't start another workflow command", () => {
  assert.deepEqual(masked(JSON.stringify({ tokens: { access_token: "x\n::set-output name=a::b" } })), []);
});

test("a refreshed login's new tokens are hidden before anything else is logged", async () => {
  const s = setup({ event: "schedule", msLeft: HOUR });
  assert.equal(await s.run(), 0);
  const refreshed = s.calls.logs.indexOf("Refreshed the Codex login.");
  const hidden = s.calls.logs.findIndex((l) => l === "::add-mask::new");
  assert.ok(hidden >= 0 && hidden < refreshed, s.calls.logs.join("\n"));
});


test("a login this repository doesn't hold itself, such as an organization's, is never refreshed", async () => {
  // Once it is due, no review uses it, even with time left: Codex would refresh it by itself in its last
  // minutes, which a long review can reach. Nor does a sign-in wait on it. The review says why.
  for (const msLeft of [2 * HOUR, 10 * 60_000]) {
    const s = setup({ event: "pull_request", msLeft, held: "no" });
    assert.equal(await s.run(), 0);
    assert.equal(s.calls.refresh, 0);
    assert.deepEqual(s.calls.saved, []);
    assert.equal(s.calls.heldToken, "tok", "asked with the token that would save it");
    assert.ok(said(s.calls, /::error::.*doesn't hold itself.*gh secret set CODEX_AUTH_JSON --repo acme\/api/));
    assert.match(readFileSync(s.envFile, "utf8"), /^MERGELIGHT_LOGIN_SHORT=1\nMERGELIGHT_LOGIN_LOST=1\nMERGELIGHT_LOGIN_NOTE=This repository reads its ChatGPT login from a CODEX_AUTH_JSON secret it doesn't hold itself.*then push: `d=.*rm -rf "\$d"`\n$/);
  }
  // Not yet due, it isn't even asked about: nothing refreshes it in a review then.
  const fresh = setup({ event: "pull_request", msLeft: 9 * 24 * HOUR, held: "no" });
  assert.equal(await fresh.run(), 0);
  assert.equal(fresh.calls.heldToken, undefined);
  // The job fails where it can be seen.
  const job = setup({ event: "schedule", msLeft: 9 * 24 * HOUR, held: "no" });
  assert.equal(await job.run(), 1);
  assert.equal(job.calls.refresh, 0);
  assert.ok(said(job.calls, /::error::.*doesn't hold itself/));
});

test("a job in a GitHub environment, or one that can't be told, never refreshes the login", async () => {
  // The environment's secret of the same name would win, and the token that saves can't read it.
  const env = setup({ event: "pull_request", msLeft: 2 * HOUR, environment: "prod" });
  assert.equal(await env.run(), 0);
  assert.equal(env.calls.refresh, 0);
  assert.equal(env.calls.heldToken, undefined, "the repository's secret doesn't settle it");
  assert.match(readFileSync(env.envFile, "utf8"), /^MERGELIGHT_LOGIN_SHORT=1\nMERGELIGHT_LOGIN_LOST=1\nMERGELIGHT_LOGIN_NOTE=This job runs in the GitHub environment "prod".*Remove environment: from the Mergelight job/);
  // Without GitHub's pass for the run, it can't be told.
  const blind = setup({ event: "pull_request", msLeft: 2 * HOUR, environment: null });
  assert.equal(await blind.run(), 0);
  assert.equal(blind.calls.refresh, 0);
  assert.match(readFileSync(blind.envFile, "utf8"), /MERGELIGHT_LOGIN_LOST=1\nMERGELIGHT_LOGIN_NOTE=.*Add "id-token: write" to the job's permissions/);
  // GitHub not giving a pass this time is no missing permission: run again.
  const outage = setup({ event: "pull_request", msLeft: 2 * HOUR, outage: true });
  assert.equal(await outage.run(), 0);
  assert.match(readFileSync(outage.envFile, "utf8"), /MERGELIGHT_LOGIN_NOTE=GitHub couldn't say.*run the Mergelight job again/);
  const job = setup({ event: "schedule", msLeft: 9 * 24 * HOUR, environment: null });
  assert.equal(await job.run(), 1);
});

test("a login not known to be the repository's own, as last saved, isn't refreshed", async () => {
  // A review doesn't use it either, even with time left: Codex would refresh it by itself in its last
  // minutes, which a long job can reach. It says to run again, and what happened.
  for (const [held, says] of [["unknown", /GitHub couldn't say.*Nothing is wrong with the login: run the Mergelight job again\./], ["newer", /saved again after this run got it.*Run the Mergelight job again, or push a new commit/]]) {
    for (const msLeft of [2 * HOUR, 30 * 60_000]) {
      const s = setup({ event: "pull_request", msLeft, held });
      assert.equal(await s.run(), 0);
      assert.equal(s.calls.refresh, 0, held);
      assert.deepEqual(s.calls.saved, []);
      const flags = readFileSync(s.envFile, "utf8");
      assert.match(flags, /^MERGELIGHT_LOGIN_SHORT=1\nMERGELIGHT_LOGIN_LOST=1\nMERGELIGHT_LOGIN_NOTE=/, held);
      assert.match(flags, says, held);
    }
  }
  // The job: a lookup GitHub didn't answer fails, to be run again; a newer login saved meanwhile leaves it nothing to do.
  const unsure = setup({ event: "schedule", msLeft: 9 * 24 * HOUR, held: "unknown" });
  assert.equal(await unsure.run(), 1);
  assert.equal(unsure.calls.refresh, 0);
  assert.ok(said(unsure.calls, /::error::GitHub couldn't say/));
  const newer = setup({ event: "schedule", msLeft: 9 * 24 * HOUR, held: "newer" });
  assert.equal(await newer.run(), 0);
  assert.equal(newer.calls.refresh, 0);
});

test("a login this run saved is its own again", async () => {
  const s = setup({ event: "pull_request", msLeft: 30 * 60_000 });
  assert.equal(await s.run(), 0);
  assert.match(readFileSync(s.envFile, "utf8"), new RegExp(`MERGELIGHT_LOGIN_SAVED_AT=${Math.floor(NOW / 1000)}\\n$`));
});

test("whether the repository holds the secret is asked of GitHub, and only a plain answer counts", async () => {
  const { secretHeld } = await import("../scripts/refresh-login.mjs");
  const asked = [];
  const answer = (status) => async (url, init) => (asked.push([url, init.headers.authorization]), { status });
  const env = { GITHUB_REPOSITORY: "acme/api", SECRET_NAME: "TEAM_CHATGPT" };
  assert.equal(await secretHeld({ env, token: "t", fetchImpl: answer(200) }), "yes");
  // Saved again after this run read it: what this run has may not be what the repository holds.
  const saved = (updated_at) => async () => ({ status: 200, json: async () => ({ updated_at }) });
  const read = { ...env, MERGELIGHT_LOGIN_READ_AT: String(Date.parse("2026-11-15T10:00:00Z") / 1000) };
  assert.equal(await secretHeld({ env: read, token: "t", fetchImpl: saved("2026-11-15T09:59:00Z") }), "yes");
  assert.equal(await secretHeld({ env: read, token: "t", fetchImpl: saved("2026-11-15T10:01:00Z") }), "newer");
  assert.equal(await secretHeld({ env: read, token: "t", fetchImpl: saved(undefined) }), "unknown");
  // A pull request's event comes before the run and its secrets: a secret saved after the event, even
  // before the login step's time, may be newer than what this run got.
  const dir = mkdtempSync(join(tmpdir(), "mergelight-event-"));
  const eventFile = join(dir, "event.json");
  writeFileSync(eventFile, JSON.stringify({ pull_request: { updated_at: "2026-11-15T09:30:00Z" } }));
  const queued = { ...read, GITHUB_EVENT_PATH: eventFile };
  assert.equal(await secretHeld({ env: queued, token: "t", fetchImpl: saved("2026-11-15T09:45:00Z") }), "newer");
  assert.equal(await secretHeld({ env: queued, token: "t", fetchImpl: saved("2026-11-15T09:00:00Z") }), "yes");
  // A run started again keeps the first attempt's event, but gets the secret as it is when it starts again.
  assert.equal(await secretHeld({ env: { ...queued, GITHUB_RUN_ATTEMPT: "2" }, token: "t", fetchImpl: saved("2026-11-15T09:45:00Z") }), "yes");
  assert.equal(await secretHeld({ env: { ...queued, GITHUB_RUN_ATTEMPT: "2" }, token: "t", fetchImpl: saved("2026-11-15T10:01:00Z") }), "newer");
  // A login this run saved itself counts from then.
  const own = { ...queued, MERGELIGHT_LOGIN_SAVED_AT: String(Date.parse("2026-11-15T10:05:00Z") / 1000) };
  assert.equal(await secretHeld({ env: own, token: "t", fetchImpl: saved("2026-11-15T10:04:00Z") }), "yes");
  assert.equal(await secretHeld({ env, token: "t", fetchImpl: answer(404) }), "no");
  assert.equal(await secretHeld({ env, token: "t", fetchImpl: answer(403) }), "unknown");
  assert.equal(await secretHeld({ env, token: "t", fetchImpl: async () => { throw new Error("offline"); } }), "unknown");
  assert.deepEqual(asked[0], ["https://api.github.com/repos/acme/api/actions/secrets/TEAM_CHATGPT", "Bearer t"]);
});

test("the job's GitHub environment is read from GitHub's signed pass for the run", async () => {
  const { jobEnvironment } = await import("../scripts/refresh-login.mjs");
  const pass = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
  const env = { ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/token?x=1", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "r" };
  const gives = (claims, status = 200) => async () => ({ status, json: async () => ({ value: pass(claims) }) });
  assert.equal(await jobEnvironment({ env, fetchImpl: gives({ environment: "prod" }) }), "prod");
  assert.equal(await jobEnvironment({ env, fetchImpl: gives({ repository: "acme/api" }) }), "", "a job in no environment");
  assert.equal(await jobEnvironment({ env: {}, fetchImpl: gives({}) }), null, "no id-token: write");
  assert.equal(await jobEnvironment({ env, fetchImpl: gives({}, 500) }), undefined, "GitHub didn't give one this time");
  assert.equal(await jobEnvironment({ env, fetchImpl: async () => { throw new Error("offline"); } }), undefined);
});
