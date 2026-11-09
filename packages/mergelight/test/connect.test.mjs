import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { connect, connectBody, connectedAccount, connectedBody, connectFailedBody, githubConnect, installAppBody, parseDeviceLogin, withState } from "../dist/connect.js";
import { parseClaudeLink, parseClaudeToken, readPastedCode, shareClaudeToken, startClaudeSignIn, waitForPastedCode } from "../dist/connect-claude.js";
import { isPendingSummary, PENDING_MARKER, SUMMARY_MARKER } from "../dist/publish/markdown.js";
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

test("the setup page can read the code from the hidden line", () => {
  const body = connectBody({ url: "https://auth.openai.com/codex/device", code: "2ZYY-TEST1" });
  assert.ok(body.includes(PENDING_MARKER));
  assert.deepEqual(JSON.parse(body.match(/^<!-- mergelight:connect:v1 (\{.*\}) -->$/m)[1]), { url: "https://auth.openai.com/codex/device", code: "2ZYY-TEST1", claudeUrl: null });
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

const LINK = "https://claude.com/cai/oauth/authorize?code=true&code_challenge=abc&state=s";
const SCREEN = `\x1b[2JBrowser didn't open? Use the url below to sign in\n\x1b[36m${LINK}\x1b[0m\r\nPaste code here if prompted >`;
const TOKEN = "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789";

test("only a whole link on Claude's own site counts", () => {
  assert.equal(parseClaudeLink(SCREEN), LINK);
  assert.equal(parseClaudeLink(LINK), null, "it could still be arriving");
  assert.equal(parseClaudeLink("https://claude.com.evil.example/cai/oauth/authorize?code_challenge=a \n"), null);
  assert.equal(parseClaudeLink("https://claude.com/other?x=1 \n"), null);
});

test("finds the token in the terminal's output", () => {
  assert.equal(parseClaudeToken(`\x1b[32m${TOKEN}\x1b[0m\r\n`), TOKEN);
  assert.equal(parseClaudeToken("no token here\n"), null);
});

test("a code counts only as the whole comment", () => {
  assert.equal(readPastedCode("<!-- mergelight:claude-code -->\nabcdef123456#state789"), "abcdef123456#state789");
  assert.equal(readPastedCode("/claude-code abcdef123456#state789"), "abcdef123456#state789");
  assert.equal(readPastedCode("please run /claude-code abcdef123456"), null);
  assert.equal(readPastedCode("/claude-code a b"), null);
  assert.equal(readPastedCode("/claude-code short"), null);
});

function codeWait(comments, writers = ["owner"]) {
  const removed = [];
  let t = 1000;
  return {
    removed,
    run: () => waitForPastedCode(1000, { list: async () => comments, canWrite: async (l) => writers.includes(l), remove: async (id) => removed.push(id), sleep: async () => { t += 10_000; }, now: () => t }, 30_000, 5_000),
  };
}
const pasted = (id, login, at, body = "/claude-code abcdef123456") => ({ id, user: { login }, created_at: new Date(at).toISOString(), body });

test("only a code from someone with write access counts, and it's removed once read", async () => {
  const w = codeWait([pasted(1, "stranger", 2000, "/claude-code evilcode12345"), pasted(2, "owner", 3000)]);
  assert.equal(await w.run(), "abcdef123456");
  assert.deepEqual(w.removed, [2]);
});

test("a code from before this run, or from nobody allowed, never counts", async () => {
  assert.equal(await codeWait([pasted(1, "owner", 500)]).run(), null);
  assert.equal(await codeWait([pasted(1, "stranger", 2000)]).run(), null);
});

test("the token is hidden first, then shared with the later steps", () => {
  const dir = mkdtempSync(join(tmpdir(), "mergelight-share-"));
  const file = join(dir, "env");
  writeFileSync(file, "");
  const printed = [];
  shareClaudeToken(TOKEN, { GITHUB_ENV: file }, (l) => printed.push(l));
  assert.deepEqual(printed, [`::add-mask::${TOKEN}`]);
  assert.match(readFileSync(file, "utf8"), new RegExp(`MERGELIGHT_CLAUDE_TOKEN=${TOKEN}\\nMERGELIGHT_PROVIDER=claude\\nMERGELIGHT_CONNECT=0\\n`));
  assert.throws(() => shareClaudeToken("x\nEVIL=1", { GITHUB_ENV: file }, () => {}));
});

function fakeTerminal(onWrite) {
  const out = new EventEmitter();
  out.setEncoding = () => {};
  const child = new EventEmitter();
  child.stdout = out;
  child.stderr = null;
  child.killed = false;
  child.kill = () => { child.killed = true; };
  child.stdin = { write: (text) => onWrite?.(text, out), on: () => {} };
  return child;
}

test("the sign-in gives its link, sends the code, and ends with the token", async () => {
  const written = [];
  let spawned;
  const child = fakeTerminal((text, out) => {
    written.push(text);
    if (text === "\r") out.emit("data", `Your token:\r\n${TOKEN}\r\n`);
  });
  const signIn = startClaudeSignIn((cmd, args) => { spawned = [cmd, ...args]; setImmediate(() => child.stdout.emit("data", SCREEN)); return child; }, { link: 1000, token: 2000 });
  const s = await signIn;
  assert.equal(s.url, LINK);
  assert.equal(spawned[0], "script");
  assert.match(spawned[2], /claude setup-token/);
  assert.equal(await s.finish("abcdef123456"), TOKEN);
  assert.deepEqual(written, ["abcdef123456", "\r"]);
  assert.ok(child.killed, "nothing is left running");
});

test("no link in time means Claude just isn't offered", async () => {
  const child = fakeTerminal();
  assert.equal(await startClaudeSignIn(() => child, { link: 10, token: 10 }), null);
  assert.ok(child.killed);
});

function raced({ codexExit, claudeOk, codexOutput = [CODEX] }) {
  const d = deps(codexOutput, codexExit);
  d.showCode = async (login, claudeUrl) => d.events.push(`show ${login?.code ?? "none"} ${claudeUrl ?? "-"}`);
  d.connected = async (via) => d.events.push(`connected ${via}`);
  d.startClaude = async () => ({ url: "CL", wait: async () => claudeOk, stop: () => d.events.push("claude stopped") });
  return d;
}

test("Claude connecting first ends the ChatGPT login", async () => {
  const d = raced({ codexExit: 1, claudeOk: true });
  d.startLogin = async (onOutput) => { onOutput(CODEX); return new Promise((r) => setTimeout(() => r(1), 50)); };
  assert.equal(await connect(d), 0);
  assert.deepEqual(d.events, ["show 2ZYY-TEST1 CL", "stopped", "connected claude"]);
});

test("ChatGPT connecting first ends the Claude sign-in", async () => {
  const d = raced({ codexExit: 0, claudeOk: false });
  d.startClaude = async () => ({ url: "CL", wait: () => new Promise(() => {}), stop: () => d.events.push("claude stopped") });
  assert.equal(await connect(d), 0);
  assert.deepEqual(d.events, ["show 2ZYY-TEST1 CL", "claude stopped", "connected chatgpt"]);
});

test("with ChatGPT's device sign-in off, Claude's link still reaches the pull request", async () => {
  const d = raced({ codexExit: 1, claudeOk: true, codexOutput: [] });
  d.startClaude = async () => ({ url: "CL", wait: () => new Promise((r) => setTimeout(() => r(true), 30)), stop: () => {} });
  assert.equal(await connect(d), 0);
  assert.deepEqual(d.events, ["show none CL", "stopped", "connected claude"]);
});

test("when both fail, it says so", async () => {
  const d = raced({ codexExit: 1, claudeOk: false });
  assert.equal(await connect(d), 1);
  assert.match(d.events.at(-1), /^failed .*ChatGPT code and the Claude link both ran out/);
});

test("the failure comment names ChatGPT only when ChatGPT was the only offer", () => {
  assert.match(connectFailedBody("r"), /couldn't connect to ChatGPT/);
  const both = connectFailedBody("r", true);
  assert.match(both, /couldn't connect your AI/);
  assert.doesNotMatch(both, /to ChatGPT/);
  assert.match(both, /new link and code/);
});

test("the comment shows buttons, not long links, and keeps the data for the setup page hidden", () => {
  const device = { url: "https://auth.openai.com/d", code: "AAAA-BBBB" };
  const both = connectBody(device, "https://github.com/run", LINK);
  assert.match(both, /Connect your AI to start reviews/);
  assert.match(both, /<img src="https:\/\/mergelight\.dev\/comment\/open-chatgpt\.svg"/);
  assert.match(both, /<img src="https:\/\/mergelight\.dev\/comment\/open-claude\.svg"/);
  assert.match(both, /`AAAA-BBBB`/);
  const visible = both.replace(/<a href="[^"]*">/g, "").replace(/<!--.*?-->/g, "");
  assert.ok(!visible.includes("oauth/authorize"), "no long link on show");
  const data = JSON.parse(both.match(/^<!-- mergelight:connect:v1 (\{.*\}) -->$/m)[1]);
  assert.deepEqual(data, { url: device.url, code: device.code, claudeUrl: LINK });
  const chatgptOnly = connectBody(device);
  assert.match(chatgptOnly, /Connect ChatGPT to start reviews/);
  assert.doesNotMatch(chatgptOnly.replace(/<!--.*?-->/g, ""), /Claude/);
  assert.match(connectBody(null, undefined, LINK), /Connect your AI/);
});

test("a value can't end the hidden line early", () => {
  const line = connectBody(null, undefined, "https://claude.com/a-->b").split("\n").find((l) => l.startsWith("<!-- mergelight:connect:v1"));
  assert.equal(line.match(/-->/g).length, 1, "only the end of the line closes it");
});
