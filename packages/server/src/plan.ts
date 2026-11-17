// What an org may use: the dashboard, and Jobs. Every check of it in the server goes through planOf,
// so the rule lives in this one place.
//
// The dashboard: the org's data is stored here (a row in orgs), and one of these holds:
// - It pays for nothing, and the operator turned it on (CONNECT_ORGS, or the admin command). These
//   orgs came before payments, and they stay on.
// - It pays for Light or Pro, and the subscription works.
// - The operator keeps it on (CONNECT_ORGS), whatever it pays.
// So a subscription that ended or is paused turns the dashboard off: runs get none of the team's
// rules, memory, skills or checks, and store nothing. The data stays until an owner deletes it, and the
// dashboard still shows it (ended), so owners can see what is kept, remove it, and delete it.
//
// Light is free for public repositories: an owner turns that on (orgs.public_only), and then reviews of
// the org's public repositories use the dashboard, whatever the org pays. Its private ones need a plan.
//
// Jobs: the org pays for Pro and the subscription works, or the operator gives it Jobs (JOBS_ORGS).

import type { Db } from "./db.js";

export type PlanName = "light" | "pro";

/** What the operator gives for free, in the server's settings. */
export interface Grants {
  /** CONNECT_ORGS: the dashboard, whatever the org pays. */
  dashboard: ReadonlySet<number>;
  /** JOBS_ORGS: Jobs, whatever the org pays. */
  jobs: ReadonlySet<number>;
}

export const NO_GRANTS: Grants = { dashboard: new Set(), jobs: new Set() };

export interface OrgPlan {
  /** The org's data is stored here. */
  connected: boolean;
  /** Which repositories' reviews use the dashboard: all of them, only the public ones (free), or none. */
  covers: "all" | "public" | "none";
  /** On for some repositories at least: the dashboard's pages work, and things can be added. */
  dashboard: boolean;
  /** The org's data is stored here and its plan ended or is paused. The dashboard shows the data, and nothing new can be added. */
  ended: boolean;
  /** The org had a paid plan that ended or is paused, whatever else it has. A review the plan would have covered says so. */
  lapsed: boolean;
  jobs: boolean;
  /** What the org pays for, while its subscription works. */
  paid: PlanName | null;
}

/**
 * The payment company's statuses in which a subscription keeps its plan. past_due: a payment failed
 * and the payment company tries again for some days. The team keeps working while it does.
 */
export const WORKING: ReadonlySet<string> = new Set(["active", "trialing", "past_due"]);

/**
 * What the org may use, read inside its own transaction (withOrg). lock holds the org's row until the
 * transaction ends, so two people who add something at the same moment can't both slip past a limit.
 */
export async function planOf(db: Db, orgId: number, grants: Grants, { lock = false } = {}): Promise<OrgPlan> {
  const org = (await db.query<{ public_only: boolean }>(`select public_only from orgs where id = $1${lock ? " for update" : ""}`, [orgId])).rows[0];
  const connected = org !== undefined;
  const { rows } = await db.query<{ plan: PlanName; status: string }>("select plan, status from billing where org_id = $1", [orgId]);
  const bill = rows[0];
  const paid = bill && WORKING.has(bill.status) ? bill.plan : null;
  // The operator's orgs from before payments pay nothing and aren't marked public only: they stay on for every repository.
  const all = connected && (grants.dashboard.has(orgId) || paid !== null || (!bill && !org.public_only));
  const covers = all ? "all" : connected && org.public_only ? "public" : "none";
  const lapsed = connected && bill !== undefined && paid === null && !grants.dashboard.has(orgId);
  return { connected, covers, dashboard: covers !== "none", ended: connected && covers === "none", lapsed, jobs: grants.jobs.has(orgId) || paid === "pro", paid };
}

/** Whether a review of a repository uses the dashboard: always with a plan, and for a public repository with the free one too. */
export function coversRepo(plan: OrgPlan, isPublic: boolean): boolean {
  return plan.covers === "all" || (plan.covers === "public" && isPublic);
}
