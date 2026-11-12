import type { Finding, Light, Review } from "../types.js";
import { RESOLVED_ONLY, type PriorFinding } from "../prompt.js";
import { GitHub, type ApiOptions } from "./api.js";
import { commentableLines, place } from "./diff-lines.js";
import { answeredRemembered, closedBody, patchTouches, readClosed, REMEMBERED_MARKER, reopenedBody, resolvedByPeople, resolverReplies, threadAction, threadFinding, type Handled, type ReviewThread } from "./closed.js";
import type { FailureNotice } from "./markdown.js";
import { failedSummaryBody, FINDING_MARKER_RE, headline, inlineBody, isFailedSummary, isPendingSummary, LIGHT, pendingSummaryBody, SUMMARY_MARKER, summaryBody, type ReviewPlan } from "./markdown.js";
import { askWriteAccess, MAX_NOTE, readMarks, trustedComment, writeAccess, type Mark, type PrComment } from "./handled.js";
import { withoutHidden } from "../skills.js";
import { decodeState, nextState, stateBlock, type ReviewState, type StateFinding } from "./state.js";
import { newerVersion } from "../update.js";

export { trustedComment } from "./handled.js";
export type { ReviewThread } from "./closed.js";

export const CHECK_NAME = "Mergelight";

/**
 * How each merge light shows up as a GitHub check. Red and yellow are neutral, which GitHub counts as
 * passing and shows without a red cross: a review is a judgment, not a failed build, and the title
 * still says what it found. A team that wants the check to hold merges sets yellowBlocks: then yellow
 * is action_required, which doesn't pass until someone approves (see approveCheck), and red fails
 * until the code changes.
 */
export function checkConclusion(light: Light, yellowBlocks = false): "success" | "neutral" | "action_required" | "failure" {
  if (light === "green") return "success";
  if (light === "red") return yellowBlocks ? "failure" : "neutral";
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

/**
 * The summary comment, which Mergelight edits and reads its state from. Only a bot's comment or the
 * current login's own counts. A person's association isn't enough: a teammate who wrote the marker
 * could edit the comment later, and change a login code people are told to enter.
 */
export async function ownSummary(comments: PrComment[], viewer: () => Promise<string | null>): Promise<PrComment | undefined> {
  const marked = comments.filter((c) => c.body?.includes(SUMMARY_MARKER));
  const bots = marked.find((c) => c.user?.type === "Bot");
  if (bots || !marked.length) return bots;
  const me = await viewer();
  return me ? marked.find((c) => c.user?.login === me) : undefined;
}

/** What Mergelight has on this PR so far. Reviews read it before they publish, and the MCP server hands it to agents. */
export async function readPrReviewState(api: GitHub, number: number): Promise<PrReviewState> {
  const issueComments = await api.list<PrComment>(`issues/${number}/comments`);
  const reviewComments = await api.list<ReviewComment>(`pulls/${number}/comments`);
  const summary = await ownSummary(issueComments, () => api.viewer());
  const marks = await readMarks([...issueComments, ...reviewComments], askWriteAccess(api));
  return { summary, state: decodeState(summary?.body), marks, reviewComments };
}

const MAX_PREVIOUS = 40;

/**
 * Whether the code at a finding is as the latest review saw it. Asked of GitHub once, for the whole
 * change since then. Anything it can't tell counts as changed.
 */
function unchangedSince(api: GitHub, since: string | undefined, headSha: string | undefined): (f: Pick<StateFinding, "file" | "line" | "end_line">) => Promise<boolean> {
  if (!since || !headSha) return async () => false;
  if (since === headSha) return async () => true;
  type Compare = { status?: string; files?: { filename: string; previous_filename?: string; patch?: string }[] };
  let files: Promise<Map<string, string | null> | null> | undefined;
  return async (f) => {
    files ??= api
      .get<Compare>(`compare/${since}...${headSha}`)
      .then((r) => {
        // Only a head that builds on the reviewed commit gives line numbers that match the finding's. After a
        // force-push the diff starts somewhere else. GitHub also lists at most 300 files: past that, a file
        // that isn't listed may still have changed.
        if (r.status !== "ahead" || !r.files || r.files.length >= 300) return null;
        const out = new Map<string, string | null>();
        for (const file of r.files) {
          out.set(file.filename, file.patch ?? null);
          if (file.previous_filename) out.set(file.previous_filename, null);
        }
        return out;
      })
      .catch(() => null);
    const changed = await files;
    if (!changed) return false;
    if (!changed.has(f.file)) return true;
    const patch = changed.get(f.file);
    return patch ? !patchTouches(patch, f.line, f.end_line ?? f.line) : false;
  };
}

/**
 * What earlier rounds found on this PR, latest first, for the verifier to check again.
 * headSha: the commit this review is about, to tell a reason from a fix.
 */
export async function previousFindings(api: GitHub, number: number, headSha?: string): Promise<PriorFinding[]> {
  const { summary, state, marks } = await readPrReviewState(api, number);
  const threads = await reviewThreads(api, number).catch(() => []);
  const resolved = await resolvedByPeople(threads, writeAccess(api));
  // Mergelight's own login is the one its summary comment carries.
  const replies = resolverReplies(threads, resolved, summary?.user?.login ?? undefined);
  const latest = state?.rounds.at(-1);
  const waiting = new Map((state?.remember ?? []).map((r) => [r.id, r]));
  const unchanged = unchangedSince(api, latest?.sha, headSha);
  // A decision not to fix must reach the verifier however long the list gets, or the problem comes back as new.
  const order = (f: StateFinding) => (marks.get(f.id)?.as === "wont_fix" || resolved.has(f.id) ? 0 : f.status === "gone" ? 2 : 1);
  const kept = (state?.findings ?? []).sort((a, b) => order(a) - order(b)).slice(0, MAX_PREVIOUS);
  return Promise.all(
    kept.map(async (f) => {
      const { id, title, file, line, end_line, how } = f;
      const mark = marks.get(id);
      const by = resolved.get(id);
      const reply = replies.get(id);
      // What the resolver wrote reaches the verifier, which reads it against the code: a reason, a fix
      // note or neither. All of their replies, so a later "thanks" doesn't hide the reason.
      const all = reply?.replies ?? [];
      const last = all.at(-1);
      // A candidate to keep for later pull requests: written since the latest review (one from before may
      // answer an older round), on code that didn't change since then (the reply may describe the fix),
      // in a thread Mergelight hasn't answered yet (a later reply mustn't overwrite a kept reason, or bring
      // back one forgotten on the dashboard). Whether it is kept is the verifier's call, after the review.
      const fresh = all.filter((r) => latest && Date.parse(r.at) > Date.parse(latest.at));
      // One an earlier review kept, that the server hasn't confirmed: sent again, by at most MAX_TRIES
      // reviews, so one failed report doesn't lose it and a silent server doesn't get it forever.
      const wait = waiting.get(id);
      const open = Boolean(last) && !reply!.answered;
      // A later reply, such as a "thanks", doesn't cancel it: the verifier reads all of them again.
      const pending = open && Boolean(wait) && Date.parse(wait!.at) <= Date.parse(last!.at) && (wait?.tries ?? 1) < MAX_TRIES && (await unchanged(f));
      const remember = pending || (open && fresh.length > 0 && f.status === "open" && (await unchanged(f)));
      const handled = mark
        ? { as: mark.as, note: mark.note, by: mark.by, sha: mark.sha, from: "mark" as const, at: mark.at }
        : by && last
          ? { as: "wont_fix" as const, ...oneLine(all.map((r) => r.text).join("\n\n")), by, sha: null, from: "reply" as const, at: last.at, ...(remember ? { remember: true as const, ...(pending ? { tries: wait?.tries ?? 1 } : {}) } : {}) }
          : by
            ? { as: "wont_fix" as const, note: RESOLVED_ONLY, by, sha: null, from: "thread" as const }
            : undefined;
      return { id, title, file, line, end_line, how, ...(handled ? { handled } : {}) };
    }),
  );
}

/** How many reviews send a waiting reason before it is given up on. */
const MAX_TRIES = 3;

/**
 * A person's replies as the verifier reads them: one line, nothing hidden, not too long. A long one keeps
 * its end, where the newest reply is: that is the one that counts. cut: it was longer.
 */
function oneLine(text: string): { note: string; cut?: true } {
  const line = withoutHidden(text).replace(/\s+/g, " ").trim();
  return line.length > MAX_NOTE ? { note: `… ${Array.from(line).slice(-(MAX_NOTE - 2)).join("")}`.slice(-MAX_NOTE), cut: true } : { note: line };
}

/** The reason the verifier gives when it drops an earlier finding because the team declined it. */
const TEAM_DECIDED = /\bthe team decided not to fix\b/i;

/**
 * A reason given in a thread is kept only when the verifier dropped its finding because of it: it read the
 * reply against the code, so a fix note or a plain "ok" isn't kept as a reason not to fix. The others stay
 * what the team said on this pull request, and nothing more.
 */
export function confirmReasons(previous: PriorFinding[] | undefined, rejected: { candidate: string; reason: string }[]): PriorFinding[] | undefined {
  const declined = new Set(rejected.filter((r) => TEAM_DECIDED.test(r.reason)).map((r) => r.candidate));
  return previous?.map((p) => {
    if (p.handled?.from !== "reply" || !p.handled.remember || declined.has(p.id)) return p;
    const { remember: _remember, tries: _tries, ...handled } = p.handled;
    return { ...p, handled };
  });
}

/**
 * Answers once in each thread whose reason the server just remembered, so the person sees it was
 * taken. ids: the findings the server stored a decision for.
 */
export async function answerRemembered(api: GitHub, number: number, ids: string[], cut: Set<string>, log: (line: string) => void = () => {}): Promise<number> {
  if (!ids.length) return 0;
  const wanted = new Set(ids);
  let answered = 0;
  // Only in a thread Mergelight started, by the login its summary comment carries, as when it was read.
  const own = (await readPrReviewState(api, number).catch(() => null))?.summary?.user?.login;
  const bare = (login: string | undefined | null) => login?.replace(/\[bot\]$/, "");
  for (const t of await reviewThreads(api, number).catch(() => [])) {
    const found = threadFinding(t);
    const starter = t.comments.nodes[0]?.author;
    if (!found || starter?.__typename !== "Bot" || (own && bare(starter.login) !== bare(own)) || !wanted.has(found.id) || answeredRemembered(t)) continue;
    const body = [
      REMEMBERED_MARKER,
      `🧠 **Remembered.** Later reviews of this repository read this reason before they report this problem again.${cut.has(found.id) ? " The reason was long, so only its end, the newest part, is kept." : ""} If it stops being true, forget it on your Mergelight dashboard.`,
    ].join("\n");
    const posted = await api.write("POST", `pulls/${number}/comments/${found.commentId}/replies`, { body }).catch((err) => (log(`Couldn't answer a thread: ${(err as Error).message}`), null));
    if (posted !== null) answered++;
  }
  return answered;
}

export const CHECK_FAILED_TITLE = "Couldn't review this pull request";
export const checkLoginTitle = (plan: string) => `The ${plan} login didn't work`;
export const checkLimitTitle = (plan: string) => `${CHECK_FAILED_TITLE}: your ${plan} plan hit its limit`;
export const isFailedCheckTitle = (title: string | null | undefined) => Boolean(title && (title.startsWith(CHECK_FAILED_TITLE) || /^The \w+ login didn't work$/.test(title)));

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

/**
 * Creates the check, or updates it if it has an id. GitHub only lets Apps write
 * checks, so a personal `gh` login gets a 403 on any repository. That doesn't sink
 * a review, since the comments carry it. Every other error still throws.
 */
export async function writeCheck(api: GitHub, id: number | null | undefined, headSha: string, body: object, log?: (line: string) => void): Promise<CheckRun | null> {
  try {
    if (id) return await api.write<CheckRun>("PATCH", `check-runs/${id}`, body);
    return await api.write<CheckRun>("POST", "check-runs", { name: CHECK_NAME, head_sha: headSha, ...body });
  } catch (err) {
    if (!/must authenticate via a GitHub App/i.test((err as Error).message)) throw err;
    log?.("Skipped the Mergelight check: GitHub only lets a GitHub App write checks, not a personal gh login.");
    return null;
  }
}

/**
 * Shows a live "Reviewing" check right away, so people and agents can see work is
 * happening. A login that can't write checks hears about it once, from the last write.
 */
export async function startCheck(api: GitHub, headSha: string, provider?: string): Promise<number | null> {
  const tool = provider === "claude" ? "Claude" : provider === "codex" ? "Codex" : null;
  const run = await writeCheck(api, null, headSha, {
    status: "in_progress",
    started_at: new Date().toISOString(),
    output: {
      title: "Reviewing",
      summary: `Mergelight is reviewing this pull request${tool ? ` with ${tool}` : ""} on your own plan. This usually takes 2 to 15 minutes.`,
    },
  });
  return run?.id ?? null;
}

/** Puts the summary comment on the PR before anything else, so it comes first. Later rounds edit it in place. */
export async function startSummary(api: GitHub, number: number, plan?: ReviewPlan): Promise<PrComment | null> {
  const { summary } = await readPrReviewState(api, number);
  return summary ?? (await api.write<PrComment>("POST", `issues/${number}/comments`, { body: pendingSummaryBody(plan) }));
}

/** Names the models in a "Reviewing" comment once they are known. A comment with a result is left alone. */
export async function updatePendingSummary(api: GitHub, summary: PrComment | null, plan: ReviewPlan): Promise<void> {
  if (!summary || !isPendingSummary(summary.body)) return;
  // Read it again: another run may have finished and written its result since this one began.
  const now = await api.get<PrComment>(`issues/comments/${summary.id}`).catch(() => null);
  if (!now || !isPendingSummary(now.body)) return;
  // A "Reviewing" comment can carry earlier rounds' state, after a reconnect: it must stay, or the next
  // result starts again from round 1.
  const state = stateBlock(now.body);
  await api.write("PATCH", `issues/comments/${summary.id}`, { body: state ? `${pendingSummaryBody(plan)}\n${state}` : pendingSummaryBody(plan) });
}

/** A first review that couldn't run shouldn't say "Reviewing" forever, and an older failure shouldn't outlive a newer reason. Real results stay. */
export async function failSummary(api: GitHub, number: number, notice?: FailureNotice): Promise<void> {
  const { summary } = await readPrReviewState(api, number);
  if (summary && (isPendingSummary(summary.body) || isFailedSummary(summary.body))) await api.write("PATCH", `issues/comments/${summary.id}`, { body: failedSummaryBody(notice) });
}

/**
 * A review that couldn't run ends neutral, so a broken login doesn't block
 * merging. The workflow job itself still fails, so it's visible.
 */
export async function failCheck(api: GitHub, checkRunId: number | null, headSha: string, reason: string, log?: (line: string) => void, title = CHECK_FAILED_TITLE): Promise<void> {
  await writeCheck(api, checkRunId, headSha, {
    status: "completed",
    conclusion: "neutral",
    completed_at: new Date().toISOString(),
    output: {
      title,
      summary: `${reason.slice(0, 2000)}\n\nThis check is neutral so a broken review doesn't block merging. The workflow log has the details.`,
    },
  }, log);
}

export async function publishReview(
  review: Review,
  opts: ApiOptions & {
    checkRunId?: number | null;
    yellowBlocks?: boolean;
    /** False when the team turned Mergelight's approvals off. It then never approves, and takes back an approval it gave before. */
    approve?: boolean;
    /** True when the team's server couldn't be asked, so its rules and checks weren't used in this review. */
    teamUnread?: boolean;
    /** When this review read the pull request's threads. A reply written after it is newer than this round. */
    startedAt?: Date;
    /** Reasons given in threads that this review sends to keep, until the server confirms them. Left out, the earlier list stays. */
    remember?: { id: string; at: string }[];
  } = {},
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

  // A saved review posted later is dated now: replies written since it ran are older than this round.
  const started = opts.startedAt ?? new Date();
  const state = nextState(prev, review.findings, review.pr.head_sha, review.light, urls, Number.isFinite(started.getTime()) ? started : new Date(), opts.remember ?? prev?.remember);
  const summaryInput = { review, state, urls, marks, handled, update: await newerVersion(api) };
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
  await writeCheck(api, opts.checkRunId, review.pr.head_sha, check, log);
  if (opts.approve === false) {
    // Turned off: no approval, and none of Mergelight's earlier ones stands next to a review that doesn't give one.
    await syncApproval(api, n, "yellow", review.pr.head_sha, log, { why: APPROVALS_OFF });
  } else {
    // A review that isn't green takes the approval back for what it found. Only a green one is held by something else.
    const hold = review.light === "green" ? approvalHold(review, opts.teamUnread) : null;
    await syncApproval(api, n, approvalLight(review, opts.teamUnread), review.pr.head_sha, log, hold ? { why: hold } : {});
  }

  return { summaryUrl, inline: inline.length, outside: outside.length, resolved, light: review.light };
}

/**
 * Why a green review still doesn't approve, in words for the pull request, or null when nothing holds it.
 * One of the team's own checks failed, couldn't tell or couldn't run: Mergelight doesn't approve a
 * pull request that its own check next to it holds back. Or the team's server couldn't be asked: its
 * rules and checks weren't used, so nobody knows what they would have said. A skipped check has nothing to say.
 */
export function approvalHold(review: Pick<Review, "team_checks">, teamUnread = false): string | null {
  const held = review.team_checks?.filter((c) => c.outcome !== "pass" && c.outcome !== "skipped") ?? [];
  if (held.length) return `Your team's check${held.length === 1 ? "" : "s"} ${held.map((c) => `"${c.name}"`).join(", ")} ${held.length === 1 ? "hasn't" : "haven't"} passed.`;
  if (teamUnread) return "Mergelight couldn't reach your team's server, so this review ran without your team's rules and checks.";
  return null;
}

/** The light Mergelight's own approval goes by: the review's own, and not green while something holds the approval. */
export function approvalLight(review: Pick<Review, "light" | "team_checks">, teamUnread = false): Light {
  return review.light === "green" && approvalHold(review, teamUnread) ? "yellow" : review.light;
}

/** What a dismissal says when a team turned Mergelight's approvals off. */
export const APPROVALS_OFF = "Approvals by Mergelight are turned off for this repository (auto-approve: false).";

/** What a dismissal says when a review that couldn't run takes Mergelight's earlier approval back. */
export const UNREVIEWED = "Mergelight couldn't review the newest commit, so its approval of an earlier one no longer stands.";

export const APPROVAL_MARKER = "<!-- mergelight:approval -->";
/** Only these post Mergelight's reviews, so a person's review that quotes the marker is never touched. */
const OWN_REVIEWERS = new Set(["mergelight-ai[bot]", "github-actions[bot]"]);

interface PrReview {
  id: number;
  state: string;
  commit_id: string;
  body: string | null;
  user: { login: string } | null;
}

/**
 * Green approves the pull request, like a reviewer would. Anything else takes back an approval Mergelight gave
 * earlier, so an old approval can't stand next to a newer finding. Yellow and red never request changes, so a
 * review from Mergelight never blocks a merge by itself. Failures only log: the check already carries the result.
 */
export async function syncApproval(
  api: Pick<GitHub, "list" | "write">,
  number: number,
  light: Light,
  headSha: string,
  log: (line: string) => void = () => {},
  dismissal: {
    /** What a dismissal says. The reason has to be the real one: the review can be green while something else holds the approval. */
    why?: string;
    /** Only take back approvals of other commits. For a review that couldn't run: what it said about this very commit before still stands. */
    otherCommitsOnly?: boolean;
  } = {},
): Promise<"approved" | "already" | "dismissed" | "none"> {
  try {
    const ours = (await api.list<PrReview>(`pulls/${number}/reviews`)).filter((r) => OWN_REVIEWERS.has(r.user?.login ?? "") && (r.body ?? "").includes(APPROVAL_MARKER));
    const standing = ours.filter((r) => r.state === "APPROVED");
    if (light === "green") {
      if (standing.some((r) => r.commit_id === headSha)) return "already";
      await api.write("POST", `pulls/${number}/reviews`, {
        commit_id: headSha,
        event: "APPROVE",
        body: `${APPROVAL_MARKER}\n🟢 Mergelight found nothing that needs fixing in this commit.`,
      });
      return "approved";
    }
    const taken = dismissal.otherCommitsOnly ? standing.filter((r) => r.commit_id !== headSha) : standing;
    for (const r of taken) {
      await api.write("PUT", `pulls/${number}/reviews/${r.id}/dismissals`, { message: dismissal.why ?? "A newer Mergelight review found something to look at.", event: "DISMISS" });
    }
    return taken.length ? "dismissed" : "none";
  } catch (err) {
    log(`Couldn't update Mergelight's approval: ${err instanceof Error ? err.message : String(err)}`);
    return "none";
  }
}

export async function reviewThreads(api: GitHub, number: number): Promise<ReviewThread[]> {
  type Threads = { repository: { pullRequest: { reviewThreads: { nodes: ReviewThread[] } } } };
  const data = await api.graphql<Threads>(
    `query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: 100) {
            nodes { id isResolved isOutdated resolvedBy { login } comments(first: 50) { nodes { databaseId body authorAssociation createdAt lastEditedAt author { __typename login } } } }
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

/** When someone approves a PR with a yellow check, it turns green. A blocked check (a bug to fix) stays as it is: only a fix changes it. */
export async function approveCheck(api: GitHub, number: number, by: string, approvedSha?: string): Promise<string> {
  const pr = await api.get<{ head: { sha: string } }>(`pulls/${number}`);
  // An approval covers the commit the person looked at. Code pushed after it hasn't had its human yet.
  if (approvedSha && approvedSha !== pr.head.sha) return `${by} approved an earlier commit, so it doesn't turn the Mergelight check on the newest one green.`;
  const latest = await latestCheck(api, pr.head.sha);
  if (!latest) return "No Mergelight check on this commit.";
  // A blocked review ends neutral like a yellow one, so say which it is: an approval doesn't clear a bug.
  if (latest.output.title?.startsWith(LIGHT.red.dot)) return "The Mergelight check is blocked. An approval doesn't clear it: fix the code and push, and the next review checks it again.";
  if (!isYellowCheck(latest)) return `Mergelight check is ${latest.conclusion ?? "still running"}, nothing to approve.`;
  // GitHub lets anyone who can read a repository leave an approving review. "Needs a human" means a
  // human the team trusts with the code, so only someone who can push turns the check green.
  if (!(await writeAccess(api)(by))) return `${by} can't push to this repository, so their approval doesn't turn the Mergelight check green.`;
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
