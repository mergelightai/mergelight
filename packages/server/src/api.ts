// What a review run can ask of the Mergelight server.
//
// A run proves which repository it is with GitHub's OIDC token, the same way the token server
// works. The org and repository come from that signed token and from nowhere else, so a run can
// only reach its own org's rows. The database refuses the rest by itself (migrations/001_base.sql).
//
// A run is not trusted beyond that. Someone who can push a branch can change the workflow in their
// pull request and send anything from it. So a run can read its org's data and add numbers about
// its own repository, and that is all. It can't write rules, settings or text.
//
// The reviewing model never calls this. Mergelight's own program does, before the model starts
// and after it has finished.

import { HttpError, verifyOidcToken } from "../../token-server/src/token.js";
import { isId, withOrg, type Pool } from "./db.js";

/**
 * Who a token must be made for: this server's own public address, like "https://data.example.com".
 * A token made for another Mergelight server is refused here, so a server someone else runs can't
 * pass a token it received on to this one. And no address equals the token server's audience, so
 * nothing that reaches this server can be turned into an app token.
 */
export function audienceOf(publicUrl: string): string {
  const url = new URL(publicUrl);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error("The server's public address must start with https://");
  return url.origin;
}

/** Only runs that review a pull request talk to this server. */
const EVENTS = new Set(["pull_request", "pull_request_target"]);

export const MAX_BODY = 8192;
const RATE_WINDOW_MS = 60_000;
/** A review asks twice, so this is 300 reviews a minute for one org. Far above real use, and still a ceiling. */
export const RATE_MAX = 600;
/** Far more tokens than can be live at once. Past it, new ones are refused rather than forgotten. */
const MAX_SEEN = 200_000;
/** Expired token ids are dropped every this many requests. */
const SWEEP_EVERY = 5_000;

const LIGHTS = ["green", "yellow", "red"] as const;
const PROVIDERS = ["codex", "claude"] as const;
type Light = (typeof LIGHTS)[number];
type Provider = (typeof PROVIDERS)[number];
const MAX_COUNT = 100_000;
const MAX_INT = 2_147_483_647;

/** One review's numbers, as they go into the database. */
export interface ReviewRow {
  pr: number;
  sha: string;
  light: Light;
  bugs: number;
  risks: number;
  hardening: number;
  major: number;
  /** Findings per tier, as the review sorted them: its top picks, the rest worth fixing, and those for a human to decide. */
  tier_post: number;
  tier_list: number;
  tier_decision: number;
  provider: Provider;
  model: string | null;
  verifier: Provider | null;
  duration_ms: number;
  files_changed: number;
  additions: number;
  deletions: number;
}

/** Who a request is from, taken from GitHub's signature alone. */
interface Caller {
  orgId: number;
  repoId: number;
  runId: number;
  runAttempt: number;
  /** owner/name, as GitHub signed it. */
  repo: string;
  /** The pull request the run is for, when GitHub's token names it. A run on pull_request_target has none. */
  pr: number | null;
}

export interface ApiOptions {
  pool: Pool;
  /** The address workflows reach this server at. Tokens must be made for exactly this. */
  publicUrl: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

const count = (v: unknown, max = MAX_COUNT): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;
const digits = (v: unknown): number => (typeof v === "string" && /^\d{1,18}$/.test(v) ? Number(v) : NaN);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The numbers of one review, checked field by field. Text a run sends is never stored as it came:
 * the only strings kept are from short fixed lists, plus a model name held to a plain alphabet.
 */
export function parseReview(body: unknown): ReviewRow {
  const bad = (what: string) => new HttpError(400, "bad_request", `The review's ${what} isn't valid.`);
  if (!isRecord(body)) throw bad("body");
  const { pr, sha, light, counts, tiers, major, provider, model, verifier, duration_ms, files_changed, additions, deletions } = body;
  if (typeof pr !== "number" || !Number.isInteger(pr) || pr < 1 || pr > MAX_INT) throw bad("pull request number");
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) throw bad("commit");
  if (!oneOf(LIGHTS, light)) throw bad("light");
  if (!isRecord(counts) || !count(counts.bug) || !count(counts.risk) || !count(counts.hardening)) throw bad("counts");
  if (!isRecord(tiers) || !count(tiers.post) || !count(tiers.list) || !count(tiers.decision)) throw bad("tiers");
  if (!count(major)) throw bad("major count");
  if (!oneOf(PROVIDERS, provider)) throw bad("provider");
  // The brackets are for names like "sonnet[1m]".
  if (model != null && (typeof model !== "string" || !/^[\w.:/[\]-]{1,100}$/.test(model))) throw bad("model");
  if (verifier != null && !oneOf(PROVIDERS, verifier)) throw bad("verifier");
  if (!count(duration_ms, MAX_INT)) throw bad("duration_ms");
  if (!count(files_changed, MAX_INT)) throw bad("files_changed");
  if (!count(additions, MAX_INT)) throw bad("additions");
  if (!count(deletions, MAX_INT)) throw bad("deletions");
  return {
    pr, sha, light,
    bugs: counts.bug, risks: counts.risk, hardening: counts.hardening,
    major, tier_post: tiers.post, tier_list: tiers.list, tier_decision: tiers.decision,
    provider, model: model ?? null, verifier: verifier ?? null,
    duration_ms, files_changed, additions, deletions,
  };
}

export function createApi({ pool, publicUrl, fetchImpl = fetch, now = () => Date.now() }: ApiOptions): (request: Request) => Promise<Response> {
  const audience = audienceOf(publicUrl);
  /** Token ids already used, with when each expires. A token works once, so a copied one is worth nothing. */
  const seen = new Map<string, number>();
  /** Requests per org in the current minute. */
  const rate = new Map<number, { start: number; n: number }>();
  let sinceSweep = 0;

  /**
   * The list lives in this process, so it holds for one server between restarts. GitHub's tokens
   * expire within minutes, which bounds what a restart or a second server could let through.
   */
  function useOnce(jti: string, expiresAt: number, at: number): void {
    if (seen.has(jti)) throw new HttpError(401, "token_used", "This OIDC token was used before. Ask GitHub for a new one for each request.");
    if (++sinceSweep >= SWEEP_EVERY || seen.size >= MAX_SEEN) {
      sinceSweep = 0;
      for (const [id, exp] of seen) if (exp < at) seen.delete(id);
      if (seen.size >= MAX_SEEN) throw new HttpError(503, "busy", "The server is busy. Try again in a minute.");
    }
    seen.set(jti, expiresAt);
  }

  function limit(orgId: number, at: number): void {
    const slot = rate.get(orgId);
    if (!slot || at - slot.start >= RATE_WINDOW_MS) {
      if (rate.size > 10_000) for (const [id, s] of rate) if (at - s.start >= RATE_WINDOW_MS) rate.delete(id);
      rate.set(orgId, { start: at, n: 1 });
      return;
    }
    if (++slot.n > RATE_MAX) throw new HttpError(429, "too_many_requests", "Too many requests from this org. Try again in a minute.");
  }

  /** Who is asking, from GitHub's signature alone. */
  async function identify(request: Request): Promise<Caller> {
    const auth = request.headers.get("authorization") ?? "";
    if (!auth.startsWith("Bearer ")) throw new HttpError(401, "invalid_token", "Send GitHub's OIDC token as a Bearer token.");
    const at = now();
    const claims = await verifyOidcToken(auth.slice("Bearer ".length), fetchImpl, at, audience);
    if (typeof claims.event_name !== "string" || !EVENTS.has(claims.event_name)) {
      throw new HttpError(403, "event_not_allowed", "Only runs that review a pull request use the server.");
    }

    const orgId = digits(claims.repository_owner_id);
    const repoId = digits(claims.repository_id);
    const runId = digits(claims.run_id);
    const runAttempt = digits(claims.run_attempt);
    const repo = typeof claims.repository === "string" && /^[\w.-]{1,100}\/[\w.-]{1,100}$/.test(claims.repository) ? claims.repository : null;
    if (!isId(orgId) || !isId(repoId) || !isId(runId) || !isId(runAttempt) || runAttempt > MAX_INT || !repo) {
      throw new HttpError(401, "invalid_token", "GitHub's OIDC token names no repository.");
    }
    const { jti } = claims;
    if (typeof jti !== "string" || !jti || jti.length > 200) throw new HttpError(401, "invalid_token", "GitHub's OIDC token has no id.");
    // The limit comes first, so an org that is being slowed down can't fill the list of used tokens for everyone.
    limit(orgId, at);
    useOnce(jti, claims.exp * 1000 + 60_000, at);
    // On a pull_request run GitHub signs "refs/pull/<number>/merge".
    const pull = typeof claims.ref === "string" ? /^refs\/pull\/(\d{1,10})\/merge$/.exec(claims.ref) : null;
    return { orgId, repoId, runId, runAttempt, repo, pr: pull ? Number(pull[1]) : null };
  }

  /** What a review needs before it starts. For now only whether the org uses the dashboard at all. */
  async function context(who: Caller): Promise<Response> {
    const connected = await withOrg(pool, who.orgId, async (db) => ((await db.query("select 1 from orgs where id = $1", [who.orgId])).rowCount ?? 0) > 0);
    return respond(200, { connected });
  }

  async function saveReview(who: Caller, request: Request): Promise<Response> {
    const text = await request.text();
    if (text.length > MAX_BODY) throw new HttpError(413, "too_large", "The review is too large.");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new HttpError(400, "bad_request", "The review isn't JSON.");
    }
    const r = parseReview(body);
    // A run can't report numbers for another pull request than the one GitHub signed it for.
    if (who.pr !== null && r.pr !== who.pr) throw new HttpError(400, "bad_request", "The review's pull request number isn't the one this run is for.");

    const stored = await withOrg(pool, who.orgId, async (db) => {
      // Nothing is kept for an org that hasn't turned the dashboard on.
      if ((await db.query("select 1 from orgs where id = $1", [who.orgId])).rowCount === 0) return null;
      await db.query(
        `insert into repos (org_id, id, name, last_review_at) values ($1, $2, $3, now())
         on conflict (org_id, id) do update set name = excluded.name, last_review_at = now()`,
        [who.orgId, who.repoId, who.repo],
      );
      const inserted = await db.query(
        `insert into reviews (org_id, repo_id, run_id, run_attempt, pr, sha, light, bugs, risks, hardening, major, tier_post, tier_list, tier_decision,
                              provider, model, verifier, duration_ms, files_changed, additions, deletions)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
         on conflict (org_id, repo_id, run_id, run_attempt, pr, provider) do nothing`,
        [who.orgId, who.repoId, who.runId, who.runAttempt, r.pr, r.sha, r.light, r.bugs, r.risks, r.hardening, r.major, r.tier_post, r.tier_list, r.tier_decision,
         r.provider, r.model, r.verifier, r.duration_ms, r.files_changed, r.additions, r.deletions],
      );
      return (inserted.rowCount ?? 0) > 0;
    });
    if (stored === null) return respond(404, { error: "not_connected", message: "This org hasn't turned the Mergelight dashboard on." });
    return respond(stored ? 201 : 200, { stored });
  }

  const routes: Record<string, { method: string; run: (who: Caller, request: Request) => Promise<Response> }> = {
    "/v1/context": { method: "GET", run: context },
    "/v1/reviews": { method: "POST", run: saveReview },
  };

  return async function handle(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/") return respond(200, { service: "mergelight-server" });
    const route = Object.hasOwn(routes, pathname) ? routes[pathname] : undefined;
    if (!route) return respond(404, { error: "not_found" });
    if (request.method !== route.method) return respond(405, { error: "method_not_allowed" });
    try {
      return await route.run(await identify(request), request);
    } catch (err) {
      if (err instanceof HttpError) return respond(err.status, { error: err.code, message: err.message });
      // Never echo unexpected errors: a database error can carry a row's contents.
      const e = err as { code?: unknown; name?: unknown } | null;
      console.error("server error", e?.code ?? e?.name);
      return respond(500, { error: "server_error", message: "The server hit an error." });
    }
  };
}
