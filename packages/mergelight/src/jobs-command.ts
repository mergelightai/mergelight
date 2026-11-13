import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { run } from "./run.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchPullRequest, type PrRef } from "./github.js";
import { jobsToRun } from "./jobs.js";
import { runModel, TOOLING, type ProviderName } from "./providers/index.js";
import { buildJobPrompt, caseBlindDisk, caseClashes, isJobCommit, JOB_SCHEMA, mirrorGit, runJobs, type JobsResult } from "./run-jobs.js";
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

/**
 * Where the result goes when no --out is given: the runner's own temp folder in the Action, and a new
 * private folder elsewhere, so no one else on the machine can know the path or plant a file there.
 */
export function defaultJobsOut(): string {
  if (process.env.RUNNER_TEMP) return join(process.env.RUNNER_TEMP, "mergelight-jobs.json");
  return join(mkdtempSync(join(tmpdir(), "mergelight-jobs-")), "result.json");
}

/** git's version, as [major, minor], or null when it can't be told. */
async function gitVersion(): Promise<[number, number] | null> {
  const m = /git version (\d+)\.(\d+)/.exec((await run("git", ["--version"]).catch(() => null))?.stdout ?? "");
  return m ? [Number(m[1]), Number(m[2])] : null;
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
  // A run that stops early never leaves an older result in place, and a path that can't be written
  // fails now, before any AI time is spent.
  writeFileSync(out, "", { mode: 0o600 });
  const finish = (result: JobsResult): number => {
    // Only for this account: outside the Action it may sit in a shared temp folder.
    writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    for (const line of describeJobs(result)) o.log(line);
    if (!o.out && !process.env.RUNNER_TEMP) o.log(`The result is in ${out}.`);
    // The workflow pushes only when there is something to push.
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changes=${result.changes.length}\nresult=${out}\n`);
    // Every job that ran failed: that is the run failing, not a pull request with nothing to do.
    return result.outcomes.length && result.outcomes.every((x) => x.status === "failed") ? 1 : 0;
  };

  // Files are written out and read back byte for byte only with git 2.42 or newer (GIT_ATTR_SOURCE).
  const version = await gitVersion();
  if (!version || version[0] < 2 || (version[0] === 2 && version[1] < 42)) {
    o.log(`Jobs need git 2.42 or newer, and this machine has ${version ? version.join(".") : "a git that can't say"}. No job ran.`);
    return 1;
  }
  progress(`Reading ${ref.owner}/${ref.repo}#${ref.number}`);
  const pr = await fetchPullRequest(ref);
  // Nothing a job does could be pushed to the default branch (push-jobs.ts), so no AI time is spent on it.
  // Only the repository's own default branch: a fork's branch can have the same name.
  const sameRepo = (pr.headRepo ?? "").toLowerCase() === `${pr.owner}/${pr.repo}`.toLowerCase();
  if (pr.defaultBranch && sameRepo && pr.headRef === pr.defaultBranch) {
    return finish({ head: pr.headSha, outcomes: [], problems: [], changes: [], skipped: `The pull request comes from ${pr.headRef}, the repository's default branch, so no job runs.` });
  }
  progress("Checking out the code");
  const ws = await prepareWorkspace(pr, o.at);
  try {
    const git = mirrorGit(ws.mirror);
    const empty = { head: ws.headSha, outcomes: [], problems: [], changes: [] };
    // A commit jobs made runs no jobs, so a job can't start itself again.
    if (await isJobCommit(git, ws.headSha)) return finish({ ...empty, skipped: "The newest commit is one that jobs made, so no job runs on it." });
    // One commit for the whole run, pinned while the workspace was prepared.
    const teamBase = ws.teamBase;
    const { jobs, problems, guarded, incomplete } = await jobFilesFor(ws.mirror, teamBase);
    // The guard couldn't be worked out in full: no job runs rather than one with a smaller guard.
    if (incomplete) return finish({ ...empty, problems, skipped: incomplete });
    if (!jobs.length) return finish({ ...empty, problems, skipped: `There are no jobs in .mergelight/jobs on ${pr.baseRef}.` });
    // On a disk that ignores letter case, two files that differ only in it would be written as one.
    if (caseBlindDisk()) {
      const clashes = await caseClashes(git, ws.headSha);
      if (clashes.length) return finish({ ...empty, problems, skipped: `This disk ignores letter case, and ${clashes.slice(0, 3).join(", ")} would be one file here, so no job runs.` });
    }
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
      ask: async (job, dir, earlier, deadline) => {
        // The skill comes from the base branch into the job's own folder, at .mergelight/skills, where the
        // job's commands can always read it. No job may change anything under .mergelight, and that
        // folder comes back from the tree when the job's files are read, so the copy is never pushed.
        const [found] = job.skill ? await skillsFor(ws.mirror, teamBase, dir, [job.skill]) : [];
        // A job without the skill it names would do something else than the team wrote.
        if (job.skill && !found) throw new Error(`its skill ${job.skill} couldn't be copied from ${pr.baseRef}`);
        const prompt = buildJobPrompt({
          job,
          pr,
          diff: ws.diff,
          diffTruncated: ws.diffTruncated,
          changedPaths: ws.touchedPaths,
          conventions: ws.conventions,
          skill: found ? { name: found.name, path: found.read } : undefined,
          earlier,
          tooling: TOOLING[provider],
          guarded,
        });
        const answer = await runModel(provider, {
          cwd: dir,
          prompt,
          schema: JOB_SCHEMA,
          edit: true,
          model: o.model,
          effort: o.effort,
          // Worked out right before the program starts, so nothing before it takes from its time.
          deadline,
          logFile: join(cacheDir(), "logs", `${pr.owner}-${pr.repo}-${pr.number}-${stamp}-job-${job.name}.log`),
        });
        return answer.output;
      },
    });
    return finish(result);
  } finally {
    if (!o.keep) await ws.cleanup();
  }
}
