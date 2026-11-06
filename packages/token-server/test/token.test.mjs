import assert from "node:assert/strict";
import { generateKeyPairSync, createSign, verify as nodeVerify } from "node:crypto";
import { beforeEach, test } from "node:test";
import { createAppJwt, handle, resetJwksCache, verifyOidcToken } from "../src/token.js";

const NOW = Date.parse("2026-11-06T12:00:00Z");
const SECONDS = Math.floor(NOW / 1000);
const ISSUER = "https://token.actions.githubusercontent.com";

const oidc = generateKeyPairSync("rsa", { modulusLength: 2048 });
const attacker = generateKeyPairSync("rsa", { modulusLength: 2048 });
const app = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-kid";

const b64 = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

function makeToken(claims = {}, { header = {}, key = oidc.privateKey } = {}) {
  const head = b64({ alg: "RS256", kid: KID, ...header });
  const body = b64({
    iss: ISSUER,
    aud: "mergelight",
    exp: SECONDS + 300,
    nbf: SECONDS - 10,
    repository: "acme/widgets",
    event_name: "pull_request",
    ...claims,
  });
  const signer = createSign("RSA-SHA256");
  signer.update(`${head}.${body}`);
  return `${head}.${body}.${signer.sign(key).toString("base64url")}`;
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status });
}

/** A fake GitHub. calls records what the server asked for. */
function fakeGitHub(overrides = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/.well-known/jwks")) {
      return json(200, { keys: [{ ...oidc.publicKey.export({ format: "jwk" }), kid: KID }] });
    }
    if (String(url).endsWith("/installation")) return overrides.installation ?? json(200, { id: 42 });
    if (String(url).endsWith("/access_tokens")) {
      return overrides.token ?? json(201, { token: "ghs_app_token", expires_at: "2026-11-06T13:00:00Z" });
    }
    throw new Error(`unexpected call to ${url}`);
  };
  return { calls, fetchImpl };
}

const env = (format = "pkcs1") => ({
  GITHUB_APP_CLIENT_ID: "Iv23-test",
  GITHUB_APP_PRIVATE_KEY: app.privateKey.export({ type: format, format: "pem" }).toString(),
});

function post(token, path = "/token") {
  return new Request(`https://token.test${path}`, {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

beforeEach(() => resetJwksCache());

test("a valid run gets a token for its own repository, with only the review permissions", async () => {
  const { calls, fetchImpl } = fakeGitHub();
  const res = await handle(post(makeToken()), env(), fetchImpl, NOW);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(await res.json(), { token: "ghs_app_token", expires_at: "2026-11-06T13:00:00Z", repository: "acme/widgets" });

  const lookup = calls.find((c) => c.url.endsWith("/installation"));
  assert.equal(lookup.url, "https://api.github.com/repos/acme/widgets/installation");
  const minted = calls.find((c) => c.url.endsWith("/access_tokens"));
  assert.equal(minted.url, "https://api.github.com/app/installations/42/access_tokens");
  assert.deepEqual(JSON.parse(minted.init.body), {
    repositories: ["widgets"],
    permissions: { checks: "write", pull_requests: "write", contents: "read" },
  });
});

test("rejects tokens that aren't GitHub's", async (t) => {
  const cases = {
    "signed with another key": makeToken({}, { key: attacker.privateKey }),
    "alg none": `${b64({ alg: "none", kid: KID })}.${b64({ iss: ISSUER, aud: "mergelight", exp: SECONDS + 300 })}.`,
    "HS256": makeToken({}, { header: { alg: "HS256" } }),
    "unknown key id": makeToken({}, { header: { kid: "other" } }),
    "wrong issuer": makeToken({ iss: "https://evil.example" }),
    "wrong audience": makeToken({ aud: "sts.amazonaws.com" }),
    "expired": makeToken({ exp: SECONDS - 120 }),
    "not valid yet": makeToken({ nbf: SECONDS + 120 }),
    "tampered claims": (() => {
      const [h, , s] = makeToken().split(".");
      return `${h}.${b64({ iss: ISSUER, aud: "mergelight", exp: SECONDS + 300, repository: "victim/secret", event_name: "pull_request" })}.${s}`;
    })(),
    "garbage": "not-a-jwt",
  };
  for (const [name, token] of Object.entries(cases)) {
    await t.test(name, async () => {
      resetJwksCache();
      const { calls, fetchImpl } = fakeGitHub();
      const res = await handle(post(token), env(), fetchImpl, NOW);
      assert.equal(res.status, 401);
      assert.equal((await res.json()).error, "invalid_token");
      assert.ok(!calls.some((c) => c.url.includes("api.github.com")), "must not call GitHub with the app's key");
    });
  }
});

test("a login token can only write secrets", async () => {
  const { calls, fetchImpl } = fakeGitHub();
  const res = await handle(post(makeToken({ event_name: "schedule" }), "/token?scope=login"), env(), fetchImpl, NOW);
  assert.equal(res.status, 200);
  const minted = calls.find((c) => c.url.endsWith("/access_tokens"));
  assert.deepEqual(JSON.parse(minted.init.body), { repositories: ["widgets"], permissions: { secrets: "write" } });
});

test("a scheduled run gets a login token but no review token", async () => {
  const { fetchImpl } = fakeGitHub();
  assert.equal((await handle(post(makeToken({ event_name: "schedule" })), env(), fetchImpl, NOW)).status, 403);
});

test("an approval can't ask for a login token", async () => {
  const { fetchImpl } = fakeGitHub();
  const res = await handle(post(makeToken({ event_name: "pull_request_review" }), "/token?scope=login"), env(), fetchImpl, NOW);
  assert.equal(res.status, 403);
});

test("unknown scopes are refused before any check, including inherited names", async () => {
  for (const scope of ["admin", "constructor", "__proto__"]) {
    const { calls, fetchImpl } = fakeGitHub();
    const res = await handle(post(makeToken(), `/token?scope=${scope}`), env(), fetchImpl, NOW);
    assert.equal(res.status, 400, scope);
    assert.equal(calls.length, 0, scope);
  }
});

test("a missing token gets a 401", async () => {
  const { fetchImpl } = fakeGitHub();
  assert.equal((await handle(post(null), env(), fetchImpl, NOW)).status, 401);
});

test("runs from other events get no token", async () => {
  const { calls, fetchImpl } = fakeGitHub();
  const res = await handle(post(makeToken({ event_name: "push" })), env(), fetchImpl, NOW);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, "event_not_allowed");
  assert.ok(!calls.some((c) => c.url.includes("api.github.com")));
});

test("says how to fix it when the app isn't installed", async () => {
  const { fetchImpl } = fakeGitHub({ installation: json(404, {}) });
  const res = await handle(post(makeToken()), env(), fetchImpl, NOW);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, "not_installed");
  assert.match(body.message, /installations\/new/);
});

test("says so when an install hasn't approved new permissions", async () => {
  const { fetchImpl } = fakeGitHub({ token: json(422, {}) });
  const res = await handle(post(makeToken()), env(), fetchImpl, NOW);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, "needs_approval");
});

test("GitHub errors become a 502, and no details leak", async () => {
  const { fetchImpl } = fakeGitHub({ installation: json(500, { secret: "nope" }) });
  const res = await handle(post(makeToken()), env(), fetchImpl, NOW);
  assert.equal(res.status, 502);
  assert.doesNotMatch(JSON.stringify(await res.json()), /nope/);
});

test("unexpected errors don't echo details", async () => {
  const { fetchImpl } = fakeGitHub();
  const broken = { GITHUB_APP_CLIENT_ID: "x", GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\n!!!\n-----END PRIVATE KEY-----" };
  const res = await handle(post(makeToken()), broken, fetchImpl, NOW);
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, "server_error");
});

test("only POST /token mints", async () => {
  const { fetchImpl } = fakeGitHub();
  assert.equal((await handle(new Request("https://token.test/"), env(), fetchImpl, NOW)).status, 200);
  assert.equal((await handle(new Request("https://token.test/token"), env(), fetchImpl, NOW)).status, 405);
  assert.equal((await handle(post(makeToken(), "/other"), env(), fetchImpl, NOW)).status, 404);
});

test("signs a valid app JWT from both key formats GitHub may issue", async () => {
  for (const format of ["pkcs1", "pkcs8"]) {
    const jwt = await createAppJwt(env(format), NOW);
    const [head, body, signature] = jwt.split(".");
    const claims = JSON.parse(Buffer.from(body, "base64url"));
    assert.equal(claims.iss, "Iv23-test");
    assert.ok(claims.exp - claims.iat <= 600, "GitHub allows 10 minutes at most");
    assert.ok(
      nodeVerify("RSA-SHA256", Buffer.from(`${head}.${body}`), app.publicKey, Buffer.from(signature, "base64url")),
      `${format} signature`,
    );
  }
});

test("random key ids don't refetch GitHub's keys every time", async () => {
  const { calls, fetchImpl } = fakeGitHub();
  for (let i = 0; i < 5; i++) {
    await verifyOidcToken(makeToken({}, { header: { kid: `random-${i}` } }), fetchImpl, NOW).catch(() => {});
  }
  assert.equal(calls.filter((c) => c.url.endsWith("/jwks")).length, 1);
});

function signInRequest(body, { origin = "https://mergelight.dev", method = "POST" } = {}) {
  return new Request("https://token.test/sign-in", {
    method,
    headers: { ...(origin ? { origin } : {}), "content-type": "application/json" },
    ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
}

const signInEnv = () => ({ ...env(), GITHUB_APP_CLIENT_SECRET: "client-secret" });

function fakeSignIn(answer) {
  const calls = [];
  return { calls, fetchImpl: async (url, init) => (calls.push({ url: String(url), init }), answer) };
}

test("sign-in swaps a code for the person's token, and only tells the setup page", async () => {
  const { calls, fetchImpl } = fakeSignIn(json(200, { access_token: "ghu_person", expires_in: 28800 }));
  const res = await handle(signInRequest({ code: "abc123" }), signInEnv(), fetchImpl, NOW);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { token: "ghu_person", expires_in: 28800 });
  assert.equal(res.headers.get("access-control-allow-origin"), "https://mergelight.dev");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(calls[0].url, "https://github.com/login/oauth/access_token");
  assert.deepEqual(JSON.parse(calls[0].init.body), { client_id: "Iv23-test", client_secret: "client-secret", code: "abc123" });
});

test("sign-in refuses other sites, and requests with no origin", async () => {
  for (const origin of ["https://evil.example", "https://mergelight.dev.evil.example", null]) {
    const { calls, fetchImpl } = fakeSignIn(json(200, { access_token: "x" }));
    const res = await handle(signInRequest({ code: "abc" }, { origin }), signInEnv(), fetchImpl, NOW);
    assert.equal(res.status, 403, String(origin));
    assert.equal(res.headers.get("access-control-allow-origin"), null);
    assert.equal(calls.length, 0);
  }
});

test("sign-in answers the browser's preflight", async () => {
  const { calls, fetchImpl } = fakeSignIn(json(200, {}));
  const res = await handle(signInRequest(null, { method: "OPTIONS" }), signInEnv(), fetchImpl, NOW);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "https://mergelight.dev");
  assert.match(res.headers.get("access-control-allow-headers"), /content-type/);
  assert.equal(calls.length, 0);
});

test("sign-in rejects bad codes without asking GitHub", async () => {
  for (const body of ["not json", {}, { code: 5 }, { code: "" }, { code: "a b" }, { code: "x".repeat(201) }]) {
    const { calls, fetchImpl } = fakeSignIn(json(200, {}));
    const res = await handle(signInRequest(body), signInEnv(), fetchImpl, NOW);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 30));
    assert.equal(calls.length, 0);
  }
});

test("a used code fails plainly, without echoing GitHub's answer", async () => {
  const { fetchImpl } = fakeSignIn(json(200, { error: "bad_verification_code", error_description: "secret detail" }));
  const res = await handle(signInRequest({ code: "used" }), signInEnv(), fetchImpl, NOW);
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "sign_in_failed" });
});

test("without a client secret only sign-in is off", async () => {
  const { fetchImpl } = fakeSignIn(json(200, {}));
  const res = await handle(signInRequest({ code: "abc" }), env(), fetchImpl, NOW);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, "sign_in_not_set_up");
});

test("sign-in doesn't take other methods", async () => {
  const { fetchImpl } = fakeSignIn(json(200, {}));
  const res = await handle(signInRequest(null, { method: "GET" }), signInEnv(), fetchImpl, NOW);
  assert.equal(res.status, 405);
});
