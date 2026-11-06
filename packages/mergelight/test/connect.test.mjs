import assert from "node:assert/strict";
import { test } from "node:test";
import { connect, connectBody, connectFailedBody, installAppBody, parseDeviceLogin } from "../dist/connect.js";
import { isPendingSummary, SUMMARY_MARKER } from "../dist/publish/markdown.js";

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

function deps(output, exit) {
  const events = [];
  return {
    events,
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
  assert.match(d.events[0], /^failed .*turned off/);
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

test("the comment gives the link, the code and where it came from", () => {
  const body = connectBody({ url: "https://auth.openai.com/codex/device", code: "2ZYY-TEST1" }, "https://github.com/a/b/actions/runs/1");
  assert.ok(body.includes("https://auth.openai.com/codex/device"));
  assert.ok(body.includes("`2ZYY-TEST1`"));
  assert.ok(body.includes("https://github.com/a/b/actions/runs/1"));
  assert.doesNotMatch(body, /[–—]/, "no dashes in copy");
});

test("every comment is the summary, so the review replaces it", () => {
  const login = { url: "https://auth.openai.com/codex/device", code: "2ZYY-TEST1" };
  for (const body of [connectBody(login), installAppBody(), connectFailedBody("x")]) assert.ok(body.startsWith(SUMMARY_MARKER));
  assert.ok(isPendingSummary(connectBody(login)));
  assert.ok(isPendingSummary(installAppBody()));
  assert.ok(!isPendingSummary(connectFailedBody("x")), "a failure stays until the next push");
});
