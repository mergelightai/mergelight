// What an org may use: the dashboard, and Jobs. Every check of it in the server goes through planOf,
// so the rule lives in this one place.
//
// The dashboard: the org's data is stored here (a row in orgs), and one of these holds:
// - It pays for nothing, and the operator turned it on (CONNECT_ORGS, or the admin command). These
//   orgs came before payments, and they stay on.
// - It pays for Light or Pro, and the subscription works.
// - The operator keeps it on (CONNECT_ORGS), whatever it pays.
// So a subscription that ended or is paused turns the dashboard off. Its data stays until someone deletes it.
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
  dashboard: boolean;
  jobs: boolean;
  /** What the org pays for, while its subscription works. */
  paid: PlanName | null;
}

/**
 * The payment company's statuses in which a subscription keeps its plan. past_due: a payment failed
 * and the payment company tries again for some days. The team keeps working while it does.
 */
const WORKING = new Set(["active", "trialing", "past_due"]);

/**
 * What the org may use, read inside its own transaction (withOrg). lock holds the org's row until the
 * transaction ends, so two people who add something at the same moment can't both slip past a limit.
 */
export async function planOf(db: Db, orgId: number, grants: Grants, { lock = false } = {}): Promise<OrgPlan> {
  const connected = ((await db.query(`select 1 from orgs where id = $1${lock ? " for update" : ""}`, [orgId])).rowCount ?? 0) > 0;
  const { rows } = await db.query<{ plan: PlanName; status: string }>("select plan, status from billing where org_id = $1", [orgId]);
  const bill = rows[0];
  const paid = bill && WORKING.has(bill.status) ? bill.plan : null;
  return {
    connected,
    dashboard: connected && (grants.dashboard.has(orgId) || !bill || paid !== null),
    jobs: grants.jobs.has(orgId) || paid === "pro",
    paid,
  };
}
