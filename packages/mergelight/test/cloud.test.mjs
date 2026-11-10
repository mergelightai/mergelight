import assert from "node:assert/strict";
import { test } from "node:test";
import { AUDIENCE, cloudConnected, reportReview, reviewNumbers, serverUrl } from "../dist/cloud.js";
import { agentEnv } from "../dist/providers/codex.js";

const env = {
  MERGELIGHT_SERVER: "https://server.test",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://actions.test/idtoken?api-version=2.0",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
};

const json = (status, body) => new Response(JSON.stringify(body), { status });

/** A fake GitHub and a fake server. Each OIDC token GitHub hands out is different, like the real ones. */
function setup(server) {
  const lines = [];
  const masked = [];
  const calls = [];
  let tokens = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith("https://actions.test")) return json(200, { value: `oidc-${++tokens}` });
    return typeof server === "function" ? server(calls.filter((c) => c.url.startsWith("https://server.test")).length) : server;
  };
  return { calls, lines, masked, deps: { env, fetchImpl, log: (l) => lines.push(l), mask: (v) => masked.push(v) } };
}

const finding = (cls, tier, severity = "minor") => ({ class: cls, tier, severity });
const review = {
  pr: { owner: "acme", repo: "widgets", number: 42, title: "Secret title", url: "https://github.com/acme/widgets/pull/42", base_sha: "b".repeat(40), head_sha: "a".repeat(40) },
  provider: { name: "claude", model: "opus", effort: "high" },
  verifier: { name: "codex", model: null, effort: "high" },
  light: "yellow",
  summary: "Secret summary of the code",
  findings: [finding("bug", "post", "major"), finding("bug", "list"), finding("risk", "decision"), finding("hardening", "hardening")],
  stats: { duration_ms: 412_000.6, diff_chars: 9000, files_changed: 7, additions: 120, deletions: 14 },
  trace: { candidates: [{ title: "Secret candidate", file: "src/secret.ts" }], rejected: [], failed_hunters: [] },
};

test("the numbers hold no text from the review: no title, summary, finding or file path", () => {
  const numbers = reviewNumbers(review);
  assert.deepEqual(numbers, {
    pr: 42,
    sha: "a".repeat(40),
    light: "yellow",
    counts: { bug: 2, risk: 1, hardening: 1 },
    tiers: { post: 1, list: 1, decision: 1 },
    major: 1,
    provider: "claude",
    model: "opus",
    verifier: "codex",
    duration_ms: 412_001,
    files_changed: 7,
    additions: 120,
    deletions: 14,
  });
  assert.doesNotMatch(JSON.stringify(numbers), /Secret|src\//);
});

test("a model name that isn't a plain name is not sent", () => {
  assert.equal(reviewNumbers({ ...review, provider: { ...review.provider, model: "my model; see notes" } }).model, null);
  assert.equal(reviewNumbers({ ...review, provider: { ...review.provider, model: null } }).model, null);
  assert.equal(reviewNumbers({ ...review, verifier: undefined }).verifier, null);
});

test("off by default, and only https or a server on this machine counts", () => {
  assert.equal(serverUrl({}), null);
  assert.equal(serverUrl({ MERGELIGHT_SERVER: "  " }), null);
  assert.equal(serverUrl({ MERGELIGHT_SERVER: "not a url" }), null);
  assert.equal(serverUrl({ MERGELIGHT_SERVER: "http://server.test" }), null);
  assert.equal(serverUrl({ MERGELIGHT_SERVER: "ftp://server.test" }), null);
  assert.equal(serverUrl({ MERGELIGHT_SERVER: "https://server.test" }).href, "https://server.test/");
  assert.equal(serverUrl({ MERGELIGHT_SERVER: "http://127.0.0.1:10001" }).href, "http://127.0.0.1:10001/");
});

test("with no server set, nothing is asked and nothing is sent", async () => {
  const s = setup(json(200, { connected: true }));
  const deps = { ...s.deps, env: { ...env, MERGELIGHT_SERVER: "" } };
  assert.equal(await cloudConnected(deps), false);
  assert.equal(await reportReview(review, deps), false);
  assert.equal(s.calls.length, 0);
  assert.equal(s.lines.length, 0);
});

test("asks GitHub for a token made for the server, hides it, and asks the server", async () => {
  const s = setup(json(200, { connected: true }));
  assert.equal(await cloudConnected(s.deps), true);

  const oidc = new URL(s.calls[0].url);
  assert.equal(oidc.searchParams.get("audience"), AUDIENCE);
  assert.notEqual(AUDIENCE, "mergelight");
  assert.equal(oidc.searchParams.get("api-version"), "2.0");
  assert.equal(s.calls[0].init.headers.authorization, "Bearer request-token");
  assert.equal(s.calls[1].url, "https://server.test/v1/context");
  assert.equal(s.calls[1].init.method, "GET");
  assert.equal(s.calls[1].init.headers.authorization, "Bearer oidc-1");
  assert.deepEqual(s.masked, ["oidc-1"]);
});

test("an org that isn't on the dashboard, or an odd answer, counts as not connected", async () => {
  assert.equal(await cloudConnected(setup(json(200, { connected: false })).deps), false);
  assert.equal(await cloudConnected(setup(json(200, { connected: "yes" })).deps), false);
  assert.equal(await cloudConnected(setup(json(200, {})).deps), false);
  const refused = setup(json(401, { error: "invalid_token" }));
  assert.equal(await cloudConnected(refused.deps), false);
  assert.match(refused.lines[0], /answered 401.*runs without it/);
});

test("sends the numbers with a new token, and nothing but the numbers", async () => {
  const s = setup(json(201, { stored: true }));
  assert.equal(await reportReview(review, s.deps), true);
  const sent = s.calls[1];
  assert.equal(sent.url, "https://server.test/v1/reviews");
  assert.equal(sent.init.method, "POST");
  assert.equal(sent.init.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(sent.init.body), reviewNumbers(review));
  assert.equal(s.lines.length, 0);
});

test("a server error is tried once more, with a token of its own", async () => {
  const s = setup((n) => (n === 1 ? json(503, {}) : json(201, { stored: true })));
  assert.equal(await reportReview(review, s.deps), true);
  const toServer = s.calls.filter((c) => c.url.startsWith("https://server.test"));
  assert.deepEqual(toServer.map((c) => c.init.headers.authorization), ["Bearer oidc-1", "Bearer oidc-2"]);
});

test("a server that is down or refuses never throws: the review goes on", async () => {
  const down = setup(() => {
    throw new Error("connect ECONNREFUSED");
  });
  assert.equal(await cloudConnected(down.deps), false);
  assert.match(down.lines[0], /Couldn't reach the Mergelight server \(connect ECONNREFUSED\)/);
  assert.equal(await reportReview(review, down.deps), false);
  assert.match(down.lines[1], /The review itself is posted/);

  const refused = setup(json(404, { error: "not_connected" }));
  assert.equal(await reportReview(review, refused.deps), false);
  assert.match(refused.lines[0], /answered 404/);
});

test("without id-token: write it says so and goes on", async () => {
  const s = setup(json(200, { connected: true }));
  assert.equal(await cloudConnected({ ...s.deps, env: { MERGELIGHT_SERVER: env.MERGELIGHT_SERVER } }), false);
  assert.match(s.lines[0], /id-token: write/);
  assert.equal(s.calls.length, 0);
});

test("the reviewing model's process can't ask GitHub for a token at all", () => {
  const seen = agentEnv({ ...env, PATH: "/usr/bin" });
  assert.equal(seen.ACTIONS_ID_TOKEN_REQUEST_URL, undefined);
  assert.equal(seen.ACTIONS_ID_TOKEN_REQUEST_TOKEN, undefined);
  assert.equal(seen.PATH, "/usr/bin");
});
