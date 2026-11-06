import type { Finding, Light, Review } from "../types.js";
import type { PriorFinding } from "../prompt.js";
import { GitHub, type ApiOptions } from "./api.js";
import { commentableLines, place } from "./diff-lines.js";
import { closedBody, readClosed, reopenedBody, resolvedByPeople, threadAction, threadFinding, type Handled, type ReviewThread } from "./closed.js";
import { failedSummaryBody, FINDING_MARKER_RE, headline, inlineBody, isPendingSummary, LIGHT, pendingSummaryBody, SUMMARY_MARKER, summaryBody } from "./markdown.js";
import { readMarks, trustedComment, writeAccess, type Mark, type PrComment } from "./handled.js";
import { decodeState, nextState, type ReviewState, type StateFinding } from "./state.js";

export { trustedComment } from "./handled.js";
export type { ReviewThread } from "./closed.js";

export const CHECK_NAME = "Mergelight";

/**
 * How each merge light shows up as a GitHub check. Yellow is neutral, which
 * GitHub counts as passing: a solo developer can't approve their own PR, so
 * yellow must not wait for an approval unless a team asks for that. Then it's
 * action_required, which doesn't pass until someone approves (see approveCheck).
 */
export function checkConclusion(light: Light, yellowBlocks = false): "success" | "neutral" | "action_required" | "failure" {
  if (light === "green") return "success";
  if (light === "red") return "failure";
  return yellowBlocks ? "action_required" : "neutral";
}

interface ReviewComment extends PrComment {
  body: string;
  pull_request_review_id: number | null;
}

export interface PrReviewState {
  /** The summary comment, with last round's state. */
  summary: PrComment | undefined;
  state: ReviewState | null;
  marks: Map<string, Mark>;
  reviewComments: ReviewComment[];
}

/** What Mergelight has on this PR so far. Reviews read it before they publish, and the MCP server hands it to agents. */
export async function readPrReviewState(api: GitHub, number: number): Promise<PrReviewState> {
  const issueComments = await api.list<PrComment>(`issues/${number}/comments`);
  const reviewComments = await api.list<ReviewComment>(`pulls/${number}/comments`);
  const summary = issueComments.find((c) => trustedComment(c) && c.body?.includes(SUMMARY_MARKER));
  const marks = await readMarks([...issueComments, ...reviewComments], writeAccess(api));
  return { summary, state: decodeState(summary?.body), marks, reviewComments };
}

const MAX_PREVIOUS = 40;

/** What earlier rounds found on this PR, latest first, for the verifier to check again. */
export async function previousFindings(api: GitHub, number: number): Promise<PriorFinding[]> {
  const { state, marks } = await readPrReviewState(api, number);
  const resolved = await resolvedByPeople(await reviewThreads(api, number).catch(() => []), writeAccess(api));
  // A decision not to fix must reach the verifier however long the list gets, or the problem comes back as new.
  const order = (f: StateFinding) => (marks.get(f.id)?.as === "wont_fix" || resolved.has(f.id) ? 0 : f.status === "gone" ? 2 : 1);
  return (state?.findings ?? [])
    .sort((a, b) => order(a) - order(b))
    .slice(0, MAX_PREVIOUS)
    .map(({ id, title, file, line, end_line, how }) => {
      const mark = marks.get(id);
      const by = resolved.get(id);
      const handled = mark
        ? { as: mark.as, note: mark.note, by: mark.by, sha: mark.sha }
        : by
          ? { as: "wont_fix" as const, note: "Resolved the comment on the pull request.", by, sha: null }
          : undefined;
      return { id, title, file, line, end_line, how, ...(handled ? { handled } : {}) };
    });
}

export const CHECK_FAILED_TITLE = "Couldn't review this pull request";

export interface CheckRun {
  id: number;
  name: string;
  status?: string;
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

/** Puts the summary comment on the PR before anything else, so it comes first. Later rounds edit it in place. */
export async function startSummary(api: GitHub, number: number): Promise<PrComment | null> {
  const { summary } = await readPrReviewState(api, number);
  return summary ?? (await api.write<PrComment>("POST", `issues/${number}/comments`, { body: pendingSummaryBody() }));
}

/** A first review that couldn't run shouldn't say "Reviewing" forever. An earlier round's results stay as they are. */
export async function failSummary(api: GitHub, number: number): Promise<void> {
  const { summary } = await readPrReviewState(api, number);
  if (summary && isPendingSummary(summary.body)) await api.write("PATCH", `issues/comments/${summary.id}`, { body: failedSummaryBody() });
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
      title: CHECK_FAILED_TITLE,
      summary: `${reason.slice(0, 2000)}\n\nThis check is neutral so a broken review doesn't block merging. The workflow log has the details.`,
    },
  };
  if (checkRunId) await api.write("PATCH", `check-runs/${checkRunId}`, body);
  else await api.write("POST", "check-runs", { name: CHECK_NAME, head_sha: headSha, ...body });
}

export async function publishReview(
  review: Review,
  opts: ApiOptions & { checkRunId?: number | null; yellowBlocks?: boolean } = {},
): Promise<PublishResult> {
  const log = opts.log ?? (() => {});
  const api = new GitHub(review.pr.owner, review.pr.repo, opts);
  const n = review.pr.number;

  // What's already on the PR: the summary comment with last round's state, and inline findings.
  const { summary: existing, state: prev, marks, reviewComments } = await readPrReviewState(api, n);
  // The summary goes up before the inline comments, so it stays on top of them.
  const summary = existing ?? (await api.write<PrComment>("POST", `issues/${n}/comments`, { body: pendingSummaryBody() }));
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

  const { handled, resolved } = await settleThreads(api, review, log);

  const state = nextState(prev, review.findings, review.pr.head_sha, review.light, urls);
  const summaryInput = { review, state, urls, marks, handled };
  const commentBody = summaryBody(summaryInput);
  let summaryUrl: string | null = summary?.html_url ?? null;
  if (summary) {
    await api.write("PATCH", `issues/comments/${summary.id}`, { body: commentBody });
  } else {
    const created = await api.write<PrComment>("POST", `issues/${n}/comments`, { body: commentBody });
    summaryUrl = created?.html_url ?? null;
  }

  const light = LIGHT[review.light];
  const check = {
    status: "completed",
    conclusion: checkConclusion(review.light, opts.yellowBlocks),
    completed_at: new Date().toISOString(),
    ...(summaryUrl ? { details_url: summaryUrl } : {}),
    output: {
      title: `${light.dot} ${light.label}: ${headline(review, handled.size)}`,
      summary: summaryBody(summaryInput, false).replace(SUMMARY_MARKER, "").slice(0, 65_000),
    },
  };
  if (opts.checkRunId) await api.write("PATCH", `check-runs/${opts.checkRunId}`, check);
  else await api.write("POST", "check-runs", { name: CHECK_NAME, head_sha: review.pr.head_sha, ...check });

  return { summaryUrl, inline: inline.length, outside: outside.length, resolved, light: review.light };
}

export async function reviewThreads(api: GitHub, number: number): Promise<ReviewThread[]> {
  type Threads = { repository: { pullRequest: { reviewThreads: { nodes: ReviewThread[] } } } };
  const data = await api.graphql<Threads>(
    `query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: 100) {
            nodes { id isResolved isOutdated resolvedBy { login } comments(first: 50) { nodes { databaseId body authorAssociation author { __typename } } } }
          }
        }
      }
    }`,
    { owner: api.owner, repo: api.repo, number },
  );
  return data?.repository.pullRequest.reviewThreads.nodes ?? [];
}

export const resolveThread = (api: GitHub, id: string) =>
  api.graphql(`mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }`, { id }, true);

const unresolveThread = (api: GitHub, id: string) =>
  api.graphql(`mutation($id: ID!) { unresolveReviewThread(input: { threadId: $id }) { thread { id } } }`, { id }, true);

/**
 * Brings inline comments in line with the threads: fixed or resolved ones get a
 * checkmark and a dropdown, and reopened or returning ones go back to the
 * original. Returns what counts as handled now, for the summary.
 */
async function settleThreads(api: GitHub, review: Review, log: (s: string) => void): Promise<{ handled: Map<string, Handled>; resolved: number }> {
  const handled = new Map<string, Handled>();
  let resolved = 0;
  let threads: ReviewThread[];
  try {
    threads = await reviewThreads(api, review.pr.number);
  } catch (err) {
    log(`Couldn't read review threads: ${(err as Error).message}`);
    return { handled, resolved };
  }
  const open = new Set(review.findings.map((f) => f.id));
  const sha = review.pr.head_sha.slice(0, 7);
  const canWrite = writeAccess(api);
  const edit = (commentId: number, body: string) =>
    api.write("PATCH", `pulls/comments/${commentId}`, { body }).catch((err) => log(`Couldn't update a comment: ${(err as Error).message}`));

  for (const t of threads) {
    const found = threadFinding(t);
    if (!found) continue;
    const by = t.resolvedBy?.login ?? null;
    const action = threadAction(t, open);
    if (!action) {
      const was = readClosed(found.body);
      if (was) handled.set(found.id, { how: was.how, by, sha: was.sha });
      continue;
    }
    if (action.kind === "fixed") {
      let isResolved = !action.resolve;
      if (action.resolve) {
        try {
          await resolveThread(api, t.id);
          isResolved = true;
          resolved++;
        } catch (err) {
          // GitHub only lets a workflow token resolve threads with contents: write. The comment still says it's handled.
          const hint = /not accessible by integration/i.test((err as Error).message) ? "the workflow needs contents: write for that" : (err as Error).message;
          log(`Couldn't mark a fixed thread resolved: ${hint}`);
        }
      }
      handled.set(found.id, { how: "fixed", sha });
      await edit(found.commentId, closedBody(found.body, { how: "fixed", resolved: isResolved, sha }));
    } else if (action.kind === "resolved") {
      // A workflow token sees a private org member as CONTRIBUTOR, so ask who can write instead of trusting the association.
      if (!by || !(await canWrite(by))) continue;
      handled.set(found.id, { how: "resolved", by });
      await edit(found.commentId, closedBody(found.body, { how: "resolved", resolved: true, by }));
    } else {
      if (action.kind === "regressed" && action.unresolve) {
        await unresolveThread(api, t.id).catch((err) => log(`Couldn't reopen a thread: ${(err as Error).message}`));
      }
      await edit(found.commentId, reopenedBody(found.body, action.kind === "reopened"));
    }
  }
  return { handled, resolved };
}

/** A yellow check. A review that couldn't run also ends neutral, but an approval says nothing about that. */
export function isYellowCheck(check: { conclusion: string | null; output: { title: string | null } }): boolean {
  return check.conclusion === "action_required" || (check.conclusion === "neutral" && Boolean(check.output.title?.startsWith(LIGHT.yellow.dot)));
}

/** The newest Mergelight check on a commit. */
export async function latestCheck(api: GitHub, sha: string): Promise<CheckRun | undefined> {
  const runs = await api.get<{ check_runs: CheckRun[] }>(`commits/${sha}/check-runs?check_name=${CHECK_NAME}`);
  return [...runs.check_runs].sort((a, b) => b.id - a.id)[0];
}

/** When someone approves a PR with a yellow check, it turns green. A blocked check (a bug to fix) stays red. */
export async function approveCheck(api: GitHub, number: number, by: string): Promise<string> {
  const pr = await api.get<{ head: { sha: string } }>(`pulls/${number}`);
  const latest = await latestCheck(api, pr.head.sha);
  if (!latest) return "No Mergelight check on this commit.";
  if (!isYellowCheck(latest)) return `Mergelight check is ${latest.conclusion ?? "still running"}, nothing to approve.`;
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
