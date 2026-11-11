// The database. Every query that touches a customer's rows goes through withOrg, which names the org
// for the database's own row rules (migrations/001_base.sql). Nothing else in the server runs SQL.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export type Pool = pg.Pool;
/** A connection inside one org's transaction. */
export type Db = pg.PoolClient;

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
/** Any fixed number: two servers starting at once take turns applying migrations. */
const MIGRATE_LOCK = 7_234_001;

/** A decision of the team that nobody needed for this many days is dropped. Each use starts the time again. */
export const MEMORY_DAYS = 90;

/** GitHub's ids are positive whole numbers. Anything else never reaches a query. */
export function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Encryption on the way to the database is chosen in the address itself, with sslmode. */
export function createPool(connectionString: string): Pool {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 10_000,
  });
  // An idle connection the database dropped must not take the server down.
  pool.on("error", (err) => console.error("database connection error", (err as { code?: string }).code ?? err.name));
  return pool;
}

/**
 * The row rules only hold for a role that can't switch them off. A superuser or a role with
 * BYPASSRLS reads every org's rows whatever the policies say, so the server refuses to run as one.
 */
export async function assertRowRulesHold(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>("select rolsuper, rolbypassrls from pg_roles where rolname = current_user");
  const role = rows[0];
  if (!role || role.rolsuper || role.rolbypassrls) {
    throw new Error("The database user can bypass row-level security. Use a role without SUPERUSER and BYPASSRLS.");
  }
}

/** Applies each file in migrations/ once, in name order, each in its own transaction. */
export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATE_LOCK]);
    await client.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
    const done = new Set((await client.query<{ name: string }>("select name from schema_migrations")).rows.map((r) => r.name));
    for (const name of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
      if (done.has(name)) continue;
      await client.query("begin");
      try {
        await client.query(readFileSync(join(MIGRATIONS, name), "utf8"));
        await client.query("insert into schema_migrations (name) values ($1)", [name]);
        await client.query("commit");
      } catch (err) {
        await client.query("rollback");
        throw err;
      }
    }
  } finally {
    await client.query("select pg_advisory_unlock($1)", [MIGRATE_LOCK]).catch(() => {});
    client.release();
  }
}

/**
 * Runs fn in a transaction that can only see and write one org's rows.
 * orgId must come from something checked: GitHub's signed token, or a checked sign-in. Never from a request's text.
 */
export async function withOrg<T>(pool: Pool, orgId: number, fn: (db: Db) => Promise<T>): Promise<T> {
  if (!isId(orgId)) throw new Error("withOrg needs a GitHub account id");
  const client = await pool.connect();
  try {
    await client.query("begin");
    // The third argument keeps the setting inside this transaction, so it can't leak to the next request on this connection.
    await client.query("select set_config('mergelight.org_id', $1, true)", [String(orgId)]);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Drops every decision that nobody needed for 90 days, in all orgs at once. The database only shows
 * this transaction the rows that ran out, and only lets it delete them (migrations/002_memories.sql).
 */
export async function purgeExpiredMemories(pool: Pool): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('mergelight.purge', 'on', true)");
    const { rowCount } = await client.query("delete from memories where memory_ran_out(last_used_at, updated_at, forgotten_at)");
    await client.query("commit");
    return rowCount ?? 0;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Turns the dashboard on for an org. Until then the server stores nothing about it. */
export async function connectOrg(pool: Pool, orgId: number, login: string): Promise<void> {
  await withOrg(pool, orgId, (db) => db.query("insert into orgs (id, login) values ($1, $2) on conflict (id) do update set login = excluded.login", [orgId, login]));
}

/**
 * Orgs the operator turns the dashboard on for when the server starts: "id:login,id:login", with
 * GitHub's number for each account. It stands in until sign-in exists. A value that can't be read
 * stops the start, so a typo isn't taken for "no orgs".
 */
export function parseConnectOrgs(value: string | undefined): { id: number; login: string }[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const match = /^(\d{1,18}):([\w.-]{1,100})$/.exec(entry);
      const id = match ? Number(match[1]) : NaN;
      if (!match || !isId(id)) throw new Error(`CONNECT_ORGS has an entry that isn't "<github-account-id>:<login>": ${entry.slice(0, 60)}`);
      return { id, login: match[2]! };
    });
}

/** Removes everything stored for an org: its repositories and reviews go with it. Returns whether anything was there. */
export async function deleteOrg(pool: Pool, orgId: number): Promise<boolean> {
  return withOrg(pool, orgId, async (db) => ((await db.query("delete from orgs where id = $1", [orgId])).rowCount ?? 0) > 0);
}
