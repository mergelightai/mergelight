import type { PriorFinding } from "./prompt.js";
import { encodeMark, MAX_NOTE } from "./publish/handled.js";
import { withoutHidden } from "./skills.js";
import type { Review } from "./types.js";

/**
 * A comment that mentions Mergelight on a pull request: the team's answer to the findings, in plain
 * words. The review that the comment starts reads it, and what the verifier takes from it is kept as
 * the team's decisions.
 */
export interface TeamAnswer {
  by: string;
  /** When it was written, from GitHub. */
  at: string;
  url: string;
  text: string;
}

/** Enough for a long answer to every finding of a round, and no wall that crowds out the code. */
export const MAX_ANSWER = 8_000;

/** The comment that started this run, as the Action passes it on. Null when no comment did. */
export function teamAnswerFromEnv(env: NodeJS.ProcessEnv = process.env): TeamAnswer | null {
  const by = env.MERGELIGHT_COMMENT_BY?.trim();
  const text = withoutHidden(env.MERGELIGHT_COMMENT_BODY ?? "").trim();
  if (!by || !text || !/^[\w.-]{1,100}$/.test(by)) return null;
  return { by, at: env.MERGELIGHT_COMMENT_AT ?? new Date().toISOString(), url: env.MERGELIGHT_COMMENT_URL ?? "", text: text.slice(0, MAX_ANSWER) };
}

/** How the verifier names a finding the team decided to leave: "the team decided not to fix this: <their reason>". */
const DECIDED = /^\s*the team decided not to fix this\s*(?::\s*(.*))?$/is;

export interface AnsweredDecision {
  id: string;
  title: string;
  note: string;
}

/**
 * The earlier findings the verifier left because the team's answer decided so, each with the team's
 * reason as the verifier put it. Only earlier findings: a candidate isn't the team's to decide on.
 */
export function decisionsFromAnswer(previous: PriorFinding[] | undefined, rejected: { candidate: string; reason: string }[]): AnsweredDecision[] {
  const earlier = new Map((previous ?? []).map((p) => [p.id, p]));
  const decided = new Map<string, AnsweredDecision>();
  for (const r of rejected) {
    const p = earlier.get(r.candidate);
    const m = DECIDED.exec(r.reason);
    if (!p || !m || decided.has(p.id)) continue;
    const note = (m[1] ?? "").replace(/\s+/g, " ").trim();
    decided.set(p.id, { id: p.id, title: p.title, note: note || "The team decided not to fix this." });
  }
  return [...decided.values()];
}

/**
 * The decisions as the team's own: the next steps read them like a mark the person wrote, so the
 * server can keep their reasons for later pull requests.
 */
export function withDecisions(previous: PriorFinding[] | undefined, decided: AnsweredDecision[], answer: TeamAnswer, sha: string): PriorFinding[] | undefined {
  if (!decided.length) return previous;
  const notes = new Map(decided.map((d) => [d.id, d.note]));
  return previous?.map((p) => (notes.has(p.id) ? { ...p, handled: { as: "wont_fix" as const, note: notes.get(p.id)!, by: answer.by, sha, from: "mark" as const, at: answer.at } } : p));
}

/** A finding's title as one plain line, safe inside a list. */
function line(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/<!--/g, "&lt;!--")
    .replace(/(^|[^\w`])@(?=[A-Za-z0-9-])/g, "$1@​")
    .trim();
}

/**
 * Mergelight's answer to the comment: what it took from it, and what still holds the merge. Each
 * decision is kept as a mark of its own, with the team's reason, so later rounds and the agent tools
 * read it like any other. Never names Mergelight with an @, so it can't start another run.
 */
export function answerReplyBody(answer: TeamAnswer, decided: AnsweredDecision[], review: Pick<Review, "findings">, sha: string): string {
  const holding = review.findings.filter((f) => f.tier !== "hardening");
  const out = [`Read the answer from ${line(answer.by)}${answer.url ? ` ([comment](${answer.url}))` : ""}.`];
  if (decided.length) {
    out.push("", `**Left as the team decided (${decided.length}):** these don't come back.`);
    for (const d of decided) out.push(`- ${line(d.title)}: ${line(d.note)}`);
  } else {
    out.push("", "Nothing in it decided to leave a finding as it is.");
  }
  if (holding.length) {
    out.push("", `**Still holds the merge (${holding.length}):**`);
    for (const f of holding) out.push(`- ${line(f.title)}: ${line(f.verdict)}`);
  } else {
    out.push("", "Nothing holds the merge now.");
  }
  out.push("", "The summary is up to date.");
  for (const d of decided) out.push(encodeMark([d.id], "wont_fix", `${answer.by}: ${d.note}`.slice(0, MAX_NOTE), sha));
  return out.join("\n");
}
