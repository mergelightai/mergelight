import { trustedComment } from "./handled.js";
import { FINDING_MARKER_RE } from "./markdown.js";

/**
 * Handled inline comments. A finding that got fixed, or whose thread someone
 * resolved, keeps its one comment: the comment is edited to say so, with the
 * original text behind a dropdown. Nothing new gets posted, so long pull requests
 * stay readable. What a comment says is also all the memory this needs: each
 * round reads the threads and works out what changed.
 *
 * A finding the review still reports is never handled. Resolving a thread tells
 * the verifier the team decided to leave it, and the verifier respects that unless
 * it's a major bug that can still happen. Then it stays reported on purpose, and
 * the check stays as it is, so resolving a thread can't wave a real bug through.
 */

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  resolvedBy?: { login?: string } | null;
  comments: { nodes: { id?: string; isMinimized?: boolean; databaseId: number; body: string; authorAssociation?: string; author?: { __typename?: string; login?: string } | null; createdAt?: string; lastEditedAt?: string | null }[] };
}

/** fixed: the code changed and the finding is gone. resolved: someone resolved the thread. */
export type HandledHow = "fixed" | "resolved";

export interface Handled {
  how: HandledHow;
  /** Who resolved the thread, if GitHub says. */
  by?: string | null;
  /** The commit a fix was seen in. */
  sha?: string | null;
}

/** Older reviews answered a fixed thread with a reply carrying this marker. */
const GONE_MARKER = "<!-- mergelight:gone -->";
/** Someone reopened a thread Mergelight closed. It stays open until a person resolves it again. */
const REOPENED_MARKER = "<!-- mergelight:reopened -->";
const CLOSED_RE = /<!-- mergelight:closed how=(fixed|resolved) resolved=([01])(?: sha=([a-f0-9]+))? -->/;
const SUMMARY_END = "</summary>\n\n";
const DETAILS_END = "\n\n</details>";

export function readClosed(body: string): { how: HandledHow; resolved: boolean; sha: string | null } | null {
  const m = body.match(CLOSED_RE);
  return m ? { how: m[1] as HandledHow, resolved: m[2] === "1", sha: m[3] ?? null } : null;
}

/** The comment with a checkmark on top and the original behind a dropdown, named after the finding. */
export function closedBody(body: string, c: { how: HandledHow; resolved: boolean; sha?: string | null; by?: string | null }): string {
  const marker = body.match(FINDING_MARKER_RE)?.[0] ?? "";
  const original = body.replace(FINDING_MARKER_RE, "").replace(REOPENED_MARKER, "").trim();
  const label = (original.split("\n")[0] ?? "Original comment").replace(/\*\*/g, "").replace(/</g, "&lt;");
  const why =
    c.how === "fixed"
      ? `The code changed and Mergelight no longer finds this${c.sha ? ` in \`${c.sha}\`` : ""}.`
      : `Resolved${c.by ? ` by ${c.by}` : ""}.`;
  return [
    marker,
    `<!-- mergelight:closed how=${c.how} resolved=${c.resolved ? 1 : 0}${c.sha ? ` sha=${c.sha}` : ""} -->`,
    `✅ **Handled.** ${why}`,
    "",
    `<details><summary>${label}${SUMMARY_END}${original}${DETAILS_END}`,
  ].join("\n");
}

/** Back to the original comment. */
export function reopenedBody(body: string, keepOpen: boolean): string {
  const marker = body.match(FINDING_MARKER_RE)?.[0] ?? "";
  const start = body.indexOf(SUMMARY_END);
  const end = body.lastIndexOf(DETAILS_END);
  const original = start >= 0 && end > start ? body.slice(start + SUMMARY_END.length, end) : body;
  return [marker, ...(keepOpen ? [REOPENED_MARKER] : []), original].join("\n");
}

/** The finding a thread is about, if it's one of Mergelight's own. */
export function threadFinding(t: ReviewThread): { id: string; commentId: number; nodeId?: string; body: string } | null {
  const first = t.comments.nodes[0];
  if (!first) return null;
  if (!trustedComment({ user: { type: first.author?.__typename }, author_association: first.authorAssociation })) return null;
  const id = first.body.match(FINDING_MARKER_RE)?.[1];
  return id ? { id, commentId: first.databaseId, nodeId: first.id, body: first.body } : null;
}

export type ThreadAction =
  /** Gone from the review and its code changed. Both are required: a finding can drop out without being fixed. */
  | { kind: "fixed"; resolve: boolean }
  /** Someone resolved the thread. */
  | { kind: "resolved" }
  /** Someone reopened a closed thread. Back to the original, and Mergelight doesn't overrule them by closing it again. */
  | { kind: "reopened" }
  /** Marked handled, then reported again. Back to the original. A fix's thread reopens; a person's resolve stays theirs. */
  | { kind: "regressed"; unresolve: boolean };

/** What this round should do to a thread, given the findings the review still reports. */
export function threadAction(t: ReviewThread, open: Set<string>): ThreadAction | null {
  const found = threadFinding(t);
  if (!found) return null;
  const closed = readClosed(found.body);
  const answeredBefore = t.comments.nodes.some((c) => c.body.includes(GONE_MARKER));
  if (closed) {
    if (open.has(found.id)) return { kind: "regressed", unresolve: closed.how === "fixed" && t.isResolved };
    // resolved=0 means GitHub wouldn't let the workflow resolve it, so an open thread doesn't mean anyone reopened it.
    return !t.isResolved && closed.resolved ? { kind: "reopened" } : null;
  }
  if (t.isResolved) {
    if (open.has(found.id)) return null;
    return answeredBefore ? { kind: "fixed", resolve: false } : { kind: "resolved" };
  }
  if (answeredBefore || found.body.includes(REOPENED_MARKER)) return null;
  return t.isOutdated && !open.has(found.id) ? { kind: "fixed", resolve: true } : null;
}

/**
 * Findings whose thread someone with write access resolved, with who did it. The
 * verifier hears about these as a team decision, so a pull request's own author
 * can't talk it out of a finding: GitHub lets them resolve threads too.
 */
/** Mergelight's reply in a thread, once a person's reason there is remembered. */
export const REMEMBERED_MARKER = "<!-- mergelight:remembered -->";

/**
 * The reason a person gave when they resolved a thread: their own replies in it. Only a reply by
 * the person who resolved it counts, so a reason can't come from someone who couldn't have decided.
 * resolved: who resolved each finding's thread, from resolvedByPeople.
 */
/**
 * Whether Mergelight already said in this thread that the server kept its reason. A thread is answered
 * once: a later reply doesn't replace the kept reason. Only Mergelight's own answer counts, by the login
 * that posted the finding.
 */
export function answeredRemembered(t: ReviewThread): boolean {
  const nodes = t.comments.nodes;
  const own = nodes[0]?.author?.login;
  return Boolean(own) && nodes.some((c, i) => i > 0 && c.author?.login === own && c.body.includes(REMEMBERED_MARKER));
}

export function resolverReplies(threads: ReviewThread[], resolved: Map<string, string>, mergelight?: string): Map<string, { replies: { text: string; at: string }[]; commentId: number; answered: boolean }> {
  const out = new Map<string, { replies: { text: string; at: string }[]; commentId: number; answered: boolean }>();
  for (const t of threads) {
    const found = threadFinding(t);
    // Only a thread Mergelight started: a member who can't push could start one with a copied marker, and
    // so could another app. GitHub names a bot without "[bot]" in one API and with it in the other.
    const starter = t.comments.nodes[0]?.author;
    const bare = (login: string | undefined) => login?.replace(/\[bot\]$/, "");
    if (!found || starter?.__typename !== "Bot" || (mergelight && bare(starter.login) !== bare(mergelight))) continue;
    const by = resolved.get(found.id);
    if (!by || t.resolvedBy?.login !== by) continue;
    const own = t.comments.nodes
      .slice(1)
      .filter((c) => c.author?.__typename === "User" && c.author.login === by && c.createdAt && c.body.trim() && !c.body.includes("<!-- mergelight:"));
    // All of their replies, in order: a later "thanks" mustn't replace the reason.
    const answered = answeredRemembered(t);
    // An edited reply counts from its edit: a reason added later is new.
    // Quoted lines (a "Quote reply" of the finding, say) are left out: they aren't what the person said.
    const said = (body: string) => body.split("\n").filter((l) => !/^\s*>/.test(l)).join("\n").trim();
    const replies = own.map((c) => ({ text: said(c.body), at: c.lastEditedAt ?? c.createdAt! })).filter((r) => r.text);
    if (replies.length) out.set(found.id, { replies, commentId: found.commentId, answered });
  }
  return out;
}

/**
 * Whether a diff of one file touches lines start to end of the old side. From a patch's hunk headers,
 * so context lines count too: a near miss counts as touched, never the other way round.
 */
export function patchTouches(patch: string, start: number, end: number): boolean {
  for (const m of patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm)) {
    const from = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    const to = from + Math.max(count, 1) - 1;
    if (from <= end && to >= start) return true;
  }
  return false;
}

export async function resolvedByPeople(threads: ReviewThread[], canWrite: (login: string) => Promise<boolean>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const t of threads) {
    const found = threadFinding(t);
    const by = t.resolvedBy?.login;
    if (!found || !t.isResolved || !by) continue;
    if (readClosed(found.body)?.how === "fixed" || t.comments.nodes.some((c) => c.body.includes(GONE_MARKER))) continue;
    if (await canWrite(by)) out.set(found.id, by);
  }
  return out;
}
