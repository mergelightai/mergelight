// Payments, through Paddle. Paddle is the seller: it runs the checkout, takes the money and files the
// taxes. It tells this server what each org pays for in messages (webhooks) to POST /v1/billing/paddle,
// and this file keeps one row per org in billing (migrations/007_billing.sql). plan.ts reads that row.
//
// A message counts only with Paddle's signature: an HMAC of its time and its exact bytes, made with the
// secret of the notification destination. A message stored before is dropped (billing_events).
//
// Which org a subscription is for comes from the checkout's custom data, and the buyer's browser sends
// that. So the server signs it when an owner of the org asks to buy (checkoutData), and a new
// subscription counts only with a signature that hasn't run out. Paddle copies the custom data onto the
// subscription, so its later messages carry the same data, and need no fresh signature once the server
// knows the subscription.

import { createHmac, timingSafeEqual } from "node:crypto";
import { HttpError } from "../../token-server/dist/token.js";
import { isId, withOrg, type Pool } from "./db.js";
import { WORKING, type PlanName } from "./plan.js";

export interface PaddleConfig {
  env: "sandbox" | "live";
  /** For Paddle's API: changing seats, and the customer portal. It never leaves the server. */
  apiKey: string;
  /** The notification destination's secret. Paddle signs each message with it. */
  webhookSecret: string;
  /** For Paddle.js on the dashboard page. Paddle made it to be public. */
  clientToken: string;
  /** Paddle's price for each plan, per developer a month. */
  prices: Record<PlanName, string>;
}

const SETTINGS = ["PADDLE_ENV", "PADDLE_API_KEY", "PADDLE_WEBHOOK_SECRET", "PADDLE_CLIENT_TOKEN", "PADDLE_PRICE_LIGHT", "PADDLE_PRICE_PRO"] as const;
const PRICE = /^pri_[a-z0-9]{26}$/;

/**
 * Payments from the server's settings, or null when none are set. Some set and some not stops the
 * start, as does a key for the other Paddle environment, so a mistake shows at once and not at the first sale.
 */
export function parsePaddleConfig(env: Record<string, string | undefined>): PaddleConfig | null {
  const value = (name: (typeof SETTINGS)[number]) => env[name]?.trim() ?? "";
  const missing = SETTINGS.filter((name) => !value(name));
  if (missing.length === SETTINGS.length) return null;
  if (missing.length) throw new Error(`Payments need all of ${SETTINGS.join(", ")}. Missing: ${missing.join(", ")}.`);
  const mode = value("PADDLE_ENV");
  if (mode !== "sandbox" && mode !== "live") throw new Error('PADDLE_ENV must be "sandbox" or "live".');
  const other = mode === "sandbox" ? "live" : "sandbox";
  // Paddle's keys and tokens say which environment they are for.
  if (value("PADDLE_API_KEY").startsWith(mode === "sandbox" ? "pdl_live_" : "pdl_sdbx_")) throw new Error(`PADDLE_API_KEY is a key for Paddle's ${other} environment, and PADDLE_ENV is ${mode}.`);
  if (value("PADDLE_CLIENT_TOKEN").startsWith(mode === "sandbox" ? "live_" : "test_")) throw new Error(`PADDLE_CLIENT_TOKEN is a token for Paddle's ${other} environment, and PADDLE_ENV is ${mode}.`);
  const light = value("PADDLE_PRICE_LIGHT");
  const pro = value("PADDLE_PRICE_PRO");
  if (!PRICE.test(light) || !PRICE.test(pro)) throw new Error("PADDLE_PRICE_LIGHT and PADDLE_PRICE_PRO must be Paddle price ids, like pri_01gsz8x8sawmvhz1pv30nge1ke.");
  if (light === pro) throw new Error("PADDLE_PRICE_LIGHT and PADDLE_PRICE_PRO are the same price.");
  return { env: mode, apiKey: value("PADDLE_API_KEY"), webhookSecret: value("PADDLE_WEBHOOK_SECRET"), clientToken: value("PADDLE_CLIENT_TOKEN"), prices: { light, pro } };
}

/** How far Paddle's clock may be from this server's. A copied message is refused after this, and before it by its id. */
const SIGNATURE_TOLERANCE_S = 300;

/** Whether the Paddle-Signature header ("ts=<seconds>;h1=<hex>", with more than one h1 while a secret is replaced) signs these exact bytes. */
export function verifyPaddleSignature(header: string | null, raw: Uint8Array, secret: string, at: number): boolean {
  if (!header || header.length > 1000) return false;
  let ts: string | null = null;
  const signatures: Buffer[] = [];
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "ts" && /^\d{1,12}$/.test(value)) ts = value;
    else if (key === "h1" && /^[0-9a-f]{64}$/.test(value)) signatures.push(Buffer.from(value, "hex"));
  }
  if (ts === null || !signatures.length) return false;
  if (Math.abs(at / 1000 - Number(ts)) > SIGNATURE_TOLERANCE_S) return false;
  const expected = createHmac("sha256", secret).update(`${ts}:`).update(raw).digest();
  return signatures.some((s) => timingSafeEqual(s, expected));
}

/** How long a checkout the server signed can start a subscription. Paddle tries a message again for days if this server is down. */
const CHECKOUT_DAYS = 7;

/** The server's own signature on a checkout's custom data. Its words differ from Paddle's, which start with a time, so neither can stand for the other. */
const signCheckout = (config: PaddleConfig, orgId: string, login: string, expires: string) =>
  createHmac("sha256", config.webhookSecret).update(`mergelight-checkout:${orgId}:${login}:${expires}`).digest("hex");

/** The custom data for a checkout an owner of the org asked for. The dashboard hands it to Paddle.js as it is. */
export function checkoutData(config: PaddleConfig, org: { id: number; login: string }, at: number): Record<string, string> {
  const orgId = String(org.id);
  const expires = String(Math.floor(at / 1000) + CHECKOUT_DAYS * 24 * 60 * 60);
  return { org_id: orgId, org_login: org.login, expires, sig: signCheckout(config, orgId, org.login, expires) };
}

/** The org a subscription's custom data names, and whether the server's signature on it still holds. */
function orgOf(config: PaddleConfig, custom: unknown, at: number): { id: number; login: string; signed: boolean } | null {
  if (typeof custom !== "object" || custom === null) return null;
  const { org_id, org_login, expires, sig } = custom as Record<string, unknown>;
  const id = typeof org_id === "string" && /^\d{1,18}$/.test(org_id) ? Number(org_id) : NaN;
  if (!isId(id) || typeof org_login !== "string" || !/^[\w.-]{1,100}$/.test(org_login)) return null;
  let signed = false;
  if (typeof expires === "string" && /^\d{1,12}$/.test(expires) && typeof sig === "string" && /^[0-9a-f]{64}$/.test(sig)) {
    const good = timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(signCheckout(config, org_id as string, org_login, expires), "hex"));
    signed = good && Number(expires) * 1000 >= at;
  }
  return { id, login: org_login, signed };
}

const STATUSES = new Set(["active", "trialing", "past_due", "paused", "canceled"]);

export interface Subscription {
  id: string;
  customerId: string | null;
  status: string;
  /** Null for a price the settings don't list (any more): the plan on file then stays. */
  plan: PlanName | null;
  seats: number;
  periodEnd: string | null;
}

/** The parts of Paddle's subscription this server keeps, or why it can't keep it. */
export function readSubscription(config: PaddleConfig, data: Record<string, unknown>): Subscription | string {
  const { id, customer_id, status, items, current_billing_period } = data;
  if (typeof id !== "string" || !/^sub_[a-z0-9]{10,40}$/.test(id)) return "no subscription id";
  if (typeof status !== "string" || !STATUSES.has(status)) return "unknown status";
  const list = Array.isArray(items) ? (items as Record<string, unknown>[]) : [];
  const priceOf = (i: Record<string, unknown> | undefined) => (i?.price as { id?: unknown } | undefined)?.id;
  // A price the settings list, or else the one item a subscription has: a price changed in the settings since
  // must not leave its subscribers' messages unread, cancellations included.
  const item = list.find((i) => priceOf(i) === config.prices.light || priceOf(i) === config.prices.pro) ?? (list.length === 1 ? list[0] : undefined);
  if (!item) return "no Mergelight price";
  const plan: PlanName | null = priceOf(item) === config.prices.pro ? "pro" : priceOf(item) === config.prices.light ? "light" : null;
  const seats = item.quantity;
  if (typeof seats !== "number" || !Number.isInteger(seats) || seats < 1 || seats > 10_000) return "bad quantity";
  const ends = (current_billing_period as { ends_at?: unknown } | null | undefined)?.ends_at;
  const periodEnd = typeof ends === "string" && Number.isFinite(Date.parse(ends)) ? new Date(Date.parse(ends)).toISOString() : null;
  const customerId = typeof customer_id === "string" && /^ctm_[a-z0-9]{10,40}$/.test(customer_id) ? customer_id : null;
  return { id, customerId, status, plan, seats, periodEnd };
}

/** The largest message taken in. Paddle's subscription messages are a few kilobytes. */
const MAX_EVENT = 65_536;

export interface BillingWebhookOptions {
  pool: Pool;
  config: PaddleConfig | null;
  now: () => number;
}

/** Takes in one message from Paddle. It answers 200 for one it chose to skip, so Paddle doesn't send it again; a 5xx makes Paddle try again later. */
export function createPaddleWebhook({ pool, config, now }: BillingWebhookOptions): (request: Request) => Promise<{ status: number; body: unknown }> {
  return async function take(request: Request) {
    if (!config) throw new HttpError(503, "billing_not_set_up", "Payments aren't set up on this server.");
    const raw = new Uint8Array(await request.arrayBuffer());
    if (raw.length > MAX_EVENT) throw new HttpError(413, "too_large", "The message is too large.");
    const at = now();
    if (!verifyPaddleSignature(request.headers.get("paddle-signature"), raw, config.webhookSecret, at)) {
      throw new HttpError(401, "bad_signature", "The message isn't signed by Paddle for this server.");
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(Buffer.from(raw).toString("utf8")) as Record<string, unknown>;
    } catch {
      throw new HttpError(400, "bad_request", "The message isn't JSON.");
    }
    const { event_id, event_type, occurred_at, data } = event ?? {};
    const occurred = typeof occurred_at === "string" ? Date.parse(occurred_at) : NaN;
    if (typeof event_id !== "string" || !/^evt_[a-z0-9]{10,40}$/.test(event_id) || typeof event_type !== "string" || !Number.isFinite(occurred)) {
      throw new HttpError(400, "bad_request", "The message has no id, kind or time.");
    }
    const skip = (why: string) => {
      // The log names the message and the reason, never the customer.
      console.log("billing: skipped", event_id, event_type, why);
      return { status: 200, body: { skipped: why } };
    };
    // Every subscription message carries the whole subscription, so these are all the server needs.
    if (!event_type.startsWith("subscription.")) return skip("not about a subscription");
    if (typeof data !== "object" || data === null) return skip("no subscription");
    const sub = readSubscription(config, data as Record<string, unknown>);
    if (typeof sub === "string") return skip(sub);
    const org = orgOf(config, (data as Record<string, unknown>).custom_data, at);
    if (!org) return skip("no org in the custom data");

    let outcome: string;
    try {
      outcome = await withOrg(pool, org.id, async (db) => {
        const { rows } = await db.query<{ subscription_id: string | null; status: string; event_at: Date | null; plan: PlanName }>(
          "select subscription_id, status, event_at, plan from billing where org_id = $1 for update",
          [org.id],
        );
        const current = rows[0];
        if (current?.subscription_id !== sub.id) {
          // A new subscription must be for one of the plans this server sells now.
          if (!sub.plan) return "no Mergelight price";
          // A subscription the server doesn't know yet counts only from a checkout it signed for an owner of the org.
          if (!org.signed) return "not from a checkout the server signed";
          // A second subscription doesn't replace one that still works. The org would pay twice: a person sorts it out.
          if (current && WORKING.has(current.status)) return "the org already has a working subscription";
        } else if (current.event_at && current.event_at.getTime() > occurred) {
          // Paddle's messages can arrive out of order. One older than what is on file changes nothing.
          return "older than the one on file";
        }
        // Only a message that is stored counts as seen. One skipped for a reason a person can fix, such as
        // a setting, can then be sent again from Paddle once it is fixed.
        await db.query("select set_config('mergelight.billing', 'on', true)");
        if (!(await db.query("insert into billing_events (event_id) values ($1) on conflict do nothing", [event_id])).rowCount) return "seen before";
        await db.query(
          `insert into billing (org_id, provider, customer_id, subscription_id, plan, seats, status, current_period_end, event_at, updated_at)
           values ($1, 'paddle', $2, $3, $4, $5, $6, $7, $8, now())
           on conflict (org_id) do update
             set provider = excluded.provider, customer_id = excluded.customer_id, subscription_id = excluded.subscription_id, plan = excluded.plan,
                 seats = excluded.seats, status = excluded.status, current_period_end = excluded.current_period_end, event_at = excluded.event_at, updated_at = now()`,
          // A known subscription on a price the settings no longer list keeps the plan on file.
          [org.id, sub.customerId, sub.id, sub.plan ?? current!.plan, sub.seats, sub.status, sub.periodEnd, new Date(occurred).toISOString()],
        );
        // A plan that works turns the dashboard on: from now on the org's runs are stored here.
        // It is marked for the free plan on public repositories too, so those stay on by themselves when the paid plan ends.
        if (WORKING.has(sub.status)) await db.query("insert into orgs (id, login, public_only) values ($1, $2, true) on conflict (id) do update set public_only = true", [org.id, org.login]);
        return "stored";
      });
    } catch (err) {
      // The subscription is on file for another org. Only a change made by hand in Paddle can do that: a person sorts it out.
      if ((err as { code?: string } | null)?.code === "23505") return skip("the subscription belongs to another org");
      throw err;
    }
    if (outcome !== "stored") return skip(outcome);
    console.log("billing: stored", event_id, event_type, sub.status, sub.plan, sub.seats);
    return { status: 200, body: { stored: true } };
  };
}

const API = { sandbox: "https://sandbox-api.paddle.com", live: "https://api.paddle.com" } as const;

/** Asks Paddle's API with the server's key. When Paddle says no, its own words come back, so the person sees why. */
export async function paddleCall(config: PaddleConfig, fetchImpl: typeof fetch, method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchImpl(`${API[config.env]}${path}`, {
      method,
      headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new HttpError(502, "paddle_unreachable", "Paddle didn't answer. Try again in a minute.");
  }
  type Answer = { data?: unknown; error?: { detail?: unknown } } | null;
  // Not JSON reads as no answer: Paddle's status says the rest.
  const answer = await res.text().then((text) => JSON.parse(text) as Answer).catch((): Answer => null);
  if (!res.ok) {
    // The log names the call and the status, never the key or the customer.
    console.error("paddle api error", method, path.split("/")[1], res.status);
    const detail = answer?.error?.detail;
    throw new HttpError(502, "paddle_error", typeof detail === "string" && detail ? `Paddle said: ${detail.slice(0, 300)}` : `Paddle answered ${res.status}.`);
  }
  if (typeof answer?.data !== "object" || answer.data === null) throw new HttpError(502, "paddle_error", "Paddle's answer had no data.");
  return answer.data as Record<string, unknown>;
}
