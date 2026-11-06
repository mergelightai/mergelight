import type { Finding, Light, Review } from "../types.js";
import type { PriorFinding } from "../prompt.js";
import { GitHub, type ApiOptions } from "./api.js";
import { commentableLines, place } from "./diff-lines.js";
import { FINDING_MARKER_RE, headline, inlineBody, LIGHT, SUMMARY_MARKER, summaryBody } from "./markdown.js";
import { decodeState, nextState } from "./state.js";

export const CHECK_NAME = "Mergelight";

/**
 * How each merge light shows up as a GitHub check. action_required doesn't
 * count as passing, so a required check holds the merge until a human approves
 * the PR, which flips it to success (see approveCheck).
 */
const CONCLUSION: Record<Light, "success" | "action_required" | "failure"> = {
  green: "success",
  yellow: "action_required",
  red: "failure",
};

interface Commenter {
  user?: { type?: string } | null;
  author_association?: string;
}

interface IssueComment extends Commenter {
  id: number;
  body?: string;
  html_url: string;
}

interface ReviewComment extends Commenter {
  id: number;
  body: string;
  html_url: string;
  pull_request_review_id: number | null;
}

/**
 * Whether Mergelight's hidden markers in this comment count. Anyone can write a
 * comment containing them, and they steer what gets posted and what the verifier
 * reads, so a passer-by's comment must not be taken for ours.
 */
export function trustedComment(c: Commenter): boolean {
  return c.user?.type === "Bot" || ["OWNER", "MEMBER", "COLLABORATOR"].includes(c.author_association ?? "");
}

const MAX_PREVIOUS = 40;

/** What earlier rounds found on this PR, latest first, for the verifier to check again. */
export async function previousFindings(api: GitHub, number: number): Promise<PriorFinding[]> {
  const comments = await api.list<IssueComment>(`issues/${number}/comments`);
  const state = decodeState(comments.find((c) => trustedComment(c) && c.body?.includes(SUMMARY_MARKER))?.body);
  return (state?.findings ?? [])
    .sort((a, b) => Number(a.status === "gone") - Number(b.status === "gone"))
    .slice(0, MAX_PREVIOUS)
    .map(({ id, title, file, line, end_line, how }) => ({ id, title, file, line, end_line, how }));
}

interface CheckRun {
  id: number;
  name: string;
  conclusion: string | null;
  started_at: string;
  output: { title: string | null; summary: string | null };
}

export interface PublishResult {
  summaryUrl: string | null;
  inline: number;
  outside: number;
  resolved: number;
  light: Light;
}

/** Shows a live "Reviewing" check right away, so people and agents can see work is happening. */
export async function startCheck(api: GitHub, headSha: string): Promise<number | null> {
  const run = await api.write<CheckRun>("POST", "check-runs", {
    name: CHECK_NAME,
    head_sha: headSha,
    status: "in_progress",
    started_at: new Date().toISOString(),
    output: {
      title: "Reviewing",
      summary: "Mergelight is reviewing this pull request with Codex on your own plan. This usually takes 2 to 15 minutes.",
    },
  });
  return run?.id ?? null;
}

/**
 * A review that couldn't run ends neutral, so a broken login doesn't block
 * merging. The workflow job itself still fails, so it's visible.
 */
export async function failCheck(api: GitHub, checkRunId: number | null, headSha: string, reason: string): Promise<void> {
  const body = {
    status: "completed",
    conclusion: "neutral",
    completed_at: new Date().toISOString(),
    output: {
      title: "Couldn't review this pull request",
      summary: `${reason.slice(0, 2000)}\n\nThis check is neutral so a broken review doesn't block merging. The workflow log has the details.`,
    },
  };
  if (checkRunId) await api.write("PATCH", `check-runs/${checkRunId}`, body);
  else await api.write("POST", "check-runs", { name: CHECK_NAME, head_sha: headSha, ...body });
}

export async function publishReview(
  review: Review,
  opts: ApiOptions & { checkRunId?: number | null } = {},
): Promise<PublishResult> {
  const log = opts.log ?? (() => {});
  const api = new GitHub(review.pr.owner, review.pr.repo, opts);
  const n = review.pr.number;

  // What's already on the PR: the summary comment with last round's state, and inline findings.
  const issueComments = await api.list<IssueComment>(`issues/${n}/comments`);
  const summary = issueComments.find((c) => trustedComment(c) && c.body?.includes(SUMMARY_MARKER));
  const prev = decodeState(summary?.body);
  const reviewComments = await api.list<ReviewComment>(`pulls/${n}/comments`);
  const urls = new Map<string, string>();
  for (const c of reviewComments) {
    if (!trustedComment(c)) continue;
    const id = c.body.match(FINDING_MARKER_RE)?.[1];
    if (id && !urls.has(id)) urls.set(id, c.html_url);
  }

  // New top picks go inline, if their lines are in the diff. A finding from an earlier
  // round stays where it is, even if the verifier ranks it higher now: the reader has
  // seen it, and a new comment on old code is just more noise.
  const lines = await commentableLines(api, n);
  const seen = new Set(prev?.findings.map((f) => f.id));
  const fresh = review.findings.filter((f) => f.tier === "post" && !urls.has(f.id) && !seen.has(f.id));
  const inline: { f: Finding; comment: Record<string, unknown> }[] = [];
  const outside: Finding[] = [];
  for (const f of fresh) {
    const at = place(lines, f.file, f.line, f.end_line);
    if (!at) {
      outside.push(f);
      continue;
    }
    inline.push({
      f,
      comment: {
        path: f.file,
        side: "RIGHT",
        line: at.line,
        ...(at.start_line ? { start_line: at.start_line, start_side: "RIGHT" } : {}),
        body: inlineBody(f),
      },
    });
  }

  if (inline.length) {
    const body = {
      commit_id: review.pr.head_sha,
      event: "COMMENT",
      body: `Mergelight posted ${inline.length} new finding${inline.length === 1 ? "" : "s"} worth fixing. The Mergelight summary comment has the full review.`,
      comments: inline.map((i) => i.comment),
    };
    try {
      const posted = await api.write<{ id: number }>("POST", `pulls/${n}/reviews`, body);
      if (posted) {
        for (const c of await api.list<ReviewComment>(`pulls/${n}/reviews/${posted.id}/comments`)) {
          const id = c.body.match(FINDING_MARKER_RE)?.[1];
          if (id) urls.set(id, c.html_url);
        }
      }
    } catch (err) {
      // One line GitHub won't take rejects the whole review. List them in the summary instead.
      log(`Inline review rejected, listing findings in the summary instead: ${(err as Error).message}`);
      outside.push(...inline.map((i) => i.f));
      inline.length = 0;
    }
  }

  const resolved = await resolveFixedThreads(api, review, log);

  const state = nextState(prev, review.findings, review.pr.head_sha, review.light, urls);
  const summaryInput = { review, state, urls };
  const commentBody = summaryBody(summaryInput);
  let summaryUrl: string | null = summary?.html_url ?? null;
  if (summary) {
    await api.write("PATCH", `issues/comments/${summary.id}`, { body: commentBody });
  } else {
    const created = await api.write<IssueComment>("POST", `issues/${n}/comments`, { body: commentBody });
    summaryUrl = created?.html_url ?? null;
  }

  const light = LIGHT[review.light];
  const check = {
    status: "completed",
    conclusion: CONCLUSION[review.light],
    completed_at: new Date().toISOString(),
    ...(summaryUrl ? { details_url: summaryUrl } : {}),
    output: {
      title: `${light.dot} ${light.label}: ${headline(review)}`,
      summary: summaryBody(summaryInput, false).replace(SUMMARY_MARKER, "").slice(0, 65_000),
    },
  };
  if (opts.checkRunId) await api.write("PATCH", `check-runs/${opts.checkRunId}`, check);
  else await api.write("POST", "check-runs", { name: CHECK_NAME, head_sha: review.pr.head_sha, ...check });

  return { summaryUrl, inline: inline.length, outside: outside.length, resolved, light: review.light };
}

const GONE_MARKER = "<!-- mergelight:gone -->";

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  comments: { nodes: { databaseId: number; body: string; authorAssociation?: string; author?: { __typename?: string } | null }[] };
}

/**
 * The comment to answer if this thread's finding is fixed: gone from the review,
 * and its code changed. Both are required: a finding can drop out of a review
 * without being fixed, so an untouched line keeps its thread open. Mergelight
 * only closes a thread once, so it doesn't repeat itself or overrule someone who
 * reopened it.
 */
export function fixedThreadComment(t: ReviewThread, open: Set<string>): number | null {
  const first = t.comments.nodes[0];
  if (!first || t.isResolved || !t.isOutdated) return null;
  if (!trustedComment({ user: { type: first.author?.__typename }, author_association: first.authorAssociation })) return null;
  const id = first.body.match(FINDING_MARKER_RE)?.[1];
  if (!id || open.has(id) || t.comments.nodes.some((c) => c.body.includes(GONE_MARKER))) return null;
  return first.databaseId;
}

/** Answers and resolves Mergelight threads whose finding is fixed. */
async function resolveFixedThreads(api: GitHub, review: Review, log: (s: string) => void): Promise<number> {
  const open = new Set(review.findings.map((f) => f.id));
  type Threads = { repository: { pullRequest: { reviewThreads: { nodes: ReviewThread[] } } } };
  let data: Threads | null;
  try {
    data = await api.graphql<Threads>(
      `query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            reviewThreads(first: 100) {
              nodes { id isResolved isOutdated comments(first: 50) { nodes { databaseId body authorAssociation author { __typename } } } }
            }
          }
        }
      }`,
      { owner: review.pr.owner, repo: review.pr.repo, number: review.pr.number },
    );
  } catch (err) {
    log(`Couldn't read review threads: ${(err as Error).message}`);
    return 0;
  }
  let resolved = 0;
  for (const t of data?.repository.pullRequest.reviewThreads.nodes ?? []) {
    const comment = fixedThreadComment(t, open);
    if (comment === null) continue;
    try {
      await api.write("POST", `pulls/${review.pr.number}/comments/${comment}/replies`, {
        body: `${GONE_MARKER}\nThe code here changed and Mergelight no longer finds this in \`${review.pr.head_sha.slice(0, 7)}\`.`,
      });
      await api.graphql(`mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }`, { id: t.id }, true);
      resolved++;
    } catch (err) {
      // GitHub only lets a workflow token resolve threads with contents: write. The reply still stands.
      const hint = /not accessible by integration/i.test((err as Error).message) ? "the workflow needs contents: write for that" : (err as Error).message;
      log(`Answered a fixed thread but couldn't mark it resolved: ${hint}`);
    }
  }
  return resolved;
}

/**
 * When someone approves a PR whose check is waiting on a human, the check turns
 * green. A blocked check (a bug to fix) stays red.
 */
export async function approveCheck(api: GitHub, number: number, by: string): Promise<string> {
  const pr = await api.get<{ head: { sha: string } }>(`pulls/${number}`);
  const runs = await api.get<{ check_runs: CheckRun[] }>(`commits/${pr.head.sha}/check-runs?check_name=${CHECK_NAME}`);
  const latest = [...runs.check_runs].sort((a, b) => b.id - a.id)[0];
  if (!latest) return "No Mergelight check on this commit.";
  if (latest.conclusion !== "action_required") return `Mergelight check is ${latest.conclusion ?? "still running"}, nothing to approve.`;
  const body = {
    conclusion: "success",
    output: {
      title: `🟢 Approved by ${by}`,
      summary: `Approved by ${by} after the Mergelight review.\n\n${latest.output.summary ?? ""}`.slice(0, 65_000),
    },
  };
  try {
    await api.write("PATCH", `check-runs/${latest.id}`, body);
  } catch {
    await api.write("POST", "check-runs", {
      name: CHECK_NAME,
      head_sha: pr.head.sha,
      status: "completed",
      completed_at: new Date().toISOString(),
      ...body,
    });
  }
  return `Mergelight check approved by ${by}.`;
}
