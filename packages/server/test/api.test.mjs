import assert from "node:assert/strict";
import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import pg from "pg";
import { handle as tokenServer, resetJwksCache } from "../../token-server/src/token.js";
import { AUDIENCE, createApi, MAX_BODY, parseReview } from "../src/api.js";
import { assertRowRulesHold, connectOrg, createPool, deleteOrg, migrate, withOrg } from "../src/db.js";
import { createDataServer } from "../src/server.js";
import { startPostgres } from "./postgres.mjs";

const NOW = Date.parse("2026-11-10T12:00:00Z");
const SECONDS = Math.floor(NOW / 1000);
const ISSUER = "https://token.actions.githubusercontent.com";
const KID = "test-kid";
const oidc = generateKeyPairSync("rsa", { modulusLength: 2048 });
const attacker = generateKeyPairSync("rsa", { modulusLength: 2048 });

const ACME = { id: 1001, login: "acme" };
const OTHER = { id: 2002, login: "other" };

const b64 = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

/** A token as GitHub signs it for a pull request run in acme/widgets. */
function makeToken(claims = {}, { key = oidc.privateKey } = {}) {
  const head = b64({ alg: "RS256", kid: KID });
  const body = b64({
    iss: ISSUER,
    aud: AUDIENCE,
    exp: SECONDS + 300,
    nbf: SECONDS - 10,
    jti: randomUUID(),
    repository: "acme/widgets",
    repository_id: "501",
    repository_owner: "acme",
    repository_owner_id: String(ACME.id),
    run_id: "9001",
    run_attempt: "1",
    event_name: "pull_request",
    ...claims,
  });
  const signer = createSign("RSA-SHA256");
  signer.update(`${head}.${body}`);
  return `${head}.${body}.${signer.sign(key).toString("base64url")}`;
}

/** The only outside call the server makes: GitHub's public signing keys. */
const fetchImpl = async (url) => {
  if (String(url).endsWith("/.well-known/jwks")) {
    return new Response(JSON.stringify({ keys: [{ ...oidc.publicKey.export({ format: "jwk" }), kid: KID }] }), { status: 200 });
  }
  throw new Error(`unexpected call to ${url}`);
};

const REVIEW = {
  pr: 42,
  sha: "a".repeat(40),
  light: "yellow",
  counts: { bug: 2, risk: 1, hardening: 3 },
  tiers: { post: 2, list: 1, decision: 0 },
  major: 1,
  provider: "claude",
  model: "opus",
  verifier: "claude",
  duration_ms: 412_000,
  files_changed: 7,
  additions: 120,
  deletions: 14,
};

let postgres;
let pool;
let api;

const get = (token) => api(new Request("https://server.test/v1/context", { headers: token ? { authorization: `Bearer ${token}` } : {} }));
const post = (token, body = REVIEW) =>
  api(new Request("https://server.test/v1/reviews", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }));
const rowsOf = (orgId, sql) => withOrg(pool, orgId, async (db) => (await db.query(sql)).rows);

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
  api = createApi({ pool, fetchImpl, now: () => NOW });
  for (const org of [ACME, OTHER]) await deleteOrg(pool, org.id);
});

test("migrations apply once, and a second run changes nothing", async () => {
  await migrate(pool);
  const { rows } = await pool.query("select name from schema_migrations");
  assert.deepEqual(rows.map((r) => r.name), ["001_base.sql"]);
});

test("the server's own role can't bypass the row rules, and a superuser is refused", async () => {
  await assertRowRulesHold(pool);
  const superuser = new pg.Pool({ connectionString: postgres.adminUrl });
  try {
    await assert.rejects(assertRowRulesHold(superuser), /bypass row-level security/);
  } finally {
    await superuser.end();
  }
});

test("an org that hasn't turned the dashboard on gets connected: false, and nothing is stored for it", async () => {
  assert.deepEqual(await (await get(makeToken())).json(), { connected: false });
  const res = await post(makeToken());
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, "not_connected");
  assert.deepEqual(await rowsOf(ACME.id, "select * from repos"), []);
  assert.deepEqual(await rowsOf(ACME.id, "select * from reviews"), []);
});

test("a connected org's review is stored with the repository and run from the signed token", async () => {
  await connectOrg(pool, ACME.id, ACME.login);
  assert.deepEqual(await (await get(makeToken())).json(), { connected: true });

  const res = await post(makeToken());
  assert.equal(res.status, 201);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(await res.json(), { stored: true });

  const [repo] = await rowsOf(ACME.id, "select org_id, id, name from repos");
  assert.deepEqual(repo, { org_id: "1001", id: "501", name: "acme/widgets" });
  const [review] = await rowsOf(ACME.id, "select * from reviews");
  assert.equal(review.repo_id, "501");
  assert.equal(review.run_id, "9001");
  assert.equal(review.pr, 42);
  assert.equal(review.light, "yellow");
  assert.deepEqual([review.bugs, review.risks, review.hardening, review.major], [2, 1, 3, 1]);
  assert.deepEqual([review.inline, review.listed, review.decisions], [2, 1, 0]);
  assert.deepEqual([review.provider, review.model, review.verifier], ["claude", "opus", "claude"]);
});

test("the body can't choose the org or the repository", async () => {
  await connectOrg(pool, ACME.id, ACME.login);
  await connectOrg(pool, OTHER.id, OTHER.login);
  const res = await post(makeToken(), { ...REVIEW, org_id: OTHER.id, repo_id: 777, repository: "other/secret", repository_owner_id: String(OTHER.id) });
  assert.equal(res.status, 201);
  assert.deepEqual(await rowsOf(OTHER.id, "select * from reviews"), []);
  assert.deepEqual(await rowsOf(OTHER.id, "select * from repos"), []);
  assert.equal((await rowsOf(ACME.id, "select repo_id from reviews"))[0].repo_id, "501");
});

test("the same run can't count twice, and a new attempt counts once more", async () => {
  await connectOrg(pool, ACME.id, ACME.login);
  assert.equal((await post(makeToken())).status, 201);
  const again = await post(makeToken());
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { stored: false });
  assert.equal((await post(makeToken({ run_attempt: "2" }))).status, 201);
  assert.equal((await rowsOf(ACME.id, "select 1 from reviews")).length, 2);
});

test("a token works once", async () => {
  await connectOrg(pool, ACME.id, ACME.login);
  const token = makeToken();
  assert.equal((await get(token)).status, 200);
  const replay = await get(token);
  assert.equal(replay.status, 401);
  assert.equal((await replay.json()).error, "token_used");
});

test("tokens that don't prove a pull request run in a repository are refused", async () => {
  await connectOrg(pool, ACME.id, ACME.login);
  const cases = {
    "no token": [undefined, 401],
    "not a token": ["not-a-jwt", 401],
    "signed by someone else": [makeToken({}, { key: attacker.privateKey }), 401],
    "made for the token server": [makeToken({ aud: "mergelight" }), 401],
    "made for another service": [makeToken({ aud: "sts.amazonaws.com" }), 401],
    "expired": [makeToken({ exp: SECONDS - 120 }), 401],
    "from a scheduled run": [makeToken({ event_name: "schedule" }), 403],
    "from a manual run": [makeToken({ event_name: "workflow_dispatch" }), 403],
    "no owner id": [makeToken({ repository_owner_id: undefined }), 401],
    "owner id that isn't a number": [makeToken({ repository_owner_id: "1001 or 1=1" }), 401],
    "owner id of zero": [makeToken({ repository_owner_id: "0" }), 401],
    "no repository id": [makeToken({ repository_id: undefined }), 401],
    "no token id": [makeToken({ jti: undefined }), 401],
    "no run": [makeToken({ run_id: undefined }), 401],
    "odd repository name": [makeToken({ repository: "acme/widgets/../x" }), 401],
  };
  for (const [name, [token, status]] of Object.entries(cases)) {
    assert.equal((await get(token)).status, status, name);
    if (token) assert.equal((await post(token)).status, status, `${name}, on a write`);
  }
  assert.deepEqual(await rowsOf(ACME.id, "select * from reviews"), []);
});

test("a token made for this server gets nothing from the token server", async () => {
  const res = await tokenServer(
    new Request("https://token.test/token", { method: "POST", headers: { authorization: `Bearer ${makeToken()}` } }),
    { GITHUB_APP_CLIENT_ID: "Iv23-test", GITHUB_APP_PRIVATE_KEY: "unused" },
    fetchImpl,
    NOW,
  );
  assert.equal(res.status, 401);
  assert.match((await res.json()).message, /wrong audience/);
});

test("one org can't read or write another org's rows, even with SQL that asks for them", async () => {
  await connectOrg(pool, ACME.id, ACME.login);
  await connectOrg(pool, OTHER.id, OTHER.login);
  assert.equal((await post(makeToken())).status, 201);
  assert.equal((await post(makeToken({ repository: "other/vault", repository_id: "777", repository_owner: "other", repository_owner_id: String(OTHER.id) }))).status, 201);

  // Each org sees its own rows only, with no filter in the query at all.
  assert.deepEqual((await rowsOf(ACME.id, "select name from repos")).map((r) => r.name), ["acme/widgets"]);
  assert.deepEqual((await rowsOf(OTHER.id, "select name from repos")).map((r) => r.name), ["other/vault"]);
  assert.deepEqual((await rowsOf(ACME.id, "select login from orgs")).map((r) => r.login), ["acme"]);

  // Asking for the other org by id finds nothing, and writes to it change nothing or are refused.
  assert.deepEqual(await rowsOf(ACME.id, `select * from reviews where org_id = ${OTHER.id}`), []);
  assert.equal(await withOrg(pool, ACME.id, async (db) => (await db.query(`update reviews set light = 'green' where org_id = ${OTHER.id}`)).rowCount), 0);
  assert.equal(await withOrg(pool, ACME.id, async (db) => (await db.query(`delete from orgs where id = ${OTHER.id}`)).rowCount), 0);
  await assert.rejects(
    withOrg(pool, ACME.id, (db) => db.query(`insert into repos (org_id, id, name) values (${OTHER.id}, 888, 'other/planted')`)),
    /row-level security/,
  );
  await assert.rejects(
    withOrg(pool, ACME.id, (db) => db.query(`update repos set org_id = ${OTHER.id} where id = 501`)),
    /row-level security/,
  );
  assert.equal((await rowsOf(OTHER.id, "select light from reviews"))[0].light, "yellow");
  assert.equal((await rowsOf(OTHER.id, "select 1 from repos")).length, 1);
});

test("a query that names no org sees nothing, and the org doesn't leak to the next query on the connection", async () => {
  await connectOrg(pool, ACME.id, ACME.login);
  assert.equal((await post(makeToken())).status, 201);
  const one = new pg.Pool({ connectionString: postgres.url, max: 1 });
  try {
    assert.equal((await withOrg(one, ACME.id, (db) => db.query("select 1 from reviews"))).rowCount, 1);
    // Same connection, straight after, without naming an org.
    for (const table of ["orgs", "repos", "reviews"]) assert.equal((await one.query(`select 1 from ${table}`)).rowCount, 0, table);
    await assert.rejects(one.query("insert into orgs (id, login) values (3003, 'nobody')"), /row-level security/);
  } finally {
    await one.end();
  }
});

test("withOrg refuses anything that isn't a GitHub account id", async () => {
  for (const bad of [undefined, null, 0, -1, 1.5, "1001", NaN, Infinity]) {
    await assert.rejects(withOrg(pool, bad, () => assert.fail("must not run")), /needs a GitHub account id/);
  }
});

test("deleting an org removes its repositories and reviews, and leaves other orgs alone", async () => {
  await connectOrg(pool, ACME.id, ACME.login);
  await connectOrg(pool, OTHER.id, OTHER.login);
  assert.equal((await post(makeToken())).status, 201);
  assert.equal((await post(makeToken({ repository: "other/vault", repository_id: "777", repository_owner_id: String(OTHER.id) }))).status, 201);

  assert.equal(await deleteOrg(pool, ACME.id), true);
  assert.equal(await deleteOrg(pool, ACME.id), false);
  for (const table of ["orgs", "repos", "reviews"]) assert.deepEqual(await rowsOf(ACME.id, `select * from ${table}`), [], table);
  assert.equal((await rowsOf(OTHER.id, "select 1 from reviews")).length, 1);
  assert.deepEqual(await (await get(makeToken())).json(), { connected: false });
});

test("a repository that moved to another account starts fresh there", async () => {
  await connectOrg(pool, ACME.id, ACME.login);
  await connectOrg(pool, OTHER.id, OTHER.login);
  assert.equal((await post(makeToken())).status, 201);
  const moved = makeToken({ repository: "other/widgets", repository_owner: "other", repository_owner_id: String(OTHER.id), run_id: "9002" });
  assert.equal((await post(moved)).status, 201);
  assert.equal((await rowsOf(ACME.id, "select 1 from reviews")).length, 1);
  assert.deepEqual((await rowsOf(OTHER.id, "select name from repos")).map((r) => r.name), ["other/widgets"]);
});

test("a review that isn't plain numbers is refused, and nothing is stored", async () => {
  await connectOrg(pool, ACME.id, ACME.login);
  const bad = [
    "not json",
    "[]",
    { ...REVIEW, pr: 0 },
    { ...REVIEW, pr: "42" },
    { ...REVIEW, sha: "HEAD" },
    { ...REVIEW, light: "blue" },
    { ...REVIEW, counts: { bug: -1, risk: 0, hardening: 0 } },
    { ...REVIEW, counts: { bug: 1.5, risk: 0, hardening: 0 } },
    { ...REVIEW, counts: undefined },
    { ...REVIEW, tiers: { post: 1 } },
    { ...REVIEW, major: 1e9 },
    { ...REVIEW, provider: "gemini" },
    { ...REVIEW, model: "opus'; drop table reviews; --" },
    { ...REVIEW, model: "x".repeat(101) },
    { ...REVIEW, verifier: "someone" },
    { ...REVIEW, duration_ms: -5 },
    { ...REVIEW, additions: 2 ** 31 },
  ];
  for (const body of bad) {
    const res = await post(makeToken(), body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal((await res.json()).error, "bad_request");
  }
  const tooLarge = await post(makeToken(), JSON.stringify({ ...REVIEW, padding: "x".repeat(MAX_BODY) }));
  assert.equal(tooLarge.status, 413);
  assert.deepEqual(await rowsOf(ACME.id, "select * from reviews"), []);
});

test("parseReview keeps only the fields it knows, and a missing model is fine", () => {
  const parsed = parseReview({ ...REVIEW, model: null, verifier: undefined, note: "ignore me", title: "secret code" });
  assert.deepEqual(Object.keys(parsed).sort(), ["additions", "bugs", "decisions", "deletions", "duration_ms", "files_changed", "hardening", "inline", "light", "listed", "major", "model", "pr", "provider", "risks", "sha", "verifier"]);
  assert.equal(parsed.model, null);
  assert.equal(parsed.verifier, null);
});

test("an org that sends too many requests in a minute is slowed down, and other orgs aren't", async () => {
  await connectOrg(pool, ACME.id, ACME.login);
  let last;
  for (let i = 0; i < 121; i++) last = await get(makeToken());
  assert.equal(last.status, 429);
  assert.equal((await get(makeToken({ repository_owner_id: String(OTHER.id) }))).status, 200);
});

test("unknown paths and wrong methods get no further", async () => {
  assert.equal((await api(new Request("https://server.test/"))).status, 200);
  assert.equal((await api(new Request("https://server.test/v1/orgs"))).status, 404);
  assert.equal((await api(new Request("https://server.test/v1/context", { method: "POST" }))).status, 405);
  assert.equal((await api(new Request("https://server.test/v1/reviews"))).status, 405);
});

test("over HTTP: a real request is answered, and an oversized body never reaches the handler", async () => {
  await connectOrg(pool, ACME.id, ACME.login);
  const server = createDataServer(api);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ok = await fetch(`${base}/v1/reviews`, { method: "POST", headers: { authorization: `Bearer ${makeToken()}`, "content-type": "application/json" }, body: JSON.stringify(REVIEW) });
    assert.equal(ok.status, 201);
    const big = await fetch(`${base}/v1/reviews`, { method: "POST", headers: { authorization: `Bearer ${makeToken({ run_id: "9003" })}` }, body: "x".repeat(MAX_BODY + 1) });
    assert.equal(big.status, 400);
    assert.equal((await rowsOf(ACME.id, "select 1 from reviews")).length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
