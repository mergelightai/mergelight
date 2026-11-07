import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { connect, connectBody, connectedAccount, connectedBody, connectFailedBody, githubConnect, installAppBody, parseDeviceLogin, withState } from "../dist/connect.js";
import { isPendingSummary, SUMMARY_MARKER } from "../dist/publish/markdown.js";
import { ownSummary } from "../dist/publish/publish.js";
import { decodeState, encodeState } from "../dist/publish/state.js";

// What Codex 0.166 printed, with a made-up code.
const CODEX = `Welcome to Codex [v0.166.0]
\x1b[2mOpenAI's command-line coding agent\x1b[0m

Follow these steps to sign in with ChatGPT using device code authorization:

1. Open this link in your browser and sign in to your account
   \x1b[36mhttps://auth.openai.com/codex/device\x1b[0m

2. Enter this one-time code (expires in 15 minutes)
   \x1b[1m2ZYY-TEST1\x1b[0m

Continue only if you started this login in Codex. If a website or another person gave you this code, cancel.
`;

test("reads the link and code from Codex's output, colors included", () => {
  assert.deepEqual(parseDeviceLogin(CODEX), { url: "https://auth.openai.com/codex/device", code: "2ZYY-TEST1" });
});

test("needs both the link and the code", () => {
  assert.equal(parseDeviceLogin("2ZYY-TEST1"), null);
  assert.equal(parseDeviceLogin("https://auth.openai.com/codex/device"), null);
});

test("never shows a link that isn't OpenAI's", () => {
  assert.equal(parseDeviceLogin("Open https://evil.example/codex/device\nCode: 2ZYY-TEST1"), null);
  assert.equal(parseDeviceLogin("Open https://auth.openai.com.evil.example/x\nCode: 2ZYY-TEST1"), null);
});

test("a code cut off between two pieces of output isn't posted until it's whole", () => {
  const cut = CODEX.indexOf("TEST1") + 4;
  assert.equal(parseDeviceLogin(CODEX.slice(0, cut)), null);
  assert.equal(parseDeviceLogin(CODEX.slice(0, cut + 1)), null, "the end of the output isn't the end of the code");
  assert.equal(parseDeviceLogin(CODEX.slice(0, cut + 6))?.code, "2ZYY-TEST1");
});

test("a link cut off isn't posted either", () => {
  assert.equal(parseDeviceLogin("Open https://auth.openai.com/codex/dev\n2ZYY-TEST1\n")?.url, "https://auth.openai.com/codex/dev");
  assert.equal(parseDeviceLogin("2ZYY-TEST1\nOpen https://auth.openai.com/codex/dev"), null);
});

function deps(output, exit) {
  const events = [];
  return {
    events,
    stopLogin: () => events.push("stopped"),
    startLogin: async (onOutput) => {
      for (const chunk of output) onOutput(chunk);
      return exit;
    },
    showCode: async (login) => events.push(`show ${login.code}`),
    connected: async () => events.push("connected"),
    failed: async (reason) => events.push(`failed ${reason}`),
  };
}

test("shows the code once, even when the output arrives in pieces, then connects", async () => {
  const half = Math.floor(CODEX.length / 2);
  const d = deps([CODEX.slice(0, half), CODEX.slice(half), "more output with OTHR-CODE1"], 0);
  assert.equal(await connect(d), 0);
  assert.deepEqual(d.events, ["show 2ZYY-TEST1", "connected"]);
});

test("a code that runs out fails with a way forward", async () => {
  const d = deps([CODEX], 1);
  assert.equal(await connect(d), 1);
  assert.equal(d.events[0], "show 2ZYY-TEST1");
  assert.match(d.events[1], /^failed .*ran out/);
});

test("a login that can't start says device login may be off", async () => {
  const d = deps(["error: device code login is disabled"], 1);
  assert.equal(await connect(d), 1);
  assert.equal(d.events.length, 1);
  assert.match(d.events[0], /^failed .*may be off.*chatgpt\.com\/settings\/security/);
});

test("waits for the comment to post before reporting connected", async () => {
  const d = deps([CODEX], 0);
  d.showCode = async (login) => {
    await new Promise((r) => setTimeout(r, 5));
    d.events.push(`show ${login.code}`);
  };
  await connect(d);
  assert.deepEqual(d.events, ["show 2ZYY-TEST1", "connected"]);
});

test("a code that can't be posted ends the login instead of waiting for nobody", async () => {
  const d = deps([CODEX], 1);
  d.showCode = async () => {
    throw new Error("GitHub said no");
  };
  assert.equal(await connect(d), 1);
  assert.equal(d.events[0], "stopped");
  assert.match(d.events[1], /^failed .*couldn't post the login code/);
  assert.equal(d.events.length, 2);
});

test("says whose account got connected, without the whole email", () => {
  const payload = Buffer.from(JSON.stringify({ email: "someone@example.com" })).toString("base64url");
  const auth = JSON.stringify({ tokens: { id_token: `head.${payload}.sig`, access_token: "secret" } });
  assert.equal(connectedAccount(auth), "so***@example.com");
  assert.match(connectedBody("so***@example.com", "CODEX_AUTH_JSON"), /`so\*\*\*@example\.com`.*`CODEX_AUTH_JSON`/);
  assert.doesNotMatch(connectedBody("so***@example.com", "CODEX_AUTH_JSON"), /[–—]/);
});

test("a login that can't be read still says what happened", () => {
  for (const auth of ["", "not json", "{}", '{"tokens":{"id_token":"a.b.c"}}']) assert.equal(connectedAccount(auth), null, auth);
  assert.match(connectedBody(null, "CODEX_AUTH_JSON"), /the account that entered the code|ChatGPT account that entered the code/);
});

test("a login prompt on a reviewed pull request keeps what earlier rounds found", () => {
  const state = { v: 1, round: 3, findings: [{ id: "abc", title: "t", file: "a.ts", line: 1, status: "open" }] };
  const previous = `${SUMMARY_MARKER}\nsome summary\n${encodeState(state)}`;
  const body = withState(connectBody({ url: "https://auth.openai.com/codex/device", code: "2ZYY-TEST1" }), previous);
  assert.ok(body.includes("2ZYY-TEST1"));
  assert.deepEqual(decodeState(body), state);
  assert.equal(withState("plain", undefined), "plain");
  assert.equal(withState("plain", "a comment without state"), "plain");
});

test("a teammate's comment with the marker isn't taken for the summary", async () => {
  const comment = (id, type, login, association) => ({ id, body: `${SUMMARY_MARKER}\nhello`, html_url: "", user: { type, login }, author_association: association });
  const teammate = comment(1, "User", "teammate", "COLLABORATOR");
  const bot = comment(2, "Bot", "mergelight-ai[bot]", "NONE");
  const me = comment(3, "User", "me", "OWNER");
  const nobody = async () => null;
  assert.equal(await ownSummary([teammate, bot], nobody), bot, "the bot's, even when a teammate's came first");
  assert.equal(await ownSummary([teammate], nobody), undefined, "app tokens have no person to match");
  assert.equal(await ownSummary([teammate, me], async () => "me"), me, "a personal login can find its own");
  assert.equal(await ownSummary([teammate], async () => "me"), undefined);
  assert.equal(await ownSummary([{ id: 4, body: "no marker", html_url: "", user: { type: "Bot" } }], nobody), undefined);
});

test("the comment gives the link, the code and where it came from", () => {
  const body = connectBody({ url: "https://auth.openai.com/codex/device", code: "2ZYY-TEST1" }, "https://github.com/a/b/actions/runs/1");
  assert.ok(body.includes("https://auth.openai.com/codex/device"));
  assert.ok(body.includes("`2ZYY-TEST1`"));
  assert.ok(body.includes("https://github.com/a/b/actions/runs/1"));
  assert.ok(body.includes("(https://chatgpt.com/settings/security)"), "links to the setting");
  assert.doesNotMatch(body, /[–—]/, "no dashes in copy");
});

test("the setup page can read the code, which needs these two lines exactly", () => {
  const lines = connectBody({ url: "https://auth.openai.com/codex/device", code: "2ZYY-TEST1" }).split("\n");
  assert.ok(lines.includes("1. Open https://auth.openai.com/codex/device"));
  assert.ok(lines.includes("2. Enter this code: `2ZYY-TEST1`"));
});

test("every comment is the summary, so the review replaces it", () => {
  const login = { url: "https://auth.openai.com/codex/device", code: "2ZYY-TEST1" };
  for (const body of [connectBody(login), installAppBody(), connectFailedBody("x")]) assert.ok(body.startsWith(SUMMARY_MARKER));
  assert.ok(isPendingSummary(connectBody(login)));
  assert.ok(isPendingSummary(installAppBody()));
  assert.ok(!isPendingSummary(connectFailedBody("x")), "a failure stays until the next push");
});

test("the CLI really runs connect, instead of printing its help", () => {
  // A fake gh that fails: reaching it proves the command got past the CLI's own checks.
  const bin = mkdtempSync(join(tmpdir(), "mergelight-fake-gh-"));
  try {
    writeFileSync(join(bin, "gh"), '#!/bin/sh\necho "fake gh was called" >&2\nexit 1\n');
    chmodSync(join(bin, "gh"), 0o755);
    const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
    const r = spawnSync(process.execPath, [cli, "connect", "acme/widgets#1"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stderr, /Usage/, "printed help instead of running");
    assert.match(r.stderr, /fake gh was called/);
    assert.doesNotMatch(r.stderr, /Unhandled|at .*\.js:\d+/, "fails cleanly");
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

function fakeApi(failWhile) {
  const writes = [];
  return {
    writes,
    list: async (path) => (path.startsWith("issues/") ? [{ id: 5, user: { login: "mergelight-ai[bot]", type: "Bot" }, author_association: "NONE", body: `${SUMMARY_MARKER}\nold code` }] : []),
    viewer: async () => null,
    write: async (method, path, body) => {
      if (failWhile(path)) throw new Error("gh api failed: gh: Bad credentials (HTTP 401)");
      writes.push({ method, path, body });
      return { id: 9 };
    },
  };
}

test("a token that dies during the login: the comment still stops offering the dead code", async () => {
  const env = { GH_TOKEN: "app", GITHUB_WORKFLOW_TOKEN: "workflow" };
  const api = fakeApi(() => env.GH_TOKEN === "app");
  const logs = [];
  await githubConnect(api, 7, "abc", (l) => logs.push(l), env).failed("The code ran out.");
  assert.equal(env.GH_TOKEN, "workflow");
  assert.ok(api.writes.some((w) => w.path === "issues/comments/5" && /couldn't connect/.test(w.body.body)));
  assert.ok(logs.includes("The code ran out."));
});

test("a failed comment doesn't stop the check from finishing, and it doesn't throw", async () => {
  const env = { GH_TOKEN: "app" };
  const api = fakeApi((path) => path.startsWith("issues/"));
  const logs = [];
  await githubConnect(api, 7, "abc", (l) => logs.push(l), env).failed("The code ran out.");
  assert.ok(api.writes.some((w) => w.path === "check-runs" && w.body.conclusion === "neutral"));
  assert.ok(logs.some((l) => l.startsWith("Couldn't update the comment")));
});

test("other errors don't switch tokens", async () => {
  const env = { GH_TOKEN: "app", GITHUB_WORKFLOW_TOKEN: "workflow" };
  const api = fakeApi(() => false);
  api.write = async () => { throw new Error("gh api failed: HTTP 422"); };
  await githubConnect(api, 7, "abc", () => {}, env).failed("The code ran out.");
  assert.equal(env.GH_TOKEN, "app");
});

