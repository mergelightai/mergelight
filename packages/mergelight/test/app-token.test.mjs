import assert from "node:assert/strict";
import { test } from "node:test";
import { getAppToken } from "../scripts/app-token.mjs";

const env = {
  TOKEN_SERVER: "https://token.test/token",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://actions.test/idtoken?api-version=2.0",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
};

const json = (status, body) => new Response(JSON.stringify(body), { status });

function setup(server) {
  const lines = [];
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith("https://actions.test")) return json(200, { value: "oidc-jwt" });
    return typeof server === "function" ? server() : server;
  };
  return { lines, calls, fetchImpl, log: (l) => lines.push(l), wait: async () => {} };
}

test("returns the app token and masks both tokens before anything else can print them", async () => {
  const s = setup(json(200, { token: "ghs_app", repository: "acme/widgets" }));
  assert.equal(await getAppToken({ env, ...s }), "ghs_app");
  assert.ok(s.lines.includes("::add-mask::oidc-jwt"));
  assert.ok(s.lines.includes("::add-mask::ghs_app"));
  assert.ok(s.lines.indexOf("::add-mask::ghs_app") < s.lines.findIndex((l) => l.startsWith("Posting as")));

  const oidc = new URL(s.calls[0].url);
  assert.equal(oidc.searchParams.get("audience"), "mergelight");
  assert.equal(oidc.searchParams.get("api-version"), "2.0");
  assert.equal(s.calls[0].init.headers.authorization, "Bearer request-token");
  assert.equal(s.calls[1].init.method, "POST");
  assert.equal(s.calls[1].init.headers.authorization, "Bearer oidc-jwt");
});

test("does nothing when the token server is switched off", async () => {
  const s = setup(json(200, {}));
  assert.equal(await getAppToken({ env: { ...env, TOKEN_SERVER: "" }, ...s }), null);
  assert.equal(s.calls.length, 0);
  assert.equal(s.lines.length, 0);
});

test("explains the missing permission", async () => {
  const s = setup(json(200, {}));
  assert.equal(await getAppToken({ env: { TOKEN_SERVER: env.TOKEN_SERVER }, ...s }), null);
  assert.equal(s.calls.length, 0);
  assert.match(s.lines[0], /^::notice::.*id-token: write/);
});

test("an app that isn't installed is a notice, not a warning", async () => {
  const s = setup(json(404, { error: "not_installed", message: "Install it." }));
  assert.equal(await getAppToken({ env, ...s }), null);
  assert.ok(s.lines.some((l) => l.startsWith("::notice::Install it.")));
});

test("other refusals warn and fall back", async () => {
  const s = setup(json(403, { error: "needs_approval", message: "Approve it." }));
  assert.equal(await getAppToken({ env, ...s }), null);
  assert.ok(s.lines.some((l) => l.startsWith("::warning::Approve it.")));
});

test("retries a server error, then succeeds", async () => {
  let n = 0;
  const s = setup(() => (++n === 1 ? json(503, {}) : json(200, { token: "ghs_app", repository: "a/b" })));
  assert.equal(await getAppToken({ env, ...s }), "ghs_app");
  assert.equal(n, 2);
});

test("a server that stays down never throws, and leaks no token", async () => {
  const s = setup(() => {
    throw new Error("connection refused");
  });
  assert.equal(await getAppToken({ env, ...s }), null);
  assert.ok(s.lines.some((l) => l.startsWith("::warning::Couldn't reach the token server (connection refused)")));
  assert.ok(!s.lines.some((l) => l.includes("request-token")));
});
