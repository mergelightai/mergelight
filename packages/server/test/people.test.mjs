import assert from "node:assert/strict";
import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { resetJwksCache } from "../../token-server/dist/token.js";
import { createApi } from "../dist/api.js";
import { connectOrg, createPool, deleteOrg, migrate } from "../dist/db.js";
import { parseOrigins } from "../dist/people.js";
import { createDataServer } from "../dist/server.js";
import { startPostgres } from "./postgres.mjs";

const NOW = Date.parse("2026-11-11T08:00:00Z");
const SECONDS = Math.floor(NOW / 1000);
const KID = "test-kid";
const PUBLIC_URL = "https://server.test";
const SITE = "https://mergelight.dev";
const oidc = generateKeyPairSync("rsa", { modulusLength: 2048 });

const ACME = { id: 1001, login: "acme" };
const OTHER = { id: 2002, login: "other" };
const QUIET = { id: 3003, login: "quiet" };

/** GitHub tokens of two people. Ada reaches acme/widgets and acme/api, and the org "quiet". Bo reaches only other/vault. */
const ADA = "ghu_" + "a".repeat(36);
const BO = "ghu_" + "b".repeat(36);
/** Cy signed in to some other GitHub App, which is also installed on acme. That token is not a Mergelight sign-in. */
const CY = "ghu_" + "c".repeat(36);
const people = {
  [ADA]: { user: { id: 11, login: "ada" }, installations: [{ id: 501, account: ACME, repos: [{ id: 501, full_name: "acme/widgets" }, { id: 502, full_name: "acme/api" }] }, { id: 503, account: QUIET, repos: [{ id: 901, full_name: "quiet/site" }] }] },
  [BO]: { user: { id: 22, login: "bo" }, installations: [{ id: 601, account: OTHER, repos: [{ id: 777, full_name: "other/vault" }] }] },
  [CY]: { user: { id: 33, login: "cy" }, installations: [{ id: 701, app: "some-other-app", account: ACME, repos: [{ id: 501, full_name: "acme/widgets" }] }] },
};

const json = (status, body) => new Response(JSON.stringify(body), { status });
let githubCalls;
/** Set to make the fake GitHub answer every call with this status, as when it limits a caller. */
let githubAnswers;

/** A fake GitHub: its signing keys for runs, and what each person's token is allowed to see. */
const fetchImpl = async (url, init = {}) => {
  const u = new URL(url);
  if (u.pathname.endsWith("/.well-known/jwks")) return json(200, { keys: [{ ...oidc.publicKey.export({ format: "jwk" }), kid: KID }] });
  assert.equal(u.origin, "https://api.github.com");
  githubCalls.push(u.pathname);
  if (githubAnswers) return new Response(JSON.stringify({ message: "slow down" }), typeof githubAnswers === "number" ? { status: githubAnswers } : githubAnswers);
  const who = people[(init.headers?.authorization ?? "").replace("Bearer ", "")];
  if (!who) return json(401, { message: "Bad credentials" });
  if (u.pathname === "/user") return json(200, who.user);
  if (u.pathname === "/user/installations") return json(200, { installations: who.installations.map(({ id, account, app = "mergelight-setup" }) => ({ id, account, app_slug: app })) });
  const m = /^\/user\/installations\/(\d+)\/repositories$/.exec(u.pathname);
  const installation = m && who.installations.find((i) => i.id === Number(m[1]));
  if (installation) return json(200, { repositories: installation.repos });
  return json(404, {});
};

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
function runToken(claims = {}) {
  const head = b64({ alg: "RS256", kid: KID });
  const body = b64({
    iss: "https://token.actions.githubusercontent.com", aud: PUBLIC_URL, exp: SECONDS + 300, nbf: SECONDS - 10, jti: randomUUID(),
    repository: "acme/widgets", repository_id: "501", repository_owner: "acme", repository_owner_id: String(ACME.id),
    run_id: "9001", run_attempt: "1", event_name: "pull_request", ...claims,
  });
  const signer = createSign("RSA-SHA256");
  signer.update(`${head}.${body}`);
  return `${head}.${body}.${signer.sign(oidc.privateKey).toString("base64url")}`;
}

const REVIEW = {
  pr: 42, sha: "a".repeat(40), light: "yellow", counts: { bug: 2, risk: 1, hardening: 3 }, tiers: { post: 2, list: 1, decision: 0 }, major: 1,
  provider: "claude", model: "opus", verifier: "claude", duration_ms: 412_000, files_changed: 7, additions: 120, deletions: 14,
};

let postgres;
let pool;
let api;
let clock;

const call = (path, { method = "GET", token, origin = SITE, body } = {}) =>
  api(new Request(`https://server.test${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(origin ? { origin } : {}) }, body }));
const report = (claims, review = {}) =>
  api(new Request("https://server.test/v1/reviews", { method: "POST", headers: { authorization: `Bearer ${runToken(claims)}` }, body: JSON.stringify({ ...REVIEW, report_id: randomUUID(), ...review }) }));
const signIn = async (githubToken) => (await call("/v1/session", { method: "POST", token: githubToken })).json();

before(async () => {
  postgres = await startPostgres();
  pool = createPool(postgres.url);
  await migrate(pool);
});

after(async () => {
  await pool?.end();
  await postgres?.stop();
});

beforeEach(async () => {
  resetJwksCache();
  githubCalls = [];
  githubAnswers = null;
  clock = NOW;
  api = createApi({ pool, publicUrl: PUBLIC_URL, origins: [SITE], fetchImpl, now: () => clock });
  for (const org of [ACME, OTHER, QUIET]) await deleteOrg(pool, org.id);
  await connectOrg(pool, ACME.id, ACME.login);
  await connectOrg(pool, OTHER.id, OTHER.login);
  // Three repositories with reviews: two in acme (one of them Ada can't see), one in other.
  assert.equal((await report({})).status, 201);
  assert.equal((await report({ repository: "acme/secret", repository_id: "599", run_id: "9002" }, { pr: 7, light: "red" })).status, 201);
  assert.equal((await report({ repository: "other/vault", repository_id: "777", repository_owner: "other", repository_owner_id: String(OTHER.id), run_id: "9003" }, { pr: 3, light: "green" })).status, 201);
});

test("a sign-in gets a session of the server's own, and the GitHub token goes no further", async () => {
  const res = await call("/v1/session", { method: "POST", token: ADA });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.json();
  assert.deepEqual(body.user, { id: 11, login: "ada" });
  assert.deepEqual(body.orgs, [
    { id: ACME.id, login: "acme", connected: true, repos: 2 },
    { id: QUIET.id, login: "quiet", connected: false, repos: 1 },
  ]);
  assert.match(body.token, /^[\w-]{40,}$/);
  assert.equal(Date.parse(body.expires_at), NOW + 60 * 60_000);
  assert.doesNotMatch(JSON.stringify(body), new RegExp(ADA));
  assert.deepEqual(githubCalls, ["/user", "/user/installations", "/user/installations/501/repositories", "/user/installations/503/repositories"]);
});

test("a person sees the reviews of repositories GitHub shows them, and no others in the same org", async () => {
  const { token } = await signIn(ADA);
  githubCalls = [];
  const res = await call(`/v1/orgs/${ACME.id}/overview`, { token });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.org, { id: ACME.id, login: "acme" });
  assert.deepEqual(body.repos.map((r) => [r.id, r.name, r.reviews]), [[501, "acme/widgets", 1]]);
  assert.equal(body.reviews.length, 1);
  const [review] = body.reviews;
  assert.deepEqual([review.repo, review.pr, review.light, review.bugs, review.risks, review.major, review.provider, review.model], ["acme/widgets", 42, "yellow", 2, 1, 1, "claude", "opus"]);
  assert.doesNotMatch(JSON.stringify(body), /secret|vault/);
  // The page is served from what the sign-in learned. GitHub isn't asked again for each page.
  assert.deepEqual(githubCalls, []);
});

test("another org's page doesn't exist for someone who can't reach it", async () => {
  const ada = (await signIn(ADA)).token;
  const bo = (await signIn(BO)).token;
  const res = await call(`/v1/orgs/${OTHER.id}/overview`, { token: ada });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, "not_found");
  assert.equal((await call(`/v1/orgs/${ACME.id}/overview`, { token: bo })).status, 404);
  assert.equal((await call("/v1/orgs/999999/overview", { token: ada })).status, 404);

  const own = await (await call(`/v1/orgs/${OTHER.id}/overview`, { token: bo })).json();
  assert.deepEqual(own.repos.map((r) => r.name), ["other/vault"]);
  assert.deepEqual(own.reviews.map((r) => r.light), ["green"]);
});

test("an org that hasn't turned the dashboard on says so, and shows nothing", async () => {
  const { token } = await signIn(ADA);
  const res = await call(`/v1/orgs/${QUIET.id}/overview`, { token });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, "not_connected");
});

test("without a session, with a made-up one, or with one that ran out, nothing is shown", async () => {
  const { token } = await signIn(ADA);
  assert.equal((await call(`/v1/orgs/${ACME.id}/overview`)).status, 401);
  assert.equal((await call(`/v1/orgs/${ACME.id}/overview`, { token: "x".repeat(43) })).status, 401);
  // The GitHub token itself is not a session.
  assert.equal((await call(`/v1/orgs/${ACME.id}/overview`, { token: ADA })).status, 401);
  assert.equal((await call(`/v1/orgs/${ACME.id}/overview`, { token })).status, 200);
  clock += 60 * 60_000 + 1;
  const late = await call(`/v1/orgs/${ACME.id}/overview`, { token });
  assert.equal(late.status, 401);
  assert.equal((await late.json()).error, "signed_out");
});

test("a run's token and a person's session never open each other's doors", async () => {
  const { token } = await signIn(ADA);
  // A session on the run's routes.
  assert.equal((await api(new Request("https://server.test/v1/context", { headers: { authorization: `Bearer ${token}` } }))).status, 401);
  assert.equal((await api(new Request("https://server.test/v1/reviews", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ ...REVIEW, report_id: randomUUID() }) }))).status, 401);
  // A run's token on the people's routes: not a sign-in, and GitHub is never asked about it.
  githubCalls = [];
  assert.equal((await call("/v1/session", { method: "POST", token: runToken() })).status, 401);
  assert.equal((await call(`/v1/orgs/${ACME.id}/overview`, { token: runToken() })).status, 401);
  assert.deepEqual(githubCalls, []);
});

test("a sign-in GitHub refuses is refused, and a token that isn't GitHub's never reaches GitHub", async () => {
  const refused = await call("/v1/session", { method: "POST", token: "ghu_" + "z".repeat(36) });
  assert.equal(refused.status, 401);
  assert.equal((await refused.json()).error, "sign_in_failed");
  githubCalls = [];
  for (const bad of [undefined, "hello", "ghu_short", "ghp_" + "a".repeat(36), "gho_" + "a".repeat(36), "ghu_" + "a".repeat(10) + " injected", "Bearer x"]) {
    assert.equal((await call("/v1/session", { method: "POST", token: bad })).status, 401, String(bad));
  }
  assert.deepEqual(githubCalls, []);
});

test("a token another GitHub App got for the same person is not a sign-in", async () => {
  const res = await call("/v1/session", { method: "POST", token: CY });
  assert.equal(res.status, 401);
  assert.match((await res.json()).message, /isn't Mergelight's/);
  // The repositories of that other app's install are never asked for.
  assert.deepEqual(githubCalls, ["/user", "/user/installations"]);
});

test("a server someone else hosts signs people in with its own app", async () => {
  const own = createApi({ pool, publicUrl: PUBLIC_URL, origins: [SITE], signInApp: "some-other-app", fetchImpl, now: () => clock });
  const ask = (token) => own(new Request("https://server.test/v1/session", { method: "POST", headers: { authorization: `Bearer ${token}`, origin: SITE } }));
  assert.equal((await ask(CY)).status, 201);
  assert.equal((await ask(ADA)).status, 401);
});

test("signing out ends the session", async () => {
  const { token } = await signIn(ADA);
  assert.equal((await call("/v1/session", { method: "DELETE", token })).status, 204);
  assert.equal((await call(`/v1/orgs/${ACME.id}/overview`, { token })).status, 401);
  assert.equal((await call("/v1/session", { method: "DELETE", token })).status, 401);
});

test("only the dashboard's own site can read the answers from a browser", async () => {
  const preflight = await call("/v1/session", { method: "OPTIONS" });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), SITE);
  assert.match(preflight.headers.get("access-control-allow-methods"), /POST/);
  assert.match(preflight.headers.get("access-control-allow-headers"), /authorization/);

  const ok = await call("/v1/session", { method: "POST", token: ADA });
  assert.equal(ok.headers.get("access-control-allow-origin"), SITE);
  assert.equal(ok.headers.get("vary"), "Origin");

  const elsewhere = await call("/v1/session", { method: "POST", token: ADA, origin: "https://evil.example" });
  assert.equal(elsewhere.status, 403);
  assert.equal(elsewhere.headers.get("access-control-allow-origin"), null);
  assert.equal((await call(`/v1/orgs/${ACME.id}/overview`, { method: "OPTIONS", origin: "https://evil.example" })).status, 403);

  // The run's routes answer no browser at all.
  const run = await api(new Request("https://server.test/v1/context", { headers: { authorization: `Bearer ${runToken({ run_id: "9100" })}`, origin: SITE } }));
  assert.equal(run.headers.get("access-control-allow-origin"), null);
});

test("the site list must be https, and defaults to mergelight.dev", () => {
  assert.deepEqual(parseOrigins(undefined), ["https://mergelight.dev"]);
  assert.deepEqual(parseOrigins("https://a.example/path, http://localhost:5173"), ["https://a.example", "http://localhost:5173"]);
  assert.throws(() => parseOrigins("http://a.example"), /https/);
  assert.throws(() => parseOrigins("not a url"));
});

test("signing out always works, even for someone who is being slowed down", async () => {
  const { token } = await signIn(ADA);
  for (let i = 0; i < 241; i++) await call(`/v1/orgs/${ACME.id}/overview`, { token });
  assert.equal((await call(`/v1/orgs/${ACME.id}/overview`, { token })).status, 429);
  assert.equal((await call("/v1/session", { method: "DELETE", token })).status, 204);
  clock += 61_000;
  assert.equal((await call(`/v1/orgs/${ACME.id}/overview`, { token })).status, 401);
});

test("more sessions don't buy more requests: the limit is per person", async () => {
  const first = (await signIn(ADA)).token;
  clock += 21_000;
  const second = (await signIn(ADA)).token;
  for (let i = 0; i < 120; i++) assert.equal((await call(`/v1/orgs/${ACME.id}/overview`, { token: first })).status, 200);
  for (let i = 0; i < 120; i++) assert.equal((await call(`/v1/orgs/${ACME.id}/overview`, { token: second })).status, 200);
  assert.equal((await call(`/v1/orgs/${ACME.id}/overview`, { token: first })).status, 429);
  assert.equal((await call(`/v1/orgs/${ACME.id}/overview`, { token: second })).status, 429);
  // Someone else isn't slowed down by it.
  assert.equal((await call(`/v1/orgs/${OTHER.id}/overview`, { token: (await signIn(BO)).token })).status, 200);
});

test("a person holds a few sessions at most, and a new one replaces the oldest", async () => {
  const tokens = [];
  for (let i = 0; i < 6; i++) {
    tokens.push((await signIn(ADA)).token);
    clock += 21_000;
  }
  assert.equal((await call(`/v1/orgs/${ACME.id}/overview`, { token: tokens[0] })).status, 401);
  for (const token of tokens.slice(1)) assert.equal((await call(`/v1/orgs/${ACME.id}/overview`, { token })).status, 200);
});

test("the same GitHub sign-in can't be replayed to make the server ask GitHub over and over", async () => {
  assert.equal((await call("/v1/session", { method: "POST", token: ADA })).status, 201);
  const calls = githubCalls.length;
  const again = await call("/v1/session", { method: "POST", token: ADA });
  assert.equal(again.status, 429);
  assert.equal(githubCalls.length, calls);
  clock += 21_000;
  assert.equal((await call("/v1/session", { method: "POST", token: ADA })).status, 201);
});

test("requests that aren't a sign-in don't use up the sign-ins everyone shares", async () => {
  for (let i = 0; i < 300; i++) assert.equal((await call("/v1/session", { method: "POST", token: i % 2 ? "junk" : undefined })).status, 401);
  assert.equal((await call("/v1/session", { method: "POST", token: ADA })).status, 201);
});

test("when GitHub asks the server to slow down, sign-ins stop for a minute instead of pushing on", async () => {
  githubAnswers = 429;
  const limited = await call("/v1/session", { method: "POST", token: ADA });
  assert.equal(limited.status, 503);
  assert.equal((await limited.json()).error, "github_limited");
  const calls = githubCalls.length;
  githubAnswers = null;
  // Another person, straight after: GitHub isn't asked at all.
  assert.equal((await call("/v1/session", { method: "POST", token: BO })).status, 503);
  assert.equal(githubCalls.length, calls);
  clock += 61_000;
  assert.equal((await call("/v1/session", { method: "POST", token: BO })).status, 201);
});

test("one person who used up their own allowance at GitHub doesn't hold anyone else back", async () => {
  githubAnswers = { status: 403, headers: { "x-ratelimit-remaining": "0" } };
  const own = await call("/v1/session", { method: "POST", token: ADA });
  assert.equal(own.status, 429);
  githubAnswers = null;
  assert.equal((await call("/v1/session", { method: "POST", token: BO })).status, 201);
});

test("one session can't flood the server, and wrong methods get no further", async () => {
  const { token } = await signIn(ADA);
  let last;
  for (let i = 0; i < 241; i++) last = await call(`/v1/orgs/${ACME.id}/overview`, { token });
  assert.equal(last.status, 429);
  assert.equal((await call(`/v1/orgs/${ACME.id}/overview`, { method: "POST", token })).status, 405);
  assert.equal((await call("/v1/session", { method: "GET", token })).status, 405);
});

test("over HTTP: a browser's preflight and sign-in work through the real server", async () => {
  const server = createDataServer(api);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const preflight = await fetch(`${base}/v1/session`, { method: "OPTIONS", headers: { origin: SITE, "access-control-request-method": "POST" } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), SITE);
    const res = await fetch(`${base}/v1/session`, { method: "POST", headers: { origin: SITE, authorization: `Bearer ${BO}` } });
    assert.equal(res.status, 201);
    const { token } = await res.json();
    const page = await fetch(`${base}/v1/orgs/${OTHER.id}/overview`, { headers: { origin: SITE, authorization: `Bearer ${token}` } });
    assert.deepEqual((await page.json()).repos.map((r) => r.name), ["other/vault"]);
    assert.equal((await fetch(`${base}/v1/session`, { method: "DELETE", headers: { origin: SITE, authorization: `Bearer ${token}` } })).status, 204);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
