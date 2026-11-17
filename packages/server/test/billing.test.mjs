// Paddle's messages about what orgs pay for, taken in by a real server with a real database.
// Only Paddle is faked: these tests sign its messages with the destination's secret, as Paddle does.

import assert from "node:assert/strict";
import { createHmac, createSign, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { resetJwksCache } from "../../token-server/dist/token.js";
import { createApi } from "../dist/api.js";
import { checkoutData, parsePaddleConfig, verifyPaddleSignature } from "../dist/billing.js";
import { connectOrg, createPool, deleteOrg, migrate, withOrg } from "../dist/db.js";
import { createDataServer } from "../dist/server.js";
import { startPostgres } from "./postgres.mjs";

const NOW = Date.parse("2026-11-18T09:00:00Z");
const PUBLIC_URL = "https://server.test";
const KID = "billing-kid";
const oidc = generateKeyPairSync("rsa", { modulusLength: 2048 });

const ACME = { id: 1001, login: "acme" };
const OTHER = { id: 2002, login: "other" };

const ENV = {
  PADDLE_ENV: "sandbox",
  // Made up, and put together here so it never looks like a real key to a secret scanner.
  PADDLE_API_KEY: ["pdl", "sdbx", "apikey", "made-up-for-tests"].join("_"),
  PADDLE_WEBHOOK_SECRET: ["pdl", "ntfset", "made-up-for-tests"].join("_"),
  PADDLE_CLIENT_TOKEN: "test_0123456789abcdef0123456789a",
  PADDLE_PRICE_LIGHT: `pri_01${"l".repeat(24)}`,
  PADDLE_PRICE_PRO: `pri_01${"p".repeat(24)}`,
};
const config = parsePaddleConfig(ENV);

let postgres;
let pool;
let api;
let clock;

/** What Paddle does: sign the time and the exact bytes with the destination's secret. */
function signed(body, { secret = ENV.PADDLE_WEBHOOK_SECRET, at = clock } = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const ts = String(Math.floor(at / 1000));
  const h1 = createHmac("sha256", secret).update(`${ts}:${raw}`).digest("hex");
  return { raw, header: `ts=${ts};h1=${h1}` };
}

const send = (body, options = {}) => {
  const { raw, header } = signed(body, options);
  return api(new Request(`${PUBLIC_URL}/v1/billing/paddle`, { method: "POST", headers: { "content-type": "application/json", ...(options.unsigned ? {} : { "paddle-signature": options.header ?? header }) }, body: raw }));
};

const id = (prefix) => `${prefix}_01${randomBytes(12).toString("hex")}`;

/** A subscription message as Paddle sends it, for a checkout the server signed for acme. */
function message({ type = "subscription.created", org = ACME, sub = "sub_01aaaaaaaaaaaaaaaaaaaaaaaa", status = "active", price = ENV.PADDLE_PRICE_PRO, quantity = 3, occurred = clock, custom } = {}) {
  return {
    event_id: id("evt"),
    event_type: type,
    occurred_at: new Date(occurred).toISOString(),
    notification_id: id("ntf"),
    data: {
      id: sub,
      status,
      customer_id: "ctm_01aaaaaaaaaaaaaaaaaaaaaaaa",
      custom_data: custom === undefined ? checkoutData(config, org, clock) : custom,
      items: [{ price: { id: price, product_id: "pro_01aaaaaaaaaaaaaaaaaaaaaaaa" }, status: "active", quantity, recurring: true }],
      current_billing_period: status === "canceled" ? null : { starts_at: new Date(clock).toISOString(), ends_at: new Date(clock + 30 * 86_400_000).toISOString() },
      scheduled_change: null,
    },
  };
}

const billingOf = async (org) => (await withOrg(pool, org.id, async (db) => (await db.query("select plan, seats, status, subscription_id, customer_id from billing")).rows))[0] ?? null;
const orgRow = async (org) => (await withOrg(pool, org.id, async (db) => (await db.query("select login from orgs")).rows))[0] ?? null;

/** A review run's context, as the review program asks for it. */
function runToken(org) {
  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const s = Math.floor(clock / 1000);
  const head = b64({ alg: "RS256", kid: KID });
  const body = b64({ iss: "https://token.actions.githubusercontent.com", aud: PUBLIC_URL, exp: s + 300, nbf: s - 10, jti: randomUUID(), repository: `${org.login}/widgets`, repository_id: "501", repository_owner: org.login, repository_owner_id: String(org.id), run_id: "9001", run_attempt: "1", event_name: "pull_request" });
  const signer = createSign("RSA-SHA256");
  signer.update(`${head}.${body}`);
  return `${head}.${body}.${signer.sign(oidc.privateKey).toString("base64url")}`;
}
const fetchImpl = async (url) => {
  if (String(url).endsWith("/.well-known/jwks")) return new Response(JSON.stringify({ keys: [{ ...oidc.publicKey.export({ format: "jwk" }), kid: KID }] }), { status: 200 });
  throw new Error(`unexpected call to ${url}`);
};
const contextOf = async (org) => (await api(new Request(`${PUBLIC_URL}/v1/context`, { headers: { authorization: `Bearer ${runToken(org)}` } }))).json();

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
  clock = NOW;
  api = createApi({ pool, publicUrl: PUBLIC_URL, paddle: config, fetchImpl, now: () => clock });
  for (const org of [ACME, OTHER]) {
    await deleteOrg(pool, org.id);
    await withOrg(pool, org.id, (db) => db.query("delete from billing"));
  }
});

test("the Paddle settings are all set or none, and a key for the other environment stops the start", () => {
  assert.equal(parsePaddleConfig({}), null);
  assert.deepEqual(config, { env: "sandbox", apiKey: ENV.PADDLE_API_KEY, webhookSecret: ENV.PADDLE_WEBHOOK_SECRET, clientToken: ENV.PADDLE_CLIENT_TOKEN, prices: { light: ENV.PADDLE_PRICE_LIGHT, pro: ENV.PADDLE_PRICE_PRO } });
  assert.throws(() => parsePaddleConfig({ ...ENV, PADDLE_API_KEY: "", PADDLE_PRICE_PRO: " " }), /Missing: PADDLE_API_KEY, PADDLE_PRICE_PRO/);
  assert.throws(() => parsePaddleConfig({ ...ENV, PADDLE_ENV: "test" }), /PADDLE_ENV must be/);
  assert.throws(() => parsePaddleConfig({ ...ENV, PADDLE_API_KEY: "pdl_live_apikey_x" }), /PADDLE_API_KEY is a key for Paddle's live environment/);
  assert.throws(() => parsePaddleConfig({ ...ENV, PADDLE_CLIENT_TOKEN: "live_x" }), /PADDLE_CLIENT_TOKEN is a token for Paddle's live environment/);
  assert.throws(() => parsePaddleConfig({ ...ENV, PADDLE_ENV: "live" }), /PADDLE_API_KEY is a key for Paddle's sandbox environment/);
  assert.throws(() => parsePaddleConfig({ ...ENV, PADDLE_PRICE_LIGHT: "light" }), /must be Paddle price ids/);
  assert.throws(() => parsePaddleConfig({ ...ENV, PADDLE_PRICE_LIGHT: ENV.PADDLE_PRICE_PRO }), /the same price/);
});

test("only Paddle's signature over the exact bytes, made a moment ago, counts", () => {
  const { raw, header } = signed({ hello: "paddle" });
  const bytes = new TextEncoder().encode(raw);
  const secret = ENV.PADDLE_WEBHOOK_SECRET;
  assert.equal(verifyPaddleSignature(header, bytes, secret, clock), true);
  assert.equal(verifyPaddleSignature(header, new TextEncoder().encode(raw + " "), secret, clock), false);
  assert.equal(verifyPaddleSignature(header, bytes, "pdl_ntfset_other", clock), false);
  assert.equal(verifyPaddleSignature(header, bytes, secret, clock + 301_000), false);
  assert.equal(verifyPaddleSignature(header, bytes, secret, clock - 301_000), false);
  // While a secret is replaced, Paddle sends one signature for each: one good one is enough.
  const [ts, h1] = header.split(";");
  assert.equal(verifyPaddleSignature(`${ts};h1=${"0".repeat(64)};${h1}`, bytes, secret, clock), true);
  for (const bad of [null, "", "ts=1", h1, `${ts};h1=xyz`, `${ts};h1=${"0".repeat(64)}`, "x".repeat(2000)]) assert.equal(verifyPaddleSignature(bad, bytes, secret, clock), false, String(bad).slice(0, 20));
});

test("a message without Paddle's signature, or with a wrong one, changes nothing", async () => {
  const body = message();
  assert.equal((await send(body, { unsigned: true })).status, 401);
  assert.equal((await send(body, { secret: "pdl_ntfset_guess" })).status, 401);
  assert.equal((await send(body, { at: clock - 10 * 60_000 })).status, 401);
  assert.equal(await billingOf(ACME), null);
  assert.equal((await api(new Request(`${PUBLIC_URL}/v1/billing/paddle`))).status, 405);
  // A server that sells nothing says so.
  api = createApi({ pool, publicUrl: PUBLIC_URL, fetchImpl, now: () => clock });
  assert.equal((await send(body)).status, 503);
});

test("a subscription from a checkout the server signed turns the dashboard on, with Pro's Jobs", async () => {
  assert.deepEqual(await contextOf(ACME), { connected: false });
  const res = await send(message());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { stored: true });
  assert.deepEqual(await billingOf(ACME), { plan: "pro", seats: 3, status: "active", subscription_id: "sub_01aaaaaaaaaaaaaaaaaaaaaaaa", customer_id: "ctm_01aaaaaaaaaaaaaaaaaaaaaaaa" });
  assert.deepEqual(await orgRow(ACME), { login: "acme" });
  const context = await contextOf(ACME);
  assert.equal(context.connected, true);
  assert.equal(context.jobs, true);
});

test("the same message twice counts once", async () => {
  const body = message({ quantity: 3 });
  assert.equal((await (await send(body)).json()).stored, true);
  // Changed by hand afterwards, so a second take of the same message would show.
  await withOrg(pool, ACME.id, (db) => db.query("update billing set seats = 9"));
  assert.deepEqual(await (await send(body)).json(), { skipped: "seen before" });
  assert.equal((await billingOf(ACME)).seats, 9);
});

test("a message skipped for a reason a person can fix counts when Paddle sends it again", async () => {
  const body = message({ custom: checkoutData(config, ACME, clock - 8 * 86_400_000) });
  assert.deepEqual(await (await send(body)).json(), { skipped: "not from a checkout the server signed" });
  // Fixed by hand: the subscription is put on file, and Paddle's "send again" now counts.
  await withOrg(pool, ACME.id, (db) => db.query("insert into billing (org_id, provider, subscription_id, plan, seats, status) values ($1, 'paddle', $2, 'light', 1, 'canceled')", [ACME.id, body.data.id]));
  assert.deepEqual(await (await send(body)).json(), { stored: true });
  assert.equal((await billingOf(ACME)).plan, "pro");
});

test("custom data the server didn't sign, or signed too long ago, can't start a subscription for an org", async () => {
  const forged = { ...checkoutData(config, ACME, clock), sig: "0".repeat(64) };
  const other = { ...checkoutData(config, OTHER, clock), org_id: String(ACME.id), org_login: "acme" };
  const { sig: _, ...unsigned } = checkoutData(config, ACME, clock);
  for (const custom of [forged, other, unsigned, null, { org_id: "1001" }]) {
    const res = await send(message({ custom }));
    assert.equal(res.status, 200);
    assert.match((await res.json()).skipped, /not from a checkout the server signed|no org/);
  }
  const old = checkoutData(config, ACME, clock - 8 * 86_400_000);
  assert.deepEqual(await (await send(message({ custom: old }))).json(), { skipped: "not from a checkout the server signed" });
  assert.equal(await billingOf(ACME), null);
  assert.equal(await orgRow(ACME), null);
});

test("later messages about a known subscription need no fresh signature, and an older one changes nothing", async () => {
  await send(message({ quantity: 3 }));
  // A month later the checkout's signature ran out, and the subscription's messages still count.
  const stale = checkoutData(config, ACME, clock);
  clock += 40 * 86_400_000;
  assert.equal((await (await send(message({ type: "subscription.updated", quantity: 5, custom: stale }))).json()).stored, true);
  assert.equal((await billingOf(ACME)).seats, 5);
  // Paddle's messages can arrive out of order.
  const late = message({ type: "subscription.updated", quantity: 4, custom: stale, occurred: clock - 60_000 });
  assert.deepEqual(await (await send(late)).json(), { skipped: "older than the one on file" });
  assert.equal((await billingOf(ACME)).seats, 5);
  // Light instead of Pro: the dashboard stays, Jobs goes.
  assert.equal((await (await send(message({ type: "subscription.updated", price: ENV.PADDLE_PRICE_LIGHT, custom: stale }))).json()).stored, true);
  const context = await contextOf(ACME);
  assert.equal(context.connected, true);
  assert.equal(context.jobs, false);
});

test("a subscription on a price the settings no longer list keeps its plan, and its cancellation still counts", async () => {
  const OLD = `pri_01${"o".repeat(24)}`;
  // A new subscription on a price this server doesn't sell is skipped.
  assert.deepEqual(await (await send(message({ price: OLD }))).json(), { skipped: "no Mergelight price" });
  await send(message());
  assert.equal((await (await send(message({ type: "subscription.updated", price: OLD, quantity: 4, occurred: clock + 1000 }))).json()).stored, true);
  assert.deepEqual([(await billingOf(ACME)).plan, (await billingOf(ACME)).seats], ["pro", 4]);
  assert.equal((await (await send(message({ type: "subscription.canceled", price: OLD, status: "canceled", occurred: clock + 2000 }))).json()).stored, true);
  assert.deepEqual([(await billingOf(ACME)).plan, (await billingOf(ACME)).status], ["pro", "canceled"]);
});

test("a canceled subscription turns the dashboard off and keeps the data, and a new checkout turns it on again", async () => {
  await send(message());
  await send(message({ type: "subscription.canceled", status: "canceled", occurred: clock + 1000 }));
  assert.equal((await billingOf(ACME)).status, "canceled");
  assert.deepEqual(await contextOf(ACME), { connected: false, plan_ended: true });
  assert.deepEqual(await orgRow(ACME), { login: "acme" });
  clock += 86_400_000;
  assert.equal((await (await send(message({ sub: "sub_01bbbbbbbbbbbbbbbbbbbbbbbb", price: ENV.PADDLE_PRICE_LIGHT }))).json()).stored, true);
  assert.deepEqual(await billingOf(ACME), { plan: "light", seats: 3, status: "active", subscription_id: "sub_01bbbbbbbbbbbbbbbbbbbbbbbb", customer_id: "ctm_01aaaaaaaaaaaaaaaaaaaaaaaa" });
  assert.equal((await contextOf(ACME)).connected, true);
});

test("a second subscription doesn't replace one that still works", async () => {
  await send(message());
  const res = await send(message({ sub: "sub_01cccccccccccccccccccccccc", price: ENV.PADDLE_PRICE_LIGHT, quantity: 1 }));
  assert.deepEqual(await res.json(), { skipped: "the org already has a working subscription" });
  assert.deepEqual(await billingOf(ACME), { plan: "pro", seats: 3, status: "active", subscription_id: "sub_01aaaaaaaaaaaaaaaaaaaaaaaa", customer_id: "ctm_01aaaaaaaaaaaaaaaaaaaaaaaa" });
});

test("a subscription already on file for another org isn't moved", async () => {
  await send(message());
  const res = await send(message({ org: OTHER }));
  assert.deepEqual(await res.json(), { skipped: "the subscription belongs to another org" });
  assert.equal(await billingOf(OTHER), null);
  assert.equal((await billingOf(ACME)).status, "active");
});

test("messages that aren't about a Mergelight subscription are taken and skipped", async () => {
  assert.deepEqual(await (await send({ event_id: id("evt"), event_type: "transaction.completed", occurred_at: new Date(clock).toISOString(), data: {} })).json(), { skipped: "not about a subscription" });
  assert.deepEqual(await (await send(message({ price: "pri_01someotherproductprice00" }))).json(), { skipped: "no Mergelight price" });
  assert.deepEqual(await (await send(message({ quantity: 0 }))).json(), { skipped: "bad quantity" });
  assert.equal((await send("not json")).status, 400);
  assert.equal((await send({ event_type: "subscription.created" })).status, 400);
  assert.equal(await billingOf(ACME), null);
});

test("the list of messages seen is out of reach of everything but a signed payment message", async () => {
  const body = message();
  await send(body);
  assert.deepEqual(await withOrg(pool, ACME.id, async (db) => (await db.query("select * from billing_events")).rows), []);
  await assert.rejects(withOrg(pool, ACME.id, (db) => db.query("insert into billing_events (event_id) values ('evt_01made_up')")), /row-level security/);
  const seen = await withOrg(pool, ACME.id, async (db) => {
    await db.query("select set_config('mergelight.billing', 'on', true)");
    return (await db.query("select count(*)::int as n from billing_events where event_id = $1", [body.event_id])).rows[0].n;
  });
  assert.equal(seen, 1);
});

test("over HTTP: Paddle's signature header reaches the check", async () => {
  const server = createDataServer(api);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { raw, header } = signed(message());
    const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/billing/paddle`, { method: "POST", headers: { "content-type": "application/json", "paddle-signature": header }, body: raw });
    assert.equal(res.status, 200);
    assert.equal((await billingOf(ACME)).plan, "pro");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
