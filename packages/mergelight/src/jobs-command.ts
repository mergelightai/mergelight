import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchPullRequest, type PrRef } from "./github.js";
import { jobsToRun } from "./jobs.js";
import { runModel, TOOLING, type ProviderName } from "./providers/index.js";
import { buildJobPrompt, isJobCommit, JOB_SCHEMA, mirrorGit, runJobs, type JobsResult } from "./run-jobs.js";
import { cacheDir, jobFilesFor, prepareWorkspace, skillsFor } from "./workspace.js";

export interface JobsCommandOptions {
  provider?: ProviderName;
  model?: string;
  effort?: string;
  /** Where to write the result. */
  out?: string;
  /** Run the jobs on this commit of the pull request instead of the latest. */
  at?: string;
  keep?: boolean;
  log: (line: string) => void;
  onProgress?: (message: string) => void;
}

/** Where the result goes when no --out is given: the runner's temp folder in the Action. */
export function defaultJobsOut(): string {
  return join(process.env.RUNNER_TEMP || tmpdir(), "mergelight-jobs.json");
}

/** What a run did, in lines for the log. */
export function describeJobs(result: JobsResult): string[] {
  const lines: string[] = [];
  if (result.skipped) lines.push(result.skipped);
  for (const p of result.problems) lines.push(`Left out ${p.source}: ${p.problem}.`);
  for (const o of result.outcomes) {
    const what = { changed: `changed ${o.files.length} file${o.files.length === 1 ? "" : "s"}`, nothing: "changed nothing", refused: "was dropped", failed: "failed" }[o.status];
    lines.push(`Job "${o.name}" ${what}. ${o.summary}`);
  }
  if (!result.skipped) lines.push(result.changes.length ? `${result.changes.length} file${result.changes.length === 1 ? "" : "s"} to push.` : "Nothing to push.");
  return lines;
}

/**
 * Runs the team's jobs on a pull request and writes what they changed to a file. Nothing is pushed and
 * nothing is posted: a separate step, with no AI and no AI login, checks the file again and pushes it.
 */
export async function jobsCommand(ref: PrRef, o: JobsCommandOptions): Promise<number> {
  const progress = o.onProgress ?? (() => {});
  const out = o.out ?? defaultJobsOut();
  const finish = (result: JobsResult): number => {
    writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
    for (const line of describeJobs(result)) o.log(line);
    // The workflow pushes only when there is something to push.
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changes=${result.changes.length}\nresult=${out}\n`);
    return 0;
  };

  progress(`Reading ${ref.owner}/${ref.repo}#${ref.number}`);
  const pr = await fetchPullRequest(ref);
  progress("Checking out the code");
  const ws = await prepareWorkspace(pr, o.at);
  try {
    const git = mirrorGit(ws.mirror);
    const empty = { head: ws.headSha, outcomes: [], problems: [], changes: [] };
    // A commit jobs made runs no jobs, so a job can't start itself again.
    if (await isJobCommit(git, ws.headSha)) return finish({ ...empty, skipped: "The newest commit is one that jobs made, so no job runs on it." });
    const { jobs, problems, guarded, incomplete } = await jobFilesFor(ws.mirror, ws.teamBase);
    // The guard couldn't be worked out in full: no job runs rather than one with a smaller guard.
    if (incomplete) return finish({ ...empty, problems, skipped: incomplete });
    if (!jobs.length) return finish({ ...empty, problems, skipped: `There are no jobs in .mergelight/jobs on ${pr.baseRef}.` });
    const toRun = jobsToRun(jobs, ws.touchedPaths);
    if (!toRun.length) return finish({ ...empty, problems, skipped: "This pull request changes none of the files that start a job." });

    const provider = o.provider ?? "codex";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const result = await runJobs({
      git,
      head: ws.headSha,
      jobs: toRun,
      guarded,
      problems,
      onProgress: progress,
      ask: async (job, dir, earlier, timeLeftMs) => {
        // The skill comes from the base branch, into a folder of its own next to the job's copy.
        const skillDir = job.skill ? mkdtempSync(join(tmpdir(), `mergelight-job-skill-${job.name}-`)) : null;
        try {
          const [found] = skillDir && job.skill ? await skillsFor(ws.mirror, ws.teamBase, skillDir, [job.skill]) : [];
          // A job without the skill it names would do something else than the team wrote.
          if (job.skill && !found) throw new Error(`its skill ${job.skill} couldn't be copied from ${pr.baseRef}`);
          const prompt = buildJobPrompt({
            job,
            pr,
            diff: ws.diff,
            diffTruncated: ws.diffTruncated,
            changedPaths: ws.touchedPaths,
            conventions: ws.conventions,
            skill: found && skillDir ? { name: found.name, path: join(skillDir, found.read) } : undefined,
            earlier,
            tooling: TOOLING[provider],
            guarded,
          });
          const answer = await runModel(provider, {
            cwd: dir,
            prompt,
            schema: JOB_SCHEMA,
            edit: true,
            readDirs: skillDir ? [skillDir] : [],
            model: o.model,
            effort: o.effort,
            timeoutMs: timeLeftMs,
            logFile: join(cacheDir(), "logs", `${pr.owner}-${pr.repo}-${pr.number}-${stamp}-job-${job.name}.log`),
          });
          return answer.output;
        } finally {
          if (skillDir) rmSync(skillDir, { recursive: true, force: true });
        }
      },
    });
    return finish(result);
  } finally {
    if (!o.keep) await ws.cleanup();
  }
}
