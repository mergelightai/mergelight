import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chatgptInputMissing, checkWaitingTitle, CLAUDE_INPUT_MISSING, claudeInWorkflow, claudeSetupLink, connect, connectBody, connectCheckBody, connectedAccount, connectedBody, connectFailedBody, githubConnect, installAppBody, parseDeviceLogin, withState } from "../dist/connect.js";
import { claudeCodeRef, parseClaudeLink, parseClaudeToken, readCodeRef, readPastedCode, scriptArgs, shareClaudeToken, startClaudeSignIn, waitForPastedCode } from "../dist/connect-claude.js";
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

const CODE = `abcdef123456#${"s".repeat(43)}`;

test("only a whole code counts", () => {
  assert.equal(readPastedCode(CODE), CODE);
  assert.equal(readPastedCode(`  ${CODE}\n`), CODE);
  assert.equal(readPastedCode(`here it is ${CODE}`), null);
  assert.equal(readPastedCode("abcdef123456"), null, "Claude refuses a code with no state");
  assert.equal(readPastedCode("fixes issue#12"), null);
  assert.equal(readPastedCode("see-the-branch#short"), null);
});

function codeWait(values) {
  let t = 1000;
  let i = 0;
  return waitForPastedCode({
    read: async () => {
      const v = values[Math.min(i++, values.length - 1)];
      if (v instanceof Error) throw v;
      return v;
    },
    sleep: async () => { t += 10_000; },
    now: () => t,
  }, 30_000, 5_000);
}

test("waits until the setup page has left a whole code, past any failed read", async () => {
  assert.equal(await codeWait([null, new Error("GitHub hiccup"), CODE]), CODE);
});

test("anything that isn't a whole code never counts, and the wait ends", async () => {
  assert.equal(await codeWait(["not a code"]), null);
  assert.equal(await codeWait([null]), null);
});

test("the hidden reference comes from this sign-in's own state", () => {
  const state = "a".repeat(43);
  assert.equal(claudeCodeRef(`https://claude.com/x?code=true&state=${state}`), `mergelight/claude-code/s${state}`);
  assert.equal(claudeCodeRef("https://claude.com/x?code=true"), null);
  assert.equal(claudeCodeRef("https://claude.com/x?state=short"), null);
  assert.equal(claudeCodeRef("https://claude.com/x?state=../../heads/main/aaaaaaaaaaaaaaa"), null, "can't point anywhere else");
  assert.equal(claudeCodeRef("not a link"), null);
});

const gitRefs = (found, blobs = {}) => async (path) => {
  if (path.startsWith("git/matching-refs/")) return found;
  return { content: Buffer.from(blobs[path.replace("git/blobs/", "")] ?? "").toString("base64") };
};

test("reads the code only from a blob at exactly that reference", async () => {
  const ref = "mergelight/claude-code/sabc";
  assert.equal(await readCodeRef(gitRefs([{ ref: `refs/${ref}`, object: { sha: "b1", type: "blob" } }], { b1: CODE }), ref), CODE);
  assert.equal(await readCodeRef(gitRefs([]), ref), null, "not there yet");
  assert.equal(await readCodeRef(gitRefs([{ ref: `refs/${ref}-longer`, object: { sha: "b1", type: "blob" } }], { b1: CODE }), ref), null, "matching is by prefix, so the name is checked");
  assert.equal(await readCodeRef(gitRefs([{ ref: `refs/${ref}`, object: { sha: "c1", type: "commit" } }]), ref), null);
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
  assert.match(spawned.join(" "), /claude setup-token/);
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

test("the comment sends Claude to the setup page, and shows no code to paste", () => {
  const device = { url: "https://auth.openai.com/d", code: "AAAA-BBBB" };
  const setup = claudeSetupLink("acme/api", 7);
  assert.equal(setup, "https://mergelight.dev/setup/?repo=acme/api&pr=7&connect=claude");
  const both = connectBody(device, "https://github.com/run", LINK, setup);
  assert.match(both, /Connect your AI to start reviews/);
  assert.match(both, /^- \*\*ChatGPT:\*\* \[Open ChatGPT\]\(https:\/\/auth\.openai\.com\/d\) and enter `AAAA-BBBB`$/m);
  assert.ok(both.includes(`- **Claude:** [Connect on mergelight.dev](${setup})`));
  assert.doesNotMatch(both, /<img|<table|^\|/m);
  assert.doesNotMatch(both, /\/claude-code|as a comment|paste/i);
  const visible = both.replace(/\]\([^)]*\)/g, "]").replace(/<!--.*?-->/g, "");
  assert.ok(!visible.includes("oauth/authorize"), "no long link on show");
  const data = JSON.parse(both.match(/^<!-- mergelight:connect:v1 (\{.*\}) -->$/m)[1]);
  assert.deepEqual(data, { url: device.url, code: device.code, claudeUrl: LINK });
  const chatgptOnly = connectBody(device);
  assert.match(chatgptOnly, /Connect ChatGPT to start reviews/);
  assert.match(chatgptOnly, /^\[Open ChatGPT\]/m);
  assert.doesNotMatch(chatgptOnly.replace(/<!--.*?-->/g, ""), /Claude/);
  const claudeOnly = connectBody(null, undefined, LINK, setup);
  assert.match(claudeOnly, /Connect Claude to start reviews/);
  assert.doesNotMatch(claudeOnly.replace(/<!--.*?-->/g, ""), /ChatGPT|OpenAI/);
});

test("a value can't end the hidden line early", () => {
  const line = connectBody(null, undefined, "https://claude.com/a-->b").split("\n").find((l) => l.startsWith("<!-- mergelight:connect:v1"));
  assert.equal(line.match(/-->/g).length, 1, "only the end of the line closes it");
});

test("connecting the AI that checks says so, names who reviews, and that the review won't wait for ever", () => {
  const device = { url: "https://auth.openai.com/d", code: "AAAA-BBBB" };
  const chatgpt = connectCheckBody("codex", "claude", device, "https://github.com/run", undefined, claudeSetupLink("acme/api", 7));
  assert.match(chatgpt, /^### 🔌 Connect ChatGPT to check this review$/m);
  assert.match(chatgpt, /^\[Open ChatGPT\]\(https:\/\/auth\.openai\.com\/d\) and enter `AAAA-BBBB`\. Claude's review then starts by itself, and Codex checks its findings\.$/m);
  assert.match(chatgpt, /If nobody connects it within 15 minutes, the review starts anyway, checked by Claude\./);
  assert.match(chatgpt, /Checks use the plan of whoever connects it/);
  assert.ok(isPendingSummary(chatgpt), "the review replaces it");
  assert.match(chatgpt, /"for":"check"/, "the setup page can tell a checker's login from a reviewer's");
  assert.doesNotMatch(chatgpt, /Connect on mergelight\.dev/, "Claude already reviews, so only ChatGPT is offered");
  const claude = connectCheckBody("claude", "codex", null, undefined, LINK, claudeSetupLink("acme/api", 7));
  assert.match(claude, /^### 🔌 Connect Claude to check this review$/m);
  assert.match(claude, /\[Connect on mergelight\.dev\]\(https:\/\/mergelight\.dev\/setup\/\?repo=acme\/api&pr=7&connect=claude\)\. Codex's review then starts by itself, and Claude checks its findings\./);
  assert.doesNotMatch(claude, /ChatGPT security settings/);
  assert.equal(checkWaitingTitle("codex"), "Waiting for you to connect ChatGPT to check the review");
});

test("connecting a checker that nobody finishes holds nothing up, and leaves the reviewer as it is", async () => {
  const env = { GH_TOKEN: "app" };
  const api = fakeApi(() => false);
  const logs = [];
  const deps = githubConnect(api, 7, "abc", (l) => logs.push(l), env, { purpose: "check", ai: "codex", reviewer: "claude" });
  assert.equal(await deps.startClaude(), null, "only ChatGPT is offered");
  // No prompt posted: the last review's summary stays as it is.
  await deps.failed("The code ran out.");
  assert.ok(!api.writes.some((w) => w.path.startsWith("issues/")));
  // A prompt posted: its dead code gives way to the review that is starting.
  const shown = githubConnect(api, 7, "abc", () => {}, env, { purpose: "check", ai: "codex", reviewer: "claude" });
  await shown.showCode({ url: "https://auth.openai.com/d", code: "AAAA-BBBB" });
  await shown.failed("The code ran out.");
  const prompt = api.writes.filter((w) => w.path === "issues/comments/5").at(-1);
  assert.ok(prompt && isPendingSummary(prompt.body.body), "the dead code gives way to the review that is starting");
  assert.doesNotMatch(prompt.body.body, /couldn't connect/);
  // The review goes on, so its check does too: updated, not finished.
  const check = api.writes.find((w) => w.path.startsWith("check-runs/") && w.body.output?.title === "ChatGPT wasn't connected");
  assert.equal(check.body.status, "in_progress");
  assert.equal(check.body.output.title, "ChatGPT wasn't connected");
  assert.match(check.body.output.summary, /The review goes on, checked by Claude\./);
  // Connecting Claude to check offers no ChatGPT code, and says why when it ends.
  const claudeOnly = githubConnect(api, 7, "abc", () => {}, env, { purpose: "check", ai: "claude", reviewer: "codex" });
  assert.equal(claudeOnly.only, "claude");
  assert.equal(await claudeOnly.startLogin(() => {}), 1);
  const d = raced({ codexExit: 1, claudeOk: false, codexOutput: [] });
  d.only = "claude";
  assert.equal(await connect(d), 1);
  assert.match(d.events.at(-1), /^failed The Claude link ran out before anyone finished signing in\.$/);
});

test("a Claude login connected to check leaves the reviewer as it is", () => {
  const dir = mkdtempSync(join(tmpdir(), "mergelight-share-check-"));
  const file = join(dir, "env");
  writeFileSync(file, "");
  shareClaudeToken(TOKEN, { GITHUB_ENV: file }, () => {}, false);
  assert.equal(readFileSync(file, "utf8"), `MERGELIGHT_CLAUDE_TOKEN=${TOKEN}\n`);
});

test("Claude set to review with no login yet: only Claude's link is offered, and a miss says Claude", async () => {
  const api = fakeApi(() => false);
  const deps = githubConnect(api, 7, "abc", () => {}, { GH_TOKEN: "app" }, { purpose: "review", ai: "claude" });
  assert.equal(deps.only, "claude");
  assert.equal(await deps.startLogin(() => {}), 1, "no ChatGPT code");
  await deps.failed("The Claude link ran out before anyone finished signing in.");
  const comment = api.writes.find((w) => w.path === "issues/comments/5");
  assert.match(comment.body.body, /couldn't connect to Claude/);
  assert.match(comment.body.body, /Push a new commit to get a new link\./);
  assert.match(installAppBody("Claude"), /saves your Claude login/);
  assert.match(installAppBody(), /saves your ChatGPT login/);
  const body = connectBody(null, "https://github.com/run", LINK, claudeSetupLink("acme/api", 7));
  assert.match(body, /^### 🔌 Connect Claude to start reviews$/m);
});

test("the sign-in gets a terminal from script, in the form each system's script takes", () => {
  assert.deepEqual(scriptArgs("linux"), ["-qfc", "stty cols 3000 rows 50; exec claude setup-token", "/dev/null"]);
  assert.deepEqual(scriptArgs("darwin"), ["-qF", "/dev/null", "sh", "-c", "stty cols 3000 rows 50; exec claude setup-token"]);
});

test("Claude is asked for only where the workflow can pass its login on to later runs", async () => {
  const step = (inputs) => `jobs:\n  review:\n    steps:\n      - uses: mergelightai/mergelight@v0\n        with:\n${inputs}`;
  assert.equal(claudeInWorkflow(step("          claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}\n")), "yes");
  assert.equal(claudeInWorkflow(step("          codex-auth-json: x\n")), "no");
  assert.equal(claudeInWorkflow("jobs:\n  review:\n    uses: acme/ci/.github/workflows/mergelight.yml@main\n    secrets: inherit\n"), "unknown", "a reusable workflow may pass it on");
  assert.equal(claudeInWorkflow(null), "unknown");
  // Only this job's Mergelight step: another job passing the input on says nothing about this one.
  const twoJobs = "jobs:\n  build:\n    steps:\n      - run: echo\n        env:\n          claude-code-oauth-token: x\n  review:\n    steps:\n      - name: Review\n        uses: mergelightai/mergelight@v0\n        with:\n          codex-auth-json: x\n";
  assert.equal(claudeInWorkflow(twoJobs, "claude-code-oauth-token", "review"), "no");
  assert.equal(claudeInWorkflow(twoJobs, "codex-auth-json", "review"), "yes");
  // Asked for by name in a workflow that doesn't pass it on: the reason says what to add.
  const d = raced({ codexExit: 1, claudeOk: false, codexOutput: [] });
  d.only = "claude";
  d.startClaude = async () => null;
  d.claudeUnavailable = () => CLAUDE_INPUT_MISSING;
  assert.equal(await connect(d), 1);
  assert.match(d.events.at(-1), /claude-code-oauth-token: \$\{\{ secrets\.CLAUDE_CODE_OAUTH_TOKEN \}\}/);
});

test("a checker's ChatGPT login is asked for only where the workflow passes it on, and the reason says what to add", async () => {
  assert.equal(claudeInWorkflow("    - uses: mergelightai/mergelight@v0\n      with:\n        claude-code-oauth-token: x\n", "codex-auth-json"), "no");
  assert.equal(claudeInWorkflow("    - uses: mergelightai/mergelight@v0\n      with:\n        # codex-auth-json: x\n", "codex-auth-json"), "no", "a line commented out passes nothing on");
  assert.equal(claudeInWorkflow("    - uses: ./.github/actions/review\n      with:\n        chatgpt: x\n", "codex-auth-json"), "unknown", "a composite action of the team's own may pass it on");
  assert.equal(claudeInWorkflow("    - uses: mergelightai/mergelight@v0\n      with:\n        \"codex-auth-json\": x\n", "codex-auth-json"), "yes", "a quoted name");
  assert.equal(claudeInWorkflow("    - uses: mergelightai/mergelight@v0\n      with: {codex-auth-json: x, provider: claude}\n", "codex-auth-json"), "yes", "a flow mapping");
  assert.equal(claudeInWorkflow("    - uses: acme/mergelight-wrapper@v1\n      with:\n        chatgpt: x\n", "codex-auth-json"), "unknown", "a wrapper with another name may pass it on");
  assert.equal(claudeInWorkflow("    - uses: mergelightai/mergelight@v0\n      with:\n        codex-auth-json: ${{ secrets.CODEX_AUTH_JSON }}\n", "codex-auth-json"), "yes");
  const d = deps([], 1);
  d.chatgptUnavailable = () => chatgptInputMissing("MY_LOGIN");
  assert.equal(await connect(d), 1);
  assert.match(d.events.at(-1), /codex-auth-json: \$\{\{ secrets\.MY_LOGIN \}\}/);
});

test("a ChatGPT login connected to check counts as one, so a rejected one lets the reviewer check", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mergelight-connected-check-"));
  const file = join(dir, "env");
  writeFileSync(file, "");
  const api = fakeApi(() => false);
  await githubConnect(api, 7, "abc", () => {}, { GH_TOKEN: "app", GITHUB_ENV: file, CODEX_HOME: dir }, { purpose: "check", ai: "codex", reviewer: "claude" }).connected("chatgpt");
  assert.equal(readFileSync(file, "utf8"), "MERGELIGHT_CHATGPT=1\n");
});

test("every Mergelight step of the job must pass the login on, and YAML's shared parts can't be read", () => {
  const job = (steps) => `jobs:\n  review:\n    steps:\n${steps}`;
  const two = job("      - if: github.event_name == 'pull_request'\n        uses: mergelightai/mergelight@v0\n        with:\n          codex-auth-json: x\n      - if: github.event_name != 'pull_request'\n        uses: mergelightai/mergelight@v0\n");
  // Which one runs can't be told: a login saved for the one that doesn't pass it on would replace another's.
  assert.equal(claudeInWorkflow(two, "codex-auth-json", "review"), "no");
  assert.equal(claudeInWorkflow(job("      - uses: mergelightai/mergelight@v0\n        with: *inputs\n"), "codex-auth-json", "review"), "unknown");
  assert.equal(claudeInWorkflow(job("      - uses: mergelightai/mergelight@v0\n        with:\n          <<: *inputs\n"), "codex-auth-json", "review"), "unknown");
});

test("a connect hands its check on to the review, so none stands finished in between", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mergelight-handon-"));
  const file = join(dir, "env");
  writeFileSync(file, "");
  const api = fakeApi(() => false);
  const env = { GH_TOKEN: "app", GITHUB_ENV: file, CODEX_HOME: dir };
  const deps = githubConnect(api, 7, "abc", () => {}, env, { purpose: "check", ai: "codex", reviewer: "claude" });
  await deps.showCode({ url: "https://auth.openai.com/d", code: "AAAA-BBBB" });
  await deps.connected("chatgpt");
  const checks = api.writes.filter((w) => w.path.startsWith("check-runs"));
  assert.ok(checks.every((w) => w.body.status !== "completed"), JSON.stringify(checks.map((w) => w.body.status)));
  assert.match(readFileSync(file, "utf8"), /MERGELIGHT_CHECK_RUN=9\n/);
});

test("an approval-only Mergelight step needs no login, and the input must read the secret the login is saved to", () => {
  const job = (steps) => `jobs:\n  review:\n    steps:\n${steps}`;
  const withApproval = job("      - if: github.event_name != 'pull_request_review'\n        uses: mergelightai/mergelight@v0\n        with:\n          claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}\n      - if: github.event_name == 'pull_request_review'\n        uses: mergelightai/mergelight@v0\n");
  assert.equal(claudeInWorkflow(withApproval, "claude-code-oauth-token", "review", "CLAUDE_CODE_OAUTH_TOKEN"), "yes");
  const other = job("      - uses: mergelightai/mergelight@v0\n        with:\n          claude-code-oauth-token: ${{ secrets.CLAUDE_LOGIN }}\n");
  assert.equal(claudeInWorkflow(other, "claude-code-oauth-token", "review", "CLAUDE_CODE_OAUTH_TOKEN"), "no", "a login saved as CLAUDE_CODE_OAUTH_TOKEN never reaches it");
});
