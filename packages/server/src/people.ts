// What a signed-in person can ask of the Mergelight server: the dashboard's side of the API.
//
// A person signs in with GitHub on the dashboard page and shows the server their GitHub token once.
// The server asks GitHub who they are and which repositories they can see, keeps that answer for 15
// minutes under a session token of its own, and drops the GitHub token. From then on the page uses the
// session token. A person only ever sees reviews of repositories GitHub shows them.
//
// Sessions live in this process's memory. Nothing about a sign-in is written to the database, and a
// restart signs everyone out.

import { createHash, randomBytes } from "node:crypto";
import { HttpError } from "../../token-server/dist/token.js";
import { isId, MEMORY_DAYS, withOrg, type Db, type Pool } from "./db.js";
import { DEFAULT_SIGN_IN_APP, lookUp, looksLikePersonToken, type Person, type Reach } from "./github.js";
import { isCheckName, isLineOfText, isPathPattern, isSkillPath } from "./validate.js";

/**
 * How long what GitHub said at sign-in is trusted. Someone who loses access on GitHub stops seeing
 * the dashboard within this long. The page signs in again by itself when it runs out.
 */
const SESSION_MS = 15 * 60_000;
const MAX_SESSIONS = 20_000;
/** One person's sessions at a time: enough for a few tabs and devices. A newer one replaces the oldest. */
const MAX_SESSIONS_PER_PERSON = 5;
/** Sign-ins a minute, over everyone. Each one costs calls to GitHub, so a flood must not turn into one there. */
const SIGN_INS_PER_MINUTE = 120;
/** Sign-ins that may be asking GitHub at the same moment. */
const MAX_LOOKUPS = 8;
/** One GitHub token signs in once in this long. The page does it once per visit. */
const SAME_TOKEN_EVERY_MS = 20_000;
/** How long a GitHub token waits after GitHub said it is being limited. */
const LIMITED_TOKEN_WAITS_MS = 60_000;
/** Requests a minute for one person, over all their sessions. */
const REQUESTS_PER_MINUTE = 240;
const RECENT_REVIEWS = 50;
/** How many decisions the dashboard lists at once, most recent first. */
const DECISIONS_PER_PAGE = 500;
/** Rules for a whole org, and for one repository. Enough for any team, and a bound on every prompt. */
const MAX_RULES = 50;
const MAX_RULE_BODY = 4096;
/** Skill folders one repository can have picked. Each one is more for every reviewer to read. */
const MAX_SKILLS = 10;
/** Checks one repository can have. Each one that applies is one more AI run in every review, on the team's own plan. */
const MAX_CHECKS = 5;

interface Session {
  person: Person;
  reach: Map<number, Reach>;
  expiresAt: number;
}

/** What is counted per person, however many sessions they hold. */
interface PersonState {
  /** Session keys, oldest first. */
  keys: string[];
  window: { start: number; n: number };
}

export interface PeopleOptions {
  pool: Pool;
  /** Sites whose pages may call this API from a browser, like "https://mergelight.dev". */
  origins: string[];
  /** The GitHub App people sign in with. Only its tokens count as a sign-in. */
  signInApp?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** A site's address as a browser sends it in Origin: scheme and host, nothing after. */
export function parseOrigins(value: string | undefined): string[] {
  return (value ?? "https://mergelight.dev")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const url = new URL(entry);
      const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
      if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error(`DASHBOARD_ORIGINS must hold https:// addresses: ${entry.slice(0, 80)}`);
      return url.origin;
    });
}

const bearer = (request: Request): string => {
  const auth = request.headers.get("authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
};

/** Sessions are kept under a hash, so the list in memory holds nothing that could be used as a token. */
const keyOf = (token: string) => createHash("sha256").update(token).digest("hex");

export function createPeopleApi({ pool, origins, signInApp = DEFAULT_SIGN_IN_APP, fetchImpl = fetch, now = () => Date.now() }: PeopleOptions) {
  const sessions = new Map<string, Session>();
  const persons = new Map<number, PersonState>();
  /** GitHub tokens that signed in a moment ago, by hash, with when each may sign in again. */
  const waits = new Map<string, number>();
  let signIns = { start: 0, n: 0 };
  let lookups = 0;

  function json(status: number, body: unknown, cors: Record<string, string>): Response {
    return new Response(body === null ? null : JSON.stringify(body), {
      status,
      headers: { ...(body === null ? {} : { "content-type": "application/json" }), "cache-control": "no-store", ...cors },
    });
  }

  function drop(key: string): void {
    const session = sessions.get(key);
    if (!session) return;
    sessions.delete(key);
    const state = persons.get(session.person.id);
    if (!state) return;
    state.keys = state.keys.filter((k) => k !== key);
    if (!state.keys.length) persons.delete(session.person.id);
  }

  /** The session a request carries. counted: whether it uses up some of the person's requests for this minute. */
  function sessionOf(request: Request, at: number, counted = true): { key: string; session: Session } {
    const token = bearer(request);
    const key = token ? keyOf(token) : "";
    const session = key ? sessions.get(key) : undefined;
    if (!session || session.expiresAt <= at) {
      if (session) drop(key);
      throw new HttpError(401, "signed_out", "Sign in again.");
    }
    const state = persons.get(session.person.id);
    if (counted && state) {
      if (at - state.window.start >= 60_000) state.window = { start: at, n: 0 };
      if (++state.window.n > REQUESTS_PER_MINUTE) throw new HttpError(429, "too_many_requests", "Too many requests. Try again in a minute.");
    }
    return { key, session };
  }

  /** Swaps a GitHub sign-in for a session. The GitHub token isn't kept past this function. */
  async function signIn(request: Request, at: number): Promise<{ status: number; body: unknown }> {
    const githubToken = bearer(request);
    // Anything that isn't shaped like a GitHub sign-in is turned away before it costs anyone anything.
    if (!looksLikePersonToken(githubToken)) throw new HttpError(401, "sign_in_failed", "That isn't a GitHub sign-in.");

    if (at - signIns.start >= 60_000) {
      signIns = { start: at, n: 0 };
      // Once a minute, what ran out is dropped.
      for (const [key, s] of sessions) if (s.expiresAt <= at) drop(key);
      for (const [hash, until] of waits) if (until <= at) waits.delete(hash);
    }
    const hash = keyOf(githubToken);
    if (at < (waits.get(hash) ?? 0)) throw new HttpError(429, "too_many_requests", "This sign-in was just used. Try again in a moment.");
    if (++signIns.n > SIGN_INS_PER_MINUTE || lookups >= MAX_LOOKUPS) throw new HttpError(429, "too_many_requests", "Too many sign-ins right now. Try again in a minute.");
    waits.set(hash, at + SAME_TOKEN_EVERY_MS);

    let found: Awaited<ReturnType<typeof lookUp>>;
    lookups++;
    try {
      found = await lookUp(githubToken, fetchImpl, signInApp);
    } catch (err) {
      // GitHub limits per person, so only this token waits longer. Everyone else signs in as usual.
      if (err instanceof HttpError && err.code === "github_limited") waits.set(hash, at + LIMITED_TOKEN_WAITS_MS);
      throw err;
    } finally {
      lookups--;
    }
    const { person, reach } = found;

    // Which of the person's accounts use the dashboard. Each is asked inside that org's own rows.
    // This comes before the session exists, so a failure here leaves nothing behind.
    const orgs = [];
    for (const r of reach) {
      const connected = await withOrg(pool, r.id, async (db) => ((await db.query("select 1 from orgs where id = $1", [r.id])).rowCount ?? 0) > 0);
      orgs.push({ id: r.id, login: r.login, connected, repos: r.repos.size });
    }

    // Nothing to show means nothing to hold a session for. This also keeps a token that another app
    // got for someone with no Mergelight installs from ever holding one.
    if (!reach.length) return { status: 200, body: { token: null, expires_at: null, user: person, orgs: [] } };

    if (sessions.size >= MAX_SESSIONS) throw new HttpError(503, "busy", "The server is busy. Try again in a minute.");
    const state = persons.get(person.id) ?? { keys: [], window: { start: at, n: 0 } };
    persons.set(person.id, state);
    while (state.keys.length >= MAX_SESSIONS_PER_PERSON) drop(state.keys[0]!);
    // Dropping a person's last session forgets them, so the entry is put back for the new one.
    persons.set(person.id, state);

    const token = randomBytes(32).toString("base64url");
    const key = keyOf(token);
    const expiresAt = at + SESSION_MS;
    sessions.set(key, { person, reach: new Map(reach.map((r) => [r.id, r])), expiresAt });
    state.keys.push(key);
    return { status: 201, body: { token, expires_at: new Date(expiresAt).toISOString(), user: person, orgs } };
  }

  /** The first page: the person's repositories in one org, and the latest reviews of them. */
  async function overview(session: Session, orgId: number): Promise<{ status: number; body: unknown }> {
    // An org the person can't reach looks the same as one that doesn't exist.
    const reach = session.reach.get(orgId);
    if (!reach) throw new HttpError(404, "not_found", "No such org.");
    const repoIds = [...reach.repos.keys()];

    const found = await withOrg(pool, orgId, async (db) => {
      if ((await db.query("select 1 from orgs where id = $1", [orgId])).rowCount === 0) return null;
      // The database limits the rows to this org. The list of repositories limits them to what GitHub shows this person.
      const repos = await db.query(
        `select r.id, r.name, r.last_review_at, count(v.id)::int as reviews
           from repos r left join reviews v on v.org_id = r.org_id and v.repo_id = r.id
          where r.id = any($1::bigint[])
          group by r.id, r.name, r.last_review_at
          order by r.last_review_at desc nulls last`,
        [repoIds],
      );
      const reviews = await db.query(
        `select v.repo_id, r.name as repo, v.pr, v.sha, v.light, v.bugs, v.risks, v.hardening, v.major,
                v.provider, v.model, v.duration_ms, v.created_at
           from reviews v join repos r on r.org_id = v.org_id and r.id = v.repo_id
          where v.repo_id = any($1::bigint[])
          order by v.created_at desc
          limit ${RECENT_REVIEWS}`,
        [repoIds],
      );
      return { repos: repos.rows, reviews: reviews.rows };
    });
    if (!found) throw new HttpError(404, "not_connected", "This org hasn't turned the Mergelight dashboard on.");
    return {
      status: 200,
      body: {
        org: { id: orgId, login: reach.login },
        repos: found.repos.map((r) => ({ id: Number(r.id), name: r.name, last_review_at: r.last_review_at, reviews: r.reviews })),
        reviews: found.reviews.map((v) => ({ ...v, repo_id: Number(v.repo_id) })),
      },
    };
  }

  /** What the team decided not to fix, in the repositories this person can see. */
  async function memories(session: Session, orgId: number): Promise<{ status: number; body: unknown }> {
    const reach = session.reach.get(orgId);
    if (!reach) throw new HttpError(404, "not_found", "No such org.");
    const rows = await withOrg(pool, orgId, async (db) => {
      if ((await db.query("select 1 from orgs where id = $1", [orgId])).rowCount === 0) return null;
      const live = "m.repo_id = any($1::bigint[]) and m.forgotten_at is null and coalesce(m.last_used_at, m.updated_at) > now() - make_interval(days => $2)";
      const args = [[...reach.repos.keys()], MEMORY_DAYS];
      const found = await db.query(
        `select m.id, m.repo_id, m.title, m.file, m.line, m.end_line, m.reason, m.by_login, m.pr, m.decided_at, m.last_used_at, m.uses
           from memories m where ${live} order by m.updated_at desc limit ${DECISIONS_PER_PAGE}`,
        args,
      );
      const total = await db.query(`select count(*)::int as n from memories m where ${live}`, args);
      return { list: found.rows, total: total.rows[0]?.n ?? found.rows.length };
    });
    if (!rows) throw new HttpError(404, "not_connected", "This org hasn't turned the Mergelight dashboard on.");
    return {
      status: 200,
      body: {
        // How many there are in all, so the page can say when it shows only the most recent ones.
        total: rows.total,
        memories: rows.list.map((m) => {
          const repo = reach.repos.get(Number(m.repo_id));
          return {
            id: Number(m.id), repo_id: Number(m.repo_id), repo: repo?.name ?? "", title: m.title, file: m.file, line: m.line, end_line: m.end_line,
            reason: m.reason, by: m.by_login, pr: m.pr, created_at: m.decided_at, last_used_at: m.last_used_at, uses: m.uses,
            // Only someone who can push to the repository can make Mergelight forget a decision made there.
            can_forget: repo?.write === true,
          };
        }),
      },
    };
  }

  /** Makes Mergelight forget one decision. For people who can push to that repository, the ones who could have made it. */
  async function forget(session: Session, orgId: number, memoryId: number): Promise<{ status: number; body: unknown }> {
    const reach = session.reach.get(orgId);
    if (!reach) throw new HttpError(404, "not_found", "No such org.");
    const outcome = await withOrg(pool, orgId, async (db) => {
      const { rows } = await db.query("select repo_id from memories where id = $1 and forgotten_at is null", [memoryId]);
      const repo = rows[0] ? reach.repos.get(Number(rows[0].repo_id)) : undefined;
      // A decision in a repository this person can't see looks the same as one that doesn't exist.
      if (!repo) return "missing";
      if (!repo.write) return "read_only";
      // The text is wiped and the row stays. The pull request the decision came from still holds it, and
      // without this its next review would bring the decision straight back.
      // The marker carries the moment of forgetting, so only a decision someone writes after it counts
      // again, whichever pull request an older one turns up from.
      const { rows: was } = await db.query("select title from memories where id = $1", [memoryId]);
      await db.query("update memories set forgotten_at = now(), decided_at = now(), title = '', file = '', reason = '', by_login = '' where id = $1", [memoryId]);
      // The log keeps which decision it was by its number and repository. Its text is gone with it.
      await record(db, orgId, session.person, "decision_forgotten", { id: memoryId, repo_id: Number(rows[0]!.repo_id), had_text: Boolean(was[0]?.title) });
      return "gone";
    });
    if (outcome === "missing") throw new HttpError(404, "not_found", "No such decision.");
    if (outcome === "read_only") throw new HttpError(403, "read_only", "Only people who can push to this repository can remove a decision.");
    return { status: 204, body: null };
  }

  /** Writes down who changed what. It runs in the same transaction as the change, so there is no change without its line. */
  const record = (db: Db, orgId: number, person: Person, action: string, detail: Record<string, unknown>) =>
    db.query("insert into audit_log (org_id, actor, actor_id, action, detail) values ($1, $2, $3, $4, $5)", [orgId, person.login, person.id, action, JSON.stringify(detail)]);

  /** The team's rules this person can see: those of the whole org, and those of repositories GitHub shows them. */
  async function rules(session: Session, orgId: number): Promise<{ status: number; body: unknown }> {
    const reach = session.reach.get(orgId);
    if (!reach) throw new HttpError(404, "not_found", "No such org.");
    const rows = await withOrg(pool, orgId, async (db) => {
      if ((await db.query("select 1 from orgs where id = $1", [orgId])).rowCount === 0) return null;
      const found = await db.query(
        "select id, repo_id, kind, text, paths, created_by, created_at from rules where repo_id is null or repo_id = any($1::bigint[]) order by repo_id nulls first, id",
        [[...reach.repos.keys()]],
      );
      return found.rows;
    });
    if (!rows) throw new HttpError(404, "not_connected", "This org hasn't turned the Mergelight dashboard on.");
    return {
      status: 200,
      body: {
        // Who may change what: a rule tells every review what to report, so it takes the person who runs the org or the repository.
        can_set_org_rules: reach.admin,
        repos: [...reach.repos].map(([id, r]) => ({ id, name: r.name, can_set_rules: r.admin })),
        rules: rows.map((r) => {
          const repo = r.repo_id === null ? null : reach.repos.get(Number(r.repo_id));
          return {
            id: Number(r.id), kind: r.kind, text: r.text, paths: r.paths, by: r.created_by, created_at: r.created_at,
            repo_id: r.repo_id === null ? null : Number(r.repo_id), repo: repo?.name ?? null,
            can_remove: r.repo_id === null ? reach.admin : repo?.admin === true,
          };
        }),
      },
    };
  }

  /** Adds a rule. For the whole org it takes someone who runs the org, for one repository someone who administers it. */
  async function addRule(session: Session, orgId: number, request: Request): Promise<{ status: number; body: unknown }> {
    const reach = session.reach.get(orgId);
    if (!reach) throw new HttpError(404, "not_found", "No such org.");
    const raw = await request.text();
    if (Buffer.byteLength(raw) > MAX_RULE_BODY) throw new HttpError(413, "too_large", "The rule is too large.");
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new HttpError(400, "bad_request", "The rule isn't JSON.");
    }
    const bad = (what: string) => new HttpError(400, "bad_request", `The rule's ${what} isn't valid.`);
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw bad("body");
    const { kind, text, paths = [], repo_id = null } = body as Record<string, unknown>;
    if (kind !== "rule" && kind !== "needs_human") throw bad("kind");
    if (!isLineOfText(text, 300)) throw bad("text");
    if (!Array.isArray(paths) || paths.length > 10 || !paths.every(isPathPattern)) {
      throw new HttpError(400, "bad_request", "The file patterns aren't valid. Use up to 10, each made of letters, digits, / . - _ @ + and the wildcards * and ?.");
    }
    // "Always needs a human" is about files, so it has to name some.
    if (kind === "needs_human" && !paths.length) throw new HttpError(400, "bad_request", "Name the files that always need a human.");
    if (repo_id !== null && !isId(repo_id)) throw bad("repository");

    const repo = repo_id === null ? null : reach.repos.get(repo_id);
    // A repository this person can't see looks the same as one that doesn't exist.
    if (repo_id !== null && !repo) throw new HttpError(404, "not_found", "No such repository.");
    if (repo_id === null ? !reach.admin : !repo!.admin) {
      throw new HttpError(403, "read_only", repo_id === null ? "Only an owner of the org can set rules for the whole org." : "Only an admin of this repository can set its rules.");
    }

    const created = await withOrg(pool, orgId, async (db) => {
      // The org's row is held until the rule is in, so two people adding at once can't both slip past the limit.
      if ((await db.query("select 1 from orgs where id = $1 for update", [orgId])).rowCount === 0) return null;
      const scope = repo_id === null ? "repo_id is null" : "repo_id = $1";
      const count = await db.query(`select count(*)::int as n from rules where ${scope}`, repo_id === null ? [] : [repo_id]);
      if ((count.rows[0]?.n ?? 0) >= MAX_RULES) return "full";
      // A rule can be set for a repository before its first review reaches the server.
      if (repo_id !== null) await db.query("insert into repos (org_id, id, name) values ($1, $2, $3) on conflict (org_id, id) do nothing", [orgId, repo_id, repo!.name]);
      const { rows } = await db.query(
        "insert into rules (org_id, repo_id, kind, text, paths, created_by, created_by_id) values ($1, $2, $3, $4, $5, $6, $7) returning id",
        [orgId, repo_id, kind, text, paths, session.person.login, session.person.id],
      );
      const id = Number(rows[0]!.id);
      await record(db, orgId, session.person, "rule_added", { id, kind, text, paths, repo_id });
      return id;
    });
    if (created === null) throw new HttpError(404, "not_connected", "This org hasn't turned the Mergelight dashboard on.");
    if (created === "full") throw new HttpError(409, "too_many", `There can be ${MAX_RULES} rules here at most. Remove one first.`);
    return { status: 201, body: { id: created } };
  }

  /** Removes a rule. The same people who can add one there can remove it. */
  async function removeRule(session: Session, orgId: number, ruleId: number): Promise<{ status: number; body: unknown }> {
    const reach = session.reach.get(orgId);
    if (!reach) throw new HttpError(404, "not_found", "No such org.");
    const outcome = await withOrg(pool, orgId, async (db) => {
      const { rows } = await db.query("select repo_id, kind, text from rules where id = $1 for update", [ruleId]);
      const rule = rows[0];
      if (!rule) return "missing";
      const repo = rule.repo_id === null ? null : reach.repos.get(Number(rule.repo_id));
      if (rule.repo_id !== null && !repo) return "missing";
      if (rule.repo_id === null ? !reach.admin : !repo!.admin) return "read_only";
      await db.query("delete from rules where id = $1", [ruleId]);
      await record(db, orgId, session.person, "rule_removed", { id: ruleId, kind: rule.kind, text: rule.text, repo_id: rule.repo_id === null ? null : Number(rule.repo_id) });
      return "gone";
    });
    if (outcome === "missing") throw new HttpError(404, "not_found", "No such rule.");
    if (outcome === "read_only") throw new HttpError(403, "read_only", "Only the people who can set rules here can remove one.");
    return { status: 204, body: null };
  }

  /** The skill folders picked for reviews, in the repositories this person can see. */
  async function skills(session: Session, orgId: number): Promise<{ status: number; body: unknown }> {
    const reach = session.reach.get(orgId);
    if (!reach) throw new HttpError(404, "not_found", "No such org.");
    const rows = await withOrg(pool, orgId, async (db) => {
      if ((await db.query("select 1 from orgs where id = $1", [orgId])).rowCount === 0) return null;
      return (await db.query("select id, repo_id, path, added_by, created_at from skills where repo_id = any($1::bigint[]) order by repo_id, id", [[...reach.repos.keys()]])).rows;
    });
    if (!rows) throw new HttpError(404, "not_connected", "This org hasn't turned the Mergelight dashboard on.");
    return {
      status: 200,
      body: {
        repos: [...reach.repos].map(([id, r]) => ({ id, name: r.name, can_pick_skills: r.admin })),
        skills: rows.map((s) => {
          const repo = reach.repos.get(Number(s.repo_id));
          return { id: Number(s.id), repo_id: Number(s.repo_id), repo: repo?.name ?? "", path: s.path, by: s.added_by, created_at: s.created_at, can_remove: repo?.admin === true };
        }),
      },
    };
  }

  /** Picks a skill folder for a repository's reviews. It takes an admin of that repository: a skill steers every review of it. */
  async function addSkill(session: Session, orgId: number, request: Request): Promise<{ status: number; body: unknown }> {
    const reach = session.reach.get(orgId);
    if (!reach) throw new HttpError(404, "not_found", "No such org.");
    const raw = await request.text();
    if (Buffer.byteLength(raw) > MAX_RULE_BODY) throw new HttpError(413, "too_large", "That is too large.");
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new HttpError(400, "bad_request", "That isn't JSON.");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "bad_request", "That isn't a skill.");
    const { repo_id, path: given } = body as Record<string, unknown>;
    // People paste a folder with a slash at either end, or the path of its SKILL.md. It is the same folder.
    const path = typeof given === "string" ? given.trim().replace(/^\/+|\/+$/g, "").replace(/\/+SKILL\.md$/i, "") : given;
    if (typeof path === "string" && /^SKILL\.md$/i.test(path)) throw new HttpError(400, "bad_request", "A skill lives in a folder of its own, like .claude/skills/migrations. Name that folder.");
    if (!isSkillPath(path)) throw new HttpError(400, "bad_request", "Name the skill's folder in the repository, like .claude/skills/migrations. Letters, digits, / . - _ @ + only.");
    if (!isId(repo_id)) throw new HttpError(400, "bad_request", "Pick the repository the skill is in.");
    const repo = reach.repos.get(repo_id);
    if (!repo) throw new HttpError(404, "not_found", "No such repository.");
    if (!repo.admin) throw new HttpError(403, "read_only", "Only an admin of this repository can pick its skills.");

    const created = await withOrg(pool, orgId, async (db) => {
      if ((await db.query("select 1 from orgs where id = $1 for update", [orgId])).rowCount === 0) return null;
      if (((await db.query("select count(*)::int as n from skills where repo_id = $1", [repo_id])).rows[0]?.n ?? 0) >= MAX_SKILLS) return "full";
      await db.query("insert into repos (org_id, id, name) values ($1, $2, $3) on conflict (org_id, id) do nothing", [orgId, repo_id, repo.name]);
      const { rows } = await db.query(
        "insert into skills (org_id, repo_id, path, added_by, added_by_id) values ($1, $2, $3, $4, $5) on conflict (org_id, repo_id, path) do nothing returning id",
        [orgId, repo_id, path, session.person.login, session.person.id],
      );
      if (!rows[0]) return "exists";
      const id = Number(rows[0].id);
      await record(db, orgId, session.person, "skill_added", { id, repo_id, path });
      return id;
    });
    if (created === null) throw new HttpError(404, "not_connected", "This org hasn't turned the Mergelight dashboard on.");
    if (created === "full") throw new HttpError(409, "too_many", `A repository can have ${MAX_SKILLS} skills at most. Remove one first.`);
    if (created === "exists") throw new HttpError(409, "exists", "That skill is already picked.");
    return { status: 201, body: { id: created } };
  }

  async function removeSkill(session: Session, orgId: number, skillId: number): Promise<{ status: number; body: unknown }> {
    const reach = session.reach.get(orgId);
    if (!reach) throw new HttpError(404, "not_found", "No such org.");
    const outcome = await withOrg(pool, orgId, async (db) => {
      const { rows } = await db.query("select repo_id, path from skills where id = $1 for update", [skillId]);
      const repo = rows[0] ? reach.repos.get(Number(rows[0].repo_id)) : undefined;
      if (!repo) return "missing";
      if (!repo.admin) return "read_only";
      await db.query("delete from skills where id = $1", [skillId]);
      await record(db, orgId, session.person, "skill_removed", { id: skillId, repo_id: Number(rows[0]!.repo_id), path: rows[0]!.path });
      return "gone";
    });
    if (outcome === "missing") throw new HttpError(404, "not_found", "No such skill.");
    if (outcome === "read_only") throw new HttpError(403, "read_only", "Only an admin of this repository can remove its skills.");
    return { status: 204, body: null };
  }

  /** The team's own checks, in the repositories this person can see. */
  async function checks(session: Session, orgId: number): Promise<{ status: number; body: unknown }> {
    const reach = session.reach.get(orgId);
    if (!reach) throw new HttpError(404, "not_found", "No such org.");
    const rows = await withOrg(pool, orgId, async (db) => {
      if ((await db.query("select 1 from orgs where id = $1", [orgId])).rowCount === 0) return null;
      return (await db.query("select id, repo_id, name, text, paths, added_by, created_at from checks where repo_id = any($1::bigint[]) order by repo_id, id", [[...reach.repos.keys()]])).rows;
    });
    if (!rows) throw new HttpError(404, "not_connected", "This org hasn't turned the Mergelight dashboard on.");
    return {
      status: 200,
      body: {
        repos: [...reach.repos].map(([id, r]) => ({ id, name: r.name, can_set_checks: r.admin })),
        checks: rows.map((c) => {
          const repo = reach.repos.get(Number(c.repo_id));
          return { id: Number(c.id), repo_id: Number(c.repo_id), repo: repo?.name ?? "", name: c.name, text: c.text, paths: c.paths, by: c.added_by, created_at: c.created_at, can_remove: repo?.admin === true };
        }),
      },
    };
  }

  /**
   * Adds a check to a repository. It takes an admin of that repository: a check is an instruction to
   * the AI, it costs the team an AI run in every review it applies to, and its result can stop a merge.
   */
  async function addCheck(session: Session, orgId: number, request: Request): Promise<{ status: number; body: unknown }> {
    const reach = session.reach.get(orgId);
    if (!reach) throw new HttpError(404, "not_found", "No such org.");
    const raw = await request.text();
    if (Buffer.byteLength(raw) > MAX_RULE_BODY) throw new HttpError(413, "too_large", "That is too large.");
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new HttpError(400, "bad_request", "That isn't JSON.");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "bad_request", "That isn't a check.");
    const { repo_id, name: givenName, text, paths } = body as Record<string, unknown>;
    const name = typeof givenName === "string" ? givenName.trim() : givenName;
    if (!isCheckName(name)) throw new HttpError(400, "bad_request", "Give the check a short name: up to 40 letters, digits and single spaces, with . _ - inside.");
    if (!isLineOfText(text, 500)) throw new HttpError(400, "bad_request", "Write the check as one line, up to 500 characters.");
    if (!Array.isArray(paths) || paths.length < 1 || paths.length > 10 || !paths.every(isPathPattern)) {
      throw new HttpError(400, "bad_request", "Name the files the check is about. Use 1 to 10 patterns, each made of letters, digits, / . - _ @ + and the wildcards * and ?.");
    }
    if (!isId(repo_id)) throw new HttpError(400, "bad_request", "Pick the repository the check is for.");
    const repo = reach.repos.get(repo_id);
    if (!repo) throw new HttpError(404, "not_found", "No such repository.");
    if (!repo.admin) throw new HttpError(403, "read_only", "Only an admin of this repository can set its checks.");

    const created = await withOrg(pool, orgId, async (db) => {
      if ((await db.query("select 1 from orgs where id = $1 for update", [orgId])).rowCount === 0) return null;
      if (((await db.query("select count(*)::int as n from checks where repo_id = $1", [repo_id])).rows[0]?.n ?? 0) >= MAX_CHECKS) return "full";
      await db.query("insert into repos (org_id, id, name) values ($1, $2, $3) on conflict (org_id, id) do nothing", [orgId, repo_id, repo.name]);
      const { rows } = await db.query(
        "insert into checks (org_id, repo_id, name, text, paths, added_by, added_by_id) values ($1, $2, $3, $4, $5, $6, $7) on conflict (org_id, repo_id, lower(name)) do nothing returning id",
        [orgId, repo_id, name, text.trim(), paths, session.person.login, session.person.id],
      );
      if (!rows[0]) return "exists";
      const id = Number(rows[0].id);
      await record(db, orgId, session.person, "check_added", { id, repo_id, name, text: text.trim(), paths });
      return id;
    });
    if (created === null) throw new HttpError(404, "not_connected", "This org hasn't turned the Mergelight dashboard on.");
    if (created === "full") throw new HttpError(409, "too_many", `A repository can have ${MAX_CHECKS} checks at most. Remove one first.`);
    if (created === "exists") throw new HttpError(409, "exists", "This repository already has a check of that name.");
    return { status: 201, body: { id: created } };
  }

  async function removeCheck(session: Session, orgId: number, checkId: number): Promise<{ status: number; body: unknown }> {
    const reach = session.reach.get(orgId);
    if (!reach) throw new HttpError(404, "not_found", "No such org.");
    const outcome = await withOrg(pool, orgId, async (db) => {
      const { rows } = await db.query("select repo_id, name, text from checks where id = $1 for update", [checkId]);
      const repo = rows[0] ? reach.repos.get(Number(rows[0].repo_id)) : undefined;
      if (!repo) return "missing";
      if (!repo.admin) return "read_only";
      await db.query("delete from checks where id = $1", [checkId]);
      await record(db, orgId, session.person, "check_removed", { id: checkId, repo_id: Number(rows[0]!.repo_id), name: rows[0]!.name, text: rows[0]!.text });
      return "gone";
    });
    if (outcome === "missing") throw new HttpError(404, "not_found", "No such check.");
    if (outcome === "read_only") throw new HttpError(403, "read_only", "Only an admin of this repository can remove its checks.");
    return { status: 204, body: null };
  }

  /**
   * Answers a dashboard request, or returns null when the path isn't the dashboard's.
   * pathname has the server's mount path already taken off.
   */
  return async function handle(request: Request, pathname: string): Promise<Response | null> {
    const org = /^\/v1\/orgs\/(\d{1,18})\/(overview|memories|rules|skills|checks)(?:\/(\d{1,18}))?$/.exec(pathname);
    if (pathname !== "/v1/session" && !org) return null;
    // Only one decision or one rule at a time has an address of its own.
    if (org && org[3] && org[2] === "overview") return null;

    // A browser only lets a page read the answer when its site is named here. Other callers send no Origin.
    const origin = request.headers.get("origin");
    if (origin && !origins.includes(origin)) return json(403, { error: "origin_not_allowed" }, {});
    const cors: Record<string, string> = origin ? { "access-control-allow-origin": origin, vary: "Origin" } : {};
    const writable = org ? ["rules", "skills", "checks"].includes(org[2]!) : false;
    const methods = !org ? "POST, DELETE" : org[3] ? "DELETE" : writable ? "GET, POST" : "GET";
    if (request.method === "OPTIONS") {
      return json(204, null, { ...cors, "access-control-allow-methods": methods, "access-control-allow-headers": "authorization, content-type", "access-control-max-age": "600" });
    }

    try {
      const at = now();
      let result: { status: number; body: unknown };
      if (org) {
        const orgId = Number(org[1]);
        const what = org[2];
        const itemId = org[3] ? Number(org[3]) : null;
        const allowed = itemId !== null ? ["DELETE"] : writable ? ["GET", "POST"] : ["GET"];
        if (!allowed.includes(request.method)) return json(405, { error: "method_not_allowed" }, cors);
        if (!isId(orgId) || (itemId !== null && !isId(itemId))) throw new HttpError(404, "not_found", "No such org.");
        const { session } = sessionOf(request, at);
        if (itemId !== null) result = what === "rules" ? await removeRule(session, orgId, itemId) : what === "skills" ? await removeSkill(session, orgId, itemId) : what === "checks" ? await removeCheck(session, orgId, itemId) : await forget(session, orgId, itemId);
        else if (what === "rules") result = request.method === "POST" ? await addRule(session, orgId, request) : await rules(session, orgId);
        else if (what === "skills") result = request.method === "POST" ? await addSkill(session, orgId, request) : await skills(session, orgId);
        else if (what === "checks") result = request.method === "POST" ? await addCheck(session, orgId, request) : await checks(session, orgId);
        else result = what === "memories" ? await memories(session, orgId) : await overview(session, orgId);
      } else if (request.method === "POST") {
        result = await signIn(request, at);
      } else if (request.method === "DELETE") {
        // Signing out is never slowed down: a person must always be able to end their session.
        drop(sessionOf(request, at, false).key);
        result = { status: 204, body: null };
      } else {
        return json(405, { error: "method_not_allowed" }, cors);
      }
      return json(result.status, result.body, cors);
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.code, message: err.message }, cors);
      // Never echo unexpected errors: a database error can carry a row's contents.
      const e = err as { code?: unknown; name?: unknown } | null;
      console.error("server error", e?.code ?? e?.name);
      return json(500, { error: "server_error", message: "The server hit an error." }, cors);
    }
  };
}
