import type { GitHub } from "./api.js";
import type { StateFinding } from "./state.js";

/**
 * How someone says a finding is dealt with: a comment with a hidden marker, by
 * the person's own login. Comments only get added, so a review publishing at the
 * same moment can't lose a mark, and GitHub records who wrote it. The next review
 * reads the marks and checks them, like everything else it checks again.
 */

export interface Commenter {
  user?: { type?: string; login?: string } | null;
  author_association?: string;
}

export interface PrComment extends Commenter {
  id: number;
  body?: string;
  html_url: string;
  created_at?: string;
}

/**
 * Whether Mergelight's hidden markers in this comment count. Anyone can write a
 * comment containing them, and they steer what gets posted and what the verifier
 * reads, so a passer-by's comment must not be taken for ours.
 */
export function trustedComment(c: Commenter): boolean {
  return c.user?.type === "Bot" || ["OWNER", "MEMBER", "COLLABORATOR"].includes(c.author_association ?? "");
}

/**
 * Who can write to the repository. A workflow token sees a private org member as
 * CONTRIBUTOR, so the association alone would silently drop their marks.
 */
export function writeAccess(api: GitHub): (login: string) => Promise<boolean> {
  const known = new Map<string, Promise<boolean>>();
  return (login) => {
    let answer = known.get(login);
    if (!answer) {
      answer = api
        .get<{ permission?: string }>(`collaborators/${encodeURIComponent(login)}/permission`)
        .then((r) => r.permission === "admin" || r.permission === "write")
        .catch(() => false);
      known.set(login, answer);
    }
    return answer;
  };
}

/** fixed: the code changed, the next review checks it. wont_fix: someone decided to leave it, and said why. */
export type HandledAs = "fixed" | "wont_fix";

export interface Mark {
  id: string;
  as: HandledAs;
  note: string | null;
  /** The pull request's latest commit when it was marked. */
  sha: string | null;
  by: string;
  at: string;
  url: string;
}

const MARK_RE = /<!-- mergelight:handled:v1 ([A-Za-z0-9+/=]+) -->/;
export const MAX_NOTE = 1000;

export function encodeMark(ids: string[], as: HandledAs, note: string | null, sha: string): string {
  return `<!-- mergelight:handled:v1 ${Buffer.from(JSON.stringify({ ids, as, note, sha })).toString("base64")} -->`;
}

export function decodeMark(body: string | undefined): Pick<Mark, "as" | "note" | "sha"> & { ids: string[] } | null {
  const m = body?.match(MARK_RE);
  if (!m) return null;
  try {
    const { ids, as, note, sha } = JSON.parse(Buffer.from(m[1]!, "base64").toString("utf8"));
    if (!Array.isArray(ids) || (as !== "fixed" && as !== "wont_fix")) return null;
    return {
      ids: ids.filter((id): id is string => typeof id === "string" && /^[a-f0-9]+$/.test(id)),
      as,
      note: typeof note === "string" ? note.slice(0, MAX_NOTE) : null,
      sha: typeof sha === "string" ? sha : null,
    };
  } catch {
    return null;
  }
}

/**
 * The latest mark per finding, from comments by people who can write to the repository.
 * A person's association isn't enough: MEMBER means a member of the org, who may only be able to read
 * this repository, and a won't-fix mark tells the verifier the team decided. So every person is asked
 * about. Bots are the exception: one can only comment where it was installed.
 */
export async function readMarks(comments: PrComment[], canWrite: (login: string) => Promise<boolean>): Promise<Map<string, Mark>> {
  const marked = comments
    .map((comment) => ({ comment, mark: decodeMark(comment.body) }))
    .filter((c) => c.mark)
    .sort((a, b) => Date.parse(a.comment.created_at ?? "") - Date.parse(b.comment.created_at ?? ""));
  const marks = new Map<string, Mark>();
  for (const { comment, mark } of marked) {
    const by = comment.user?.login ?? "";
    if (comment.user?.type !== "Bot" && !(by && (await canWrite(by)))) continue;
    for (const id of mark!.ids) {
      marks.set(id, { id, as: mark!.as, note: mark!.note, sha: mark!.sha, by, at: comment.created_at ?? "", url: comment.html_url });
    }
  }
  return marks;
}

/**
 * Where a finding stands, given the latest review and its mark.
 * open: found, nobody dealt with it. still_found: marked fixed, then a later review found it anyway.
 * fix_pending: marked fixed, no review since. wont_fix: someone decided to leave it. gone: no longer found.
 */
export type FindingState = "open" | "still_found" | "fix_pending" | "wont_fix" | "gone";

export function findingState(f: Pick<StateFinding, "status">, mark: Mark | undefined, lastReviewAt: string | undefined): FindingState {
  if (mark?.as === "wont_fix") return "wont_fix";
  if (f.status === "gone") return "gone";
  if (!mark) return "open";
  return markedSince(mark, lastReviewAt) ? "fix_pending" : "still_found";
}

/** True if the latest review published before this mark, so it can't have taken it into account. */
export function markedSince(mark: Mark, lastReviewAt: string | undefined): boolean {
  return !lastReviewAt || Date.parse(mark.at) > Date.parse(lastReviewAt);
}
