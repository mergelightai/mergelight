import { appendFileSync, readFileSync } from "node:fs";
import { fetchPullRequest, type PrRef } from "./github.js";
import { mayChange, type Job } from "./jobs.js";
import { GitHub } from "./publish/api.js";
import { run } from "./run.js";
import { isBinary, JOBS_TRAILER, MAX_CHANGE_BYTES, MAX_CHANGED_FILES, type JobsResult } from "./run-jobs.js";
import { fetchMirror, jobFilesFor } from "./workspace.js";

/**
 * Pushes what the jobs changed (run-jobs.ts) as one commit to the pull request's branch. This runs in a
 * workflow job of its own: it holds a token that can push, and no AI and no AI login. It trusts nothing
 * in the result file it is given. It reads the jobs again from the base branch, and checks every file
 * against them and against the commit the jobs worked on. Then it makes one commit with GitHub's
 * createCommitOnBranch, which refuses when the branch has moved on since, and never force-pushes.
 */

/** A file the push would write, decoded. */
export interface Addition {
  path: string;
  bytes: Buffer;
}

export interface PushPlan {
  additions: Addition[];
  deletions: string[];
  /** The jobs whose changes are pushed, and their own one-line summaries. */
  jobs: { name: string; summary: string }[];
}

/** A path as git keeps it: no leading or doubled slash, no "." or "..", no control characters. */
function plainPath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    path.length <= 4096 &&
    !/[\u0000-\u001f\u007f]/.test(path) &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

/**
 * Checks a jobs result against the jobs on the base branch and the file modes at the head. Returns what
 * to push, or why nothing may be. modes holds each changed path's mode at the head, or null when the
 * head has no such file.
 */
export function checkPush(result: unknown, jobs: Job[], head: string, modes: Map<string, string | null>, guarded: string[] = []): PushPlan | { why: string } {
  const r = result as Partial<JobsResult> | null;
  if (!r || typeof r !== "object" || !Array.isArray(r.changes) || !Array.isArray(r.outcomes)) return { why: "The jobs result can't be read." };
  if (r.head !== head) return { why: `The jobs ran on ${String(r.head).slice(0, 7)}, but the branch is at ${head.slice(0, 7)} now. The next push runs them again.` };
  if (r.changes.length > MAX_CHANGED_FILES) return { why: `The jobs changed ${r.changes.length} files, over the limit of ${MAX_CHANGED_FILES}.` };
  const changed = r.outcomes.filter((o) => o && o.status === "changed" && Array.isArray(o.files));
  const additions: Addition[] = [];
  const deletions: string[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  for (const change of r.changes) {
    const path = (change as { path?: unknown } | null)?.path;
    if (!plainPath(path)) return { why: `A changed path isn't a plain path in the repository: ${JSON.stringify(path).slice(0, 100)}.` };
    if (seen.has(path)) return { why: `${path} is changed twice.` };
    seen.add(path);
    // Never through a folder that is a link at the head: the file would land wherever the link leads.
    const parts = path.split("/");
    const through = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/")).find((at) => modes.get(at) === "120000");
    if (through) return { why: `${path} is inside ${through}, which is a link at the head.` };
    // Only an ordinary file may change: the commit can't keep a link, a submodule or a file that can run as one.
    const mode = modes.get(path);
    if (mode === undefined) return { why: `${path} wasn't looked up at the head.` };
    if (mode !== null && mode !== "100644") return { why: `${path} isn't an ordinary file at the head (mode ${mode}).` };
    // Every job that says it changed the file must be one the base branch has, and one that may change it.
    const by = changed.filter((o) => o.files.includes(path));
    if (!by.length) return { why: `No job says it changed ${path}.` };
    for (const o of by) {
      const job = jobs.find((j) => j.name === o.name);
      if (!job) return { why: `The job "${String(o.name).slice(0, 60)}" isn't on the base branch.` };
      if (!mayChange(job, path, guarded, (p) => modes.get(p) === "120000")) return { why: `The job "${job.name}" may not change ${path}.` };
    }
    if ((change as { deleted?: unknown }).deleted === true) {
      if (mode === null) return { why: `${path} is deleted, but the head has no such file.` };
      deletions.push(path);
      continue;
    }
    const contents = (change as { contents?: unknown }).contents;
    if (typeof contents !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(contents)) return { why: `The new contents of ${path} can't be read.` };
    const decoded = Buffer.from(contents, "base64");
    if (isBinary(decoded)) return { why: `${path} would be a binary file.` };
    bytes += decoded.length;
    if (bytes > MAX_CHANGE_BYTES) return { why: `The jobs wrote more than ${MAX_CHANGE_BYTES / 1000} KB.` };
    additions.push({ path, bytes: decoded });
  }
  const names = new Set([...additions.map((a) => a.path), ...deletions].flatMap((p) => changed.filter((o) => o.files.includes(p)).map((o) => o.name)));
  const pushed = changed.filter((o) => names.has(o.name)).map((o) => ({ name: o.name, summary: typeof o.summary === "string" ? o.summary.replace(/\s+/g, " ").slice(0, 300) : "" }));
  return { additions, deletions, jobs: pushed };
}

/** The commit message: what each job did, and the line that keeps jobs from running on their own commit. */
export function commitMessage(plan: PushPlan): { headline: string; body: string } {
  const names = plan.jobs.map((j) => j.name);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "");
  const lines = plan.jobs.map((j) => `- ${j.name}: ${j.summary.replace(new RegExp(`${JOBS_TRAILER}:`, "gi"), "")}`);
  return { headline: `Run the job${names.length === 1 ? "" : "s"} ${list}`, body: `${lines.join("\n")}\n\n${JOBS_TRAILER}: ${names.join(", ")}` };
}

/** Each changed path's mode at the head, or null when the head has no such file, and the mode of each folder on the way that is a link. */
async function modesAt(mirror: string, head: string, paths: string[]): Promise<Map<string, string | null>> {
  const folders = paths.flatMap((p) => p.split("/").slice(0, -1).map((_, i, all) => p.split("/").slice(0, i + 1).join("/")));
  const modes = new Map<string, string | null>([...folders.map((f): [string, string | null] => [f, null]), ...paths.map((p): [string, string | null] => [p, null])]);
  if (!paths.length) return modes;
  // The whole tree: ls-tree reads paths as patterns, and a path must only ever match itself.
  const listed = await run("git", ["--git-dir", mirror, "ls-tree", "-r", "-z", "--full-tree", head]);
  if (listed.code !== 0) throw new Error(`Couldn't read the file modes at ${head.slice(0, 7)}.`);
  for (const entry of listed.stdout.split("\0")) {
    const m = /^(\d{6}) \w+ [0-9a-f]+\t([\s\S]+)$/.exec(entry);
    if (m && modes.has(m[2]!)) modes.set(m[2]!, m[1]!);
  }
  return modes;
}

const CREATE_COMMIT = `mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid url } } }`;

export interface PushJobsOptions {
  /** The jobs result file. */
  from: string;
  dryRun?: boolean;
  log: (line: string) => void;
}

/** Pushes a jobs result to its pull request. 0 when it pushed or had nothing to push or the branch moved, 1 when a check refused it. */
export async function pushJobs(ref: PrRef, o: PushJobsOptions): Promise<number> {
  const output = (values: Record<string, string>) => {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([k, v]) => `${k}=${v.replace(/\n/g, " ")}\n`).join(""));
  };
  const refuse = (why: string, code: number) => {
    o.log(`Nothing pushed. ${why}`);
    output({ pushed: "false", why });
    return code;
  };
  let result: unknown;
  try {
    result = JSON.parse(readFileSync(o.from, "utf8"));
  } catch {
    return refuse(`The jobs result in ${o.from} can't be read.`, 1);
  }
  if (!Array.isArray((result as JobsResult | null)?.changes) || !(result as JobsResult).changes.length) return refuse("The jobs changed nothing.", 0);

  const pr = await fetchPullRequest(ref);
  // GitHub gives a fork's pull request no token that can push to it, and Mergelight never asks for one.
  // GitHub ignores letter case in a repository's name.
  if (pr.headRepo?.toLowerCase() !== `${pr.owner}/${pr.repo}`.toLowerCase() || !pr.headRef) return refuse("The pull request comes from another repository.", 1);
  if ((result as JobsResult).head !== pr.headSha) return refuse(`The jobs ran on ${String((result as JobsResult).head).slice(0, 7)}, but the branch is at ${pr.headSha.slice(0, 7)} now. The next push runs them again.`, 0);

  const { mirror, teamBase } = await fetchMirror(pr);
  const { jobs, guarded, incomplete } = await jobFilesFor(mirror, teamBase);
  if (incomplete) return refuse(incomplete, 0);
  const paths = (result as JobsResult).changes.map((c) => c?.path).filter(plainPath);
  const plan = checkPush(result, jobs, pr.headSha, await modesAt(mirror, pr.headSha, paths), guarded);
  if ("why" in plan) return refuse(plan.why, 1);

  const message = commitMessage(plan);
  const api = new GitHub(pr.owner, pr.repo, { dryRun: o.dryRun, log: o.log });
  const input = {
    branch: { repositoryNameWithOwner: `${pr.owner}/${pr.repo}`, branchName: pr.headRef },
    // GitHub refuses when the branch has moved on since: a push that came in between is never undone.
    expectedHeadOid: pr.headSha,
    message,
    fileChanges: {
      additions: plan.additions.map((a) => ({ path: a.path, contents: a.bytes.toString("base64") })),
      deletions: plan.deletions.map((path) => ({ path })),
    },
  };
  type Answer = { data?: { createCommitOnBranch?: { commit?: { oid: string; url: string } } }; errors?: { message: string }[] };
  let answer: Answer | null;
  try {
    answer = await api.write<Answer>("POST", "/graphql", { query: CREATE_COMMIT, variables: { input } });
  } catch (err) {
    // gh ends with an error when GitHub's answer holds one.
    answer = { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  if (o.dryRun) return 0;
  const commit = answer?.data?.createCommitOnBranch?.commit;
  if (!commit) {
    const why = answer?.errors?.map((e) => e.message).join(" ") ?? "GitHub gave no commit back.";
    // The branch moved between the check and the push.
    if (/STALE_DATA|expected branch to point to/i.test(why)) {
      // A retry after a push whose answer got lost is refused the same way: the branch now has our commit.
      // Read from the branch itself, which moves at once, not the pull request's head, which GitHub
      // updates a little later. Ours is the one on the commit we checked, with this very message.
      const branch = await api.get<{ object: { sha: string } }>(`git/ref/heads/${pr.headRef.split("/").map(encodeURIComponent).join("/")}`).catch(() => null);
      const ours = branch && (await api.get<{ sha: string; parents: { sha: string }[]; commit: { message: string } }>(`commits/${branch.object.sha}`).catch(() => null));
      const same = (text: string) => text.replace(/\r\n/g, "\n").trim();
      if (ours && ours.parents.length === 1 && ours.parents[0]?.sha === pr.headSha && same(ours.commit.message) === same(`${message.headline}\n\n${message.body}`)) {
        o.log(`Pushed ${ours.sha.slice(0, 7)}: ${message.headline}.`);
        output({ pushed: "true", commit: ours.sha });
        return 0;
      }
    }
    if (/STALE_DATA|expected branch to point to/i.test(why)) return refuse(`The branch moved while the jobs ran. The next push runs them again. (${why.slice(0, 200)})`, 0);
    return refuse(`GitHub refused the commit: ${why.slice(0, 300)}`, 1);
  }
  o.log(`Pushed ${commit.oid.slice(0, 7)}: ${message.headline}. ${commit.url}`);
  output({ pushed: "true", commit: commit.oid });
  return 0;
}
