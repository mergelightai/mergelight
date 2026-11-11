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

import { HttpError, verifyOidcToken } from "../../token-server/dist/token.js";
import { isId, MEMORY_DAYS, withOrg, type Pool } from "./db.js";
import { createPeopleApi } from "./people.js";

/**
 * Who a token must be made for: this server's own public address, like "https://data.example.com",
 * with its path if it's mounted under one.
 * A token made for another Mergelight server is refused here, so a server someone else runs can't
 * pass a token it received on to this one. And no address equals the token server's audience, so
 * nothing that reaches this server can be turned into an app token.
 */
export function audienceOf(publicUrl: string): string {
  const url = new URL(publicUrl);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error("The server's public address must start with https://");
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/** Only runs that review a pull request talk to this server. */
const EVENTS = new Set(["pull_request", "pull_request_target"]);

/** Room for a review's numbers and up to 40 decisions with their reasons. */
export const MAX_BODY = 65_536;
const MAX_DECLINES = 40;
/** One repository keeps this many decisions. The ones used longest ago go first. */
const MAX_MEMORIES_PER_REPO = 500;
/** How many a review is sent at most, most recently used first. */
const MEMORIES_PER_REVIEW = 100;
/** And how large that list may be. The client stops reading an answer past 64 KB, so the list stays well under it. */
const MEMORY_BYTES_PER_REVIEW = 40_000;
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
  /** The client's own id for this report. A second try of the same report carries the same one. */
  report_id: string;
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

/** A finding someone on the team chose not to fix, with their reason. */
export interface Decline {
  finding_id: string;
  title: string;
  file: string;
  line: number;
  end_line: number | null;
  reason: string;
  by: string;
  /** When the person wrote it on GitHub. */
  decided_at: string;
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
  /** Sites whose pages may use the dashboard's side of the API from a browser. */
  origins?: string[];
  /** The GitHub App people sign in to the dashboard with. */
  signInApp?: string;
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
  const { report_id, pr, sha, light, counts, tiers, major, provider, model, verifier, duration_ms, files_changed, additions, deletions } = body;
  if (typeof report_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(report_id)) throw bad("report id");
  if (typeof pr !== "number" || !Number.isInteger(pr) || pr < 1 || pr > MAX_INT) throw bad("pull request number");
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) throw bad("commit");
  if (!oneOf(LIGHTS, light)) throw bad("light");
  if (!isRecord(counts) || !count(counts.bug) || !count(counts.risk) || !count(counts.hardening)) throw bad("counts");
  if (!isRecord(tiers) || !count(tiers.post) || !count(tiers.list) || !count(tiers.decision)) throw bad("tiers");
  if (!count(major)) throw bad("major count");
  if (!oneOf(PROVIDERS, provider)) throw bad("provider");
  // The brackets are for names like "sonnet[1m]", and the @ for ones like "claude-opus@20260101".
  if (model != null && (typeof model !== "string" || !/^[\w.:/@[\]-]{1,100}$/.test(model))) throw bad("model");
  if (verifier != null && !oneOf(PROVIDERS, verifier)) throw bad("verifier");
  if (!count(duration_ms, MAX_INT)) throw bad("duration_ms");
  if (!count(files_changed, MAX_INT)) throw bad("files_changed");
  if (!count(additions, MAX_INT)) throw bad("additions");
  if (!count(deletions, MAX_INT)) throw bad("deletions");
  return {
    report_id, pr, sha, light,
    bugs: counts.bug, risks: counts.risk, hardening: counts.hardening,
    major, tier_post: tiers.post, tier_list: tiers.list, tier_decision: tiers.decision,
    provider, model: model ?? null, verifier: verifier ?? null,
    duration_ms, files_changed, additions, deletions,
  };
}

const line = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 10_000_000;
/**
 * One line of plain text of a bounded length. No line breaks and no control characters: this text is
 * later shown to the reviewing model, where a line break is what a heading or a new instruction starts with.
 */
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f\u2028\u2029]/.test(v) && v.trim().length > 0;

/**
 * The team's new decisions in a report, checked field by field. This is text a run sends and the
 * server keeps, so each piece has a shape and a length, and one that doesn't fit refuses the report.
 */
export function parseDeclines(value: unknown): Decline[] {
  const bad = (what: string) => new HttpError(400, "bad_request", `The review's ${what} isn't valid.`);
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_DECLINES) throw bad("list of decisions");
  return value.map((raw) => {
    if (!isRecord(raw)) throw bad("decision");
    const { finding_id, title, file, line: at, end_line, reason, by, decided_at } = raw;
    if (typeof finding_id !== "string" || !/^[a-f0-9]{6,40}$/.test(finding_id)) throw bad("decision's finding");
    if (!text(title, 200) || !text(file, 400) || !text(reason, 500)) throw bad("decision's text");
    if (!line(at) || (end_line != null && !line(end_line))) throw bad("decision's lines");
    if (typeof by !== "string" || !/^[\w.-]{1,100}(\[bot\])?$/.test(by)) throw bad("decision's author");
    // A time GitHub could have given: a real date, and not in the future.
    const when = typeof decided_at === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]{8,12}Z$/.test(decided_at) ? Date.parse(decided_at) : NaN;
    if (!Number.isFinite(when) || when < Date.parse("2020-01-01T00:00:00Z") || when > Date.now() + 5 * 60_000) throw bad("decision's time");
    return { finding_id, title, file, line: at, end_line: end_line ?? null, reason, by, decided_at: new Date(when).toISOString() };
  });
}

/** The ids of the earlier decisions a review used, from names like "M12". */
export function parseUsedMemories(value: unknown): number[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MEMORIES_PER_REVIEW) throw new HttpError(400, "bad_request", "The review's list of used decisions isn't valid.");
  return value.map((v) => {
    const id = typeof v === "string" && /^M\d{1,12}$/.test(v) ? Number(v.slice(1)) : NaN;
    if (!isId(id)) throw new HttpError(400, "bad_request", "The review's list of used decisions isn't valid.");
    return id;
  });
}

export function createApi({ pool, publicUrl, origins = ["https://mergelight.dev"], signInApp, fetchImpl = fetch, now = () => Date.now() }: ApiOptions): (request: Request) => Promise<Response> {
  const audience = audienceOf(publicUrl);
  /** The dashboard's side: signed-in people. Runs and people never share a route or a kind of token. */
  const people = createPeopleApi({ pool, origins, signInApp, fetchImpl, now });
  /** The path the server is mounted under, if any. A proxy may strip it or pass it on, so both forms are routed. */
  const mount = new URL(audience).pathname.replace(/\/+$/, "");
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

  /** What a review needs before it starts: whether the org uses the dashboard, and what the team decided before in this repository. */
  async function context(who: Caller): Promise<Response> {
    const found = await withOrg(pool, who.orgId, async (db) => {
      if ((await db.query("select 1 from orgs where id = $1", [who.orgId])).rowCount === 0) return null;
      const { rows } = await db.query(
        `select id, title, file, line, end_line, reason, by_login, pr
           from memories
          where repo_id = $1 and forgotten_at is null and coalesce(last_used_at, updated_at) > now() - make_interval(days => $2)
          order by coalesce(last_used_at, updated_at) desc
          limit ${MEMORIES_PER_REVIEW}`,
        [who.repoId, MEMORY_DAYS],
      );
      return rows;
    });
    if (!found) return respond(200, { connected: false });
    // The most recently used ones that fit. A list too large for the client to read would cost it the whole answer.
    const memories = [];
    let bytes = 0;
    for (const m of found) {
      const memory = { id: `M${m.id}`, title: m.title, file: m.file, line: m.line, ...(m.end_line ? { end_line: m.end_line } : {}), reason: m.reason, by: m.by_login, pr: m.pr };
      bytes += Buffer.byteLength(JSON.stringify(memory)) + 1;
      if (bytes > MEMORY_BYTES_PER_REVIEW) break;
      memories.push(memory);
    }
    return respond(200, { connected: true, memories });
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
    const declines = parseDeclines((body as Record<string, unknown>).declines);
    const used = parseUsedMemories((body as Record<string, unknown>).used_memories);
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
        `insert into reviews (org_id, repo_id, run_id, run_attempt, report_id, pr, sha, light, bugs, risks, hardening, major, tier_post, tier_list, tier_decision,
                              provider, model, verifier, duration_ms, files_changed, additions, deletions)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
         on conflict (org_id, repo_id, run_id, run_attempt, report_id) do nothing`,
        [who.orgId, who.repoId, who.runId, who.runAttempt, r.report_id, r.pr, r.sha, r.light, r.bugs, r.risks, r.hardening, r.major, r.tier_post, r.tier_list, r.tier_decision,
         r.provider, r.model, r.verifier, r.duration_ms, r.files_changed, r.additions, r.deletions],
      );
      const fresh = (inserted.rowCount ?? 0) > 0;

      // A second try of a report that is already in changes nothing more.
      if (!fresh) return false;

      // What the team decided on this pull request. Only a decision written later than the one on file
      // replaces it. So a pull request that is reviewed again doesn't keep an unused decision alive, and
      // doesn't bring back one that someone made Mergelight forget.
      for (const d of declines) {
        await db.query(
          `insert into memories (org_id, repo_id, finding_id, title, file, line, end_line, reason, by_login, pr, decided_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           on conflict (org_id, repo_id, finding_id) do update
             set title = excluded.title, file = excluded.file, line = excluded.line, end_line = excluded.end_line,
                 reason = excluded.reason, by_login = excluded.by_login, pr = excluded.pr, decided_at = excluded.decided_at,
                 updated_at = now(), forgotten_at = null
             where excluded.decided_at > memories.decided_at`,
          [who.orgId, who.repoId, d.finding_id, d.title, d.file, d.line, d.end_line, d.reason, d.by, r.pr, d.decided_at],
        );
      }
      // The earlier decisions this review used get their 90 days again.
      if (used.length) {
        await db.query("update memories set last_used_at = now(), uses = uses + 1 where repo_id = $1 and forgotten_at is null and id = any($2::bigint[])", [who.repoId, used]);
      }
      // What ran out in this repository goes now, and the oldest go when it holds too many.
      await db.query("delete from memories where repo_id = $1 and forgotten_at is null and coalesce(last_used_at, updated_at) <= now() - make_interval(days => $2)", [who.repoId, MEMORY_DAYS]);
      if (declines.length) {
        await db.query(
          `delete from memories where repo_id = $1 and id in (
             select id from memories where repo_id = $1 and forgotten_at is null order by coalesce(last_used_at, updated_at) desc offset ${MAX_MEMORIES_PER_REPO})`,
          [who.repoId],
        );
      }
      return true;
    });
    if (stored === null) return respond(404, { error: "not_connected", message: "This org hasn't turned the Mergelight dashboard on." });
    return respond(stored ? 201 : 200, { stored });
  }

  const routes: Record<string, { method: string; run: (who: Caller, request: Request) => Promise<Response> }> = {
    "/v1/context": { method: "GET", run: context },
    "/v1/reviews": { method: "POST", run: saveReview },
  };

  return async function handle(request: Request): Promise<Response> {
    const full = new URL(request.url).pathname;
    const pathname = mount && (full === mount || full.startsWith(`${mount}/`)) ? full.slice(mount.length) || "/" : full;
    if (request.method === "GET" && pathname === "/") return respond(200, { service: "mergelight-server" });
    const forPeople = await people(request, pathname);
    if (forPeople) return forPeople;
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
