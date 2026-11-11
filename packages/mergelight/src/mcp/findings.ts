import { currentRepo, fetchPullRequest, parsePrRef, type PrRef } from "../github.js";
import { GitHub } from "../publish/api.js";
import { encodeMark, findingState, markedSince, MAX_NOTE, type FindingState, type HandledAs, type Mark } from "../publish/handled.js";
import { clean } from "../publish/markdown.js";
import { isFailedCheckTitle, latestCheck, readPrReviewState, resolveThread, reviewThreads, type CheckRun, type ReviewThread } from "../publish/publish.js";
import type { StateFinding } from "../publish/state.js";
import { runOk } from "../run.js";
import type { Tier } from "../types.js";

export const TIERS: Tier[] = ["post", "list", "decision", "hardening"];

/** What a finding's tier asks of the agent: the verifier already weighed the fix against the problem. */
const ACTION: Record<Tier, "fix" | "ask" | "leave"> = { post: "fix", list: "fix", decision: "ask", hardening: "leave" };

/** A URL, owner/repo#123, a number inside a clone, or nothing for the current branch's pull request. */
async function resolvePr(pr: unknown): Promise<PrRef> {
  if (typeof pr === "string" && pr.trim()) {
    const ref = pr.trim();
    return parsePrRef(ref, /^#?\d+$/.test(ref) ? await currentRepo() : undefined);
  }
  try {
    const { stdout } = await runOk("gh", ["pr", "view", "--json", "url", "--jq", ".url"]);
    return parsePrRef(stdout.trim());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw err;
    throw new Error(`Couldn't tell which pull request you mean from ${process.cwd()}. Pass pr, like owner/repo#123.`);
  }
}

function forAgent(f: StateFinding, state: FindingState, mark: Mark | undefined, lastReviewAt: string | undefined) {
  const { as, note, by, at, url, sha } = mark ?? {};
  return {
    id: f.id,
    title: f.title,
    file: f.file,
    line: f.line,
    end_line: f.end_line,
    class: f.class,
    severity: f.severity,
    likelihood: f.likelihood,
    how_it_happens: f.how,
    what_breaks: f.what_breaks,
    fix: f.fix,
    fix_cost: f.fix_cost,
    verdict: f.verdict,
    rank: f.rank ?? undefined,
    tier: f.tier,
    action: ACTION[f.tier],
    state,
    first_round: f.first_round,
    url: f.url,
    ...(mark
      ? {
          handled: {
            as,
            note,
            by,
            at,
            url,
            sha,
            // The review read this mark and reported the finding anyway. That's for the user to look at.
            ...(as === "wont_fix" && f.status === "open" && !markedSince(mark, lastReviewAt) ? { still_reported: true } : {}),
          },
        }
      : {}),
  };
}

type AgentFinding = ReturnType<typeof forAgent>;

export type ReviewStatus = "none" | "reviewing" | "failed" | "outdated" | "done";

export function reviewStatus(check: CheckRun | undefined, hasState: boolean, upToDate: boolean): ReviewStatus {
  if (check && check.status !== "completed") return "reviewing";
  if (isFailedCheckTitle(check?.output.title)) return "failed";
  if (!hasState) return "none";
  return upToDate ? "done" : "outdated";
}

/** One line on what to do next, so an agent without the skill still gets it right. */
export function nextStep(status: ReviewStatus, reviewedSha: string | undefined, findings: Record<Tier, unknown[]>, pending: number, disputed = 0): string {
  const old = reviewedSha?.slice(0, 7);
  if (!reviewedSha) {
    if (status === "reviewing") return "A review is running. It usually takes 2 to 15 minutes. Tell the user and check again later.";
    if (status === "failed") return "The review couldn't run. The check has the reason. Tell the user.";
    return "No Mergelight review on this pull request yet. Tell the user. Reviews come from the Mergelight GitHub Action.";
  }
  const before = {
    reviewing: `A review of the latest commit is running, so this may change. These findings are from ${old}. `,
    failed: `The latest review couldn't run, so these findings are from ${old}. `,
    outdated: `These findings are from ${old}, not the latest commit. Their line numbers may be off. `,
    none: "",
    done: "",
  }[status];
  const fix = findings.post.length + findings.list.length;
  const asks = findings.decision.length;
  const steps = [
    ...(fix ? [`fix ${fix} (post first, then list)`] : []),
    ...(asks ? [`ask the user about ${asks} (decision)`] : []),
    ...(findings.hardening.length ? [`leave ${findings.hardening.length} alone (hardening)`] : []),
  ];
  const todo = steps.length ? `Next: ${steps.join(", ")}.` : "Nothing to do here.";
  const after = fix ? " Run the project's own tests before pushing, then mark what you fixed." : "";
  const wait = pending ? ` ${pending} marked fixed, waiting for the next review to check.` : "";
  // These can hold the check at red after everything else is fixed, so the user needs to hear about them.
  const tell = disputed ? ` Tell the user: the review read why ${disputed} marked won't fix and still reports it.` : "";
  return `${before}${todo}${after}${wait}${tell}`;
}

export async function listFindings(args: { pr?: unknown; tier?: unknown }) {
  const ref = await resolvePr(args.pr);
  if (args.tier !== undefined && !TIERS.includes(args.tier as Tier)) throw new Error(`tier must be one of ${TIERS.join(", ")}.`);
  const api = new GitHub(ref.owner, ref.repo);
  const pr = await fetchPullRequest(ref);
  const { state, marks } = await readPrReviewState(api, ref.number);
  const check = await latestCheck(api, pr.headSha).catch(() => undefined);

  const last = state?.rounds.at(-1);
  const upToDate = last?.sha === pr.headSha;
  const status = reviewStatus(check, Boolean(state), upToDate);

  const findings: Record<Tier, AgentFinding[]> = { post: [], list: [], decision: [], hardening: [] };
  const handled: AgentFinding[] = [];
  const gone: Pick<StateFinding, "id" | "title" | "file" | "line">[] = [];
  for (const f of state?.findings ?? []) {
    const mark = marks.get(f.id);
    const where = findingState(f, mark, last?.at);
    if (where === "gone") gone.push({ id: f.id, title: f.title, file: f.file, line: f.line });
    else if (where === "fix_pending" || where === "wont_fix") handled.push(forAgent(f, where, mark, last?.at));
    else findings[f.tier].push(forAgent(f, where, mark, last?.at));
  }
  findings.post.sort((a, b) => (a.rank ?? 9) - (b.rank ?? 9));
  const pending = handled.filter((f) => f.state === "fix_pending").length;
  const disputed = handled.filter((f) => f.handled?.still_reported).length;

  return {
    pr: `${ref.owner}/${ref.repo}#${ref.number}`,
    url: pr.url,
    title: pr.title,
    review: {
      status,
      light: last?.light,
      round: state?.round,
      reviewed_sha: last?.sha,
      head_sha: pr.headSha,
      up_to_date: upToDate,
      check: check ? { status: check.status, conclusion: check.conclusion, title: check.output.title, started_at: check.started_at } : undefined,
    },
    next: nextStep(status, last?.sha, findings, pending, disputed),
    findings: args.tier ? { [args.tier as Tier]: findings[args.tier as Tier] } : findings,
    handled,
    gone,
  };
}

const VISIBLE: Record<HandledAs, { head: (sha: string, note: string) => string; foot: string }> = {
  fixed: {
    head: (sha, note) => `✅ **Marked fixed** as of \`${sha.slice(0, 7)}\`.${note ? ` ${note}` : ""}`,
    foot: "The next Mergelight review checks this.",
  },
  wont_fix: {
    head: (_, note) => `🚫 **Won't fix:** ${note}`,
    foot: "The next Mergelight review reads this. It only raises this again if it's a major bug that still stands, the reason is wrong, or the code got worse.",
  },
};

const place = (f: StateFinding) => `\`${f.file}:${f.line}\``;

export async function markHandled(args: { pr?: unknown; ids?: unknown; as?: unknown; note?: unknown }) {
  const as = args.as;
  if (as !== "fixed" && as !== "wont_fix") throw new Error('as must be "fixed" or "wont_fix".');
  if (!Array.isArray(args.ids) || !args.ids.length || !args.ids.every((id) => typeof id === "string")) throw new Error("ids must list at least one finding id from list_findings.");
  const note = typeof args.note === "string" && args.note.trim() ? args.note.trim().slice(0, MAX_NOTE) : null;
  if (as === "wont_fix" && !note) throw new Error('as "wont_fix" needs a note saying why. It goes on the pull request and into the next review.');

  const ref = await resolvePr(args.pr);
  const api = new GitHub(ref.owner, ref.repo);
  const pr = await fetchPullRequest(ref);
  const { state, marks } = await readPrReviewState(api, ref.number);
  if (!state) throw new Error(`No Mergelight review on ${ref.owner}/${ref.repo}#${ref.number} yet, so there's nothing to mark.`);

  const known = new Map(state.findings.map((f) => [f.id, f]));
  const unknown = (args.ids as string[]).filter((id) => !known.has(id));
  if (unknown.length) throw new Error(`Not findings on this pull request: ${unknown.join(", ")}. Nothing was marked. list_findings has the ids.`);

  // The review only counts marks by people who can push. Say so now, not after a mark that never counts.
  const access = await api.get<{ permissions?: { push?: boolean } }>(`/repos/${ref.owner}/${ref.repo}`).catch(() => null);
  if (access?.permissions?.push === false) {
    throw new Error(`Nothing was marked: your GitHub login can't push to ${ref.owner}/${ref.repo}, and the review only counts marks by people who can. Ask someone who can push to mark it.`);
  }

  const reviewed = state.rounds.at(-1)?.sha;
  if (as === "fixed" && reviewed === pr.headSha) {
    throw new Error(
      `Nothing was marked: GitHub shows ${pr.headSha.slice(0, 7)} as the latest commit, and the latest review already looked at it. Push the fix first. If you just pushed, GitHub can take a few seconds to catch up, so try again.`,
    );
  }

  const skipped: { id: string; reason: string }[] = [];
  const todo: StateFinding[] = [];
  for (const id of new Set(args.ids as string[])) {
    const f = known.get(id)!;
    const had = marks.get(id);
    if (f.status === "gone") skipped.push({ id, reason: "The latest review no longer finds this." });
    else if (had?.as === as && (as === "fixed" ? had.sha === pr.headSha : had.note === note)) skipped.push({ id, reason: `Already marked: ${had.url}` });
    else todo.push(f);
  }

  const { head, foot } = VISIBLE[as];
  const line = head(pr.headSha, note ? clean(note) : "");
  const threads: ReviewThread[] = as === "wont_fix" && todo.some((f) => f.url) ? await reviewThreads(api, ref.number).catch(() => []) : [];

  const marked: { id: string; as: HandledAs; url: string | null; thread_resolved?: boolean }[] = [];
  const noThread: StateFinding[] = [];
  for (const f of todo) {
    const commentId = f.url?.match(/#discussion_r(\d+)/)?.[1];
    if (!commentId) {
      noThread.push(f);
      continue;
    }
    let url: string | null = null;
    try {
      const body = [encodeMark([f.id], as, note, pr.headSha), line, "", `<sub>${foot}</sub>`].join("\n");
      url = (await api.write<{ html_url: string }>("POST", `pulls/${ref.number}/comments/${commentId}/replies`, { body }))?.html_url ?? null;
    } catch {
      // The thread may be gone or locked. The mark still counts as a comment on the pull request.
      noThread.push(f);
      continue;
    }
    const entry: (typeof marked)[number] = { id: f.id, as, url };
    if (as === "wont_fix") {
      // Nothing later would close it. A resolved thread is still there for anyone who disagrees.
      const thread = threads.find((t) => String(t.comments.nodes[0]?.databaseId) === commentId);
      entry.thread_resolved = Boolean(thread?.isResolved);
      if (thread && !thread.isResolved) {
        entry.thread_resolved = await resolveThread(api, thread.id).then(() => true, () => false);
      }
    }
    marked.push(entry);
  }

  if (noThread.length) {
    const body = [
      encodeMark(noThread.map((f) => f.id), as, note, pr.headSha),
      line,
      "",
      ...noThread.map((f) => `- ${clean(f.title)} ${place(f)}`),
      "",
      `<sub>${foot}</sub>`,
    ].join("\n");
    const url = (await api.write<{ html_url: string }>("POST", `issues/${ref.number}/comments`, { body }))?.html_url ?? null;
    for (const f of noThread) marked.push({ id: f.id, as, url });
  }

  return {
    pr: `${ref.owner}/${ref.repo}#${ref.number}`,
    marked,
    skipped,
    next: as === "fixed" ? "The next review checks these. It runs by itself after a push and takes 2 to 15 minutes." : "The next review reads the reason.",
  };
}
