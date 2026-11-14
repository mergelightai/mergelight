import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { fetchPullRequest, type PrRef } from "./github.js";
import { folded as sameName, jobsToRun, mayChange, type Job } from "./jobs.js";
import { GitHub } from "./publish/api.js";
import { blobIsBinary, isBinary, isJobCommit, JOBS_TRAILER, MAX_CHANGE_BYTES, MAX_CHANGED_FILES, mirrorGit, newSecret, textOf, withoutSecrets, type JobsResult } from "./run-jobs.js";
import { fetchMirror, headGuarded, jobFilesFor } from "./workspace.js";

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

/** A path as macOS and Windows compare it: letter case and Unicode composition don't count. As run-jobs.ts does. */
const folded = sameName;

/**
 * Checks a jobs result against the jobs that this pull request starts on the base branch, and against
 * the head. Returns what to push, or why nothing may be. modes holds each changed path's mode at the
 * head, and each folder's on the way (040000 for a folder), or null when the head has nothing there.
 * files holds every file at the head, for the checks a new file needs.
 */
export function checkPush(result: unknown, jobs: Job[], head: string, modes: Map<string, string | null>, guarded: string[] = [], files: string[] = []): PushPlan | { why: string } {
  const r = result as Partial<JobsResult> | null;
  if (!r || typeof r !== "object" || !Array.isArray(r.changes) || !Array.isArray(r.outcomes)) return { why: "The jobs result can't be read." };
  if (r.head !== head) return { why: `The jobs ran on ${String(r.head).slice(0, 7)}, but the branch is at ${head.slice(0, 7)} now. The next push runs them again.` };
  if (r.changes.length > MAX_CHANGED_FILES) return { why: `The jobs changed ${r.changes.length} files, over the limit of ${MAX_CHANGED_FILES}.` };
  const changed = r.outcomes.filter((o) => o && o.status === "changed" && Array.isArray(o.files));
  // What the result deletes: a deletion is checked like any change below, and the whole push is
  // refused if one isn't allowed, so the checks that need them can count them already.
  const deleting = new Set(r.changes.filter((c) => (c as { deleted?: unknown } | null)?.deleted === true).map((c) => (c as { path?: unknown }).path).filter(plainPath));
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
    const folders = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
    const through = folders.find((at) => modes.get(at) === "120000");
    if (through) return { why: `${path} is inside ${through}, which is a link at the head.` };
    // A folder on the way that is a file or a submodule at the head can't hold it, unless the same push
    // deletes that file.
    const blocked = folders.find((at) => modes.get(at) != null && modes.get(at) !== "040000" && !deleting.has(at));
    if (blocked) return { why: `${path} is inside ${blocked}, which isn't a folder at the head.` };
    // Only an ordinary file may change: the commit can't keep a link, a submodule or a file that can run as one.
    let mode = modes.get(path);
    if (mode === undefined) return { why: `${path} wasn't looked up at the head.` };
    // A folder at the head becomes a file only when the same push deletes everything in it.
    if (mode === "040000") {
      const inside = files.filter((f) => f.startsWith(`${path}/`));
      if (inside.length && inside.every((f) => deleting.has(f))) mode = null;
    }
    if (mode !== null && mode !== "100644") return { why: `${path} isn't an ordinary file at the head (mode ${mode}).` };
    // Every job that says it changed the file must be one the base branch has, and one that may change it.
    const by = changed.filter((o) => o.files.includes(path));
    if (!by.length) return { why: `No job says it changed ${path}.` };
    for (const o of by) {
      const job = jobs.find((j) => j.name === o.name);
      if (!job) return { why: `The job "${String(o.name).slice(0, 60)}" isn't on the base branch, or this pull request doesn't start it.` };
      if (!mayChange(job, path, guarded, (p) => modes.get(p) === "120000")) return { why: `The job "${job.name}" may not change ${path}.` };
    }
    if ((change as { deleted?: unknown }).deleted === true) {
      if (mode === null) return { why: `${path} is deleted, but the head has no such file.` };
      deletions.push(path);
      continue;
    }
    const contents = (change as { contents?: unknown }).contents;
    // Whole base64 only: Node decodes a cut-off string without a word, and a file would lose its end.
    if (typeof contents !== "string" || contents.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(contents)) return { why: `The new contents of ${path} can't be read.` };
    const decoded = Buffer.from(contents, "base64");
    if (isBinary(decoded)) return { why: `${path} would be a binary file.` };
    bytes += decoded.length;
    if (bytes > MAX_CHANGE_BYTES) return { why: `The jobs wrote more than ${MAX_CHANGE_BYTES / 1000} KB.` };
    additions.push({ path, bytes: decoded });
  }
  // A new file whose name differs from another only in letter case is one file on macOS and Windows: the
  // jobs step refuses that, and so does this one, against what the head keeps and the other new files.
  // A file and a folder whose names differ only in letter case clash the same way.
  const fresh = additions.filter((a) => modes.get(a.path) === null || modes.get(a.path) === "040000").map((a) => a.path);
  if (fresh.length) {
    const kept = [...files.filter((f) => !deleting.has(f)), ...fresh];
    const count = new Map<string, number>();
    for (const f of kept) count.set(folded(f), (count.get(folded(f)) ?? 0) + 1);
    const parents = (f: string) => f.split("/").slice(0, -1).map((_, i, all) => all.slice(0, i + 1).join("/"));
    const folders = new Set(kept.flatMap(parents).map(folded));
    const clash = fresh.find((f) => (count.get(folded(f)) ?? 0) > 1 || folders.has(folded(f)) || parents(f).some((p) => count.has(folded(p))));
    if (clash) return { why: `${clash} differs from another file or folder only in letter case.` };
  }
  const names = new Set([...additions.map((a) => a.path), ...deletions].flatMap((p) => changed.filter((o) => o.files.includes(p)).map((o) => o.name)));
  // Cut by characters, not UTF-16 units, so an emoji is never split in half. The jobs step took secrets
  // out already; this step does it again with what it can see, as it trusts nothing in the file.
  const summaryOf = (text: unknown) => (typeof text === "string" ? Array.from(withoutSecrets(text).replace(/\s+/g, " ")).slice(0, 300).join("") : "");
  const pushed = changed.filter((o) => names.has(o.name)).map((o) => ({ name: o.name, summary: summaryOf(o.summary) }));
  return { additions, deletions, jobs: pushed };
}

/** The commit message: what each job did, and the line that keeps jobs from running on their own commit. */
export function commitMessage(plan: PushPlan): { headline: string; body: string } {
  const names = plan.jobs.map((j) => j.name);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "");
  const lines = plan.jobs.map((j) => `- ${j.name}: ${j.summary.replace(new RegExp(`${JOBS_TRAILER}:`, "gi"), "")}`);
  return { headline: `Run the job${names.length === 1 ? "" : "s"} ${list}`, body: `${lines.join("\n")}\n\n${JOBS_TRAILER}: ${names.join(", ")}` };
}

/**
 * Each changed path's mode at the head, or null when the head has nothing there, and the mode of each
 * folder on the way: 040000 for a folder. And every file at the head.
 */
async function headTree(mirror: string, head: string, paths: string[]): Promise<{ modes: Map<string, string | null>; files: string[] }> {
  const folders = paths.flatMap((p) => p.split("/").slice(0, -1).map((_, i, all) => p.split("/").slice(0, i + 1).join("/")));
  const modes = new Map<string, string | null>([...folders.map((f): [string, string | null] => [f, null]), ...paths.map((p): [string, string | null] => [p, null])]);
  const files: string[] = [];
  if (!paths.length) return { modes, files };
  // The whole tree: ls-tree reads paths as patterns, and a path must only ever match itself.
  // With the login, as everything read from the mirror: it fetches what it doesn't have yet from GitHub.
  const listed = await mirrorGit(mirror).run(["ls-tree", "-r", "-t", "-z", "--full-tree", head]);
  if (listed.code !== 0) throw new Error(`Couldn't read the file modes at ${head.slice(0, 7)}.`);
  for (const entry of listed.stdout.split("\0")) {
    const m = /^(\d{6}) \w+ [0-9a-f]+\t([\s\S]+)$/.exec(entry);
    if (!m) continue;
    if (modes.has(m[2]!)) modes.set(m[2]!, m[1]!);
    if (m[1] !== "040000") files.push(m[2]!);
  }
  return { modes, files };
}

/**
 * The commit on the branch now, when it is ours: right on the commit we checked, with this very message.
 * Read from the branch itself, which moves at once, not the pull request's head, which GitHub updates a
 * little later. Null when it isn't, or can't be read.
 */
async function landedCommit(api: GitHub, branch: string, parent: string, message: string, plan: PushPlan): Promise<string | null> {
  const ref = await api.get<{ object: { sha: string } }>(`git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`).catch(() => null);
  if (!ref) return null;
  type File = { filename: string; previous_filename?: string; status: string; sha?: string };
  const tip = await api.get<{ sha: string; parents: { sha: string }[]; commit: { message: string }; files?: File[] }>(`commits/${ref.object.sha}`).catch(() => null);
  if (!tip || tip.parents.length !== 1 || tip.parents[0]?.sha !== parent) return null;
  const same = (text: string) => text.replace(/\r\n/g, "\n").trim();
  if (same(tip.commit.message) !== same(message)) return null;
  // And it changed exactly these files, to these contents: another run with the same message did other
  // things. GitHub shows a deleted file and an added one with the same contents as one rename.
  const changed = new Map<string, File>();
  for (const f of tip.files ?? []) {
    changed.set(f.filename, f);
    if (f.previous_filename) changed.set(f.previous_filename, { filename: f.previous_filename, status: "removed" });
  }
  const paths = [...plan.additions.map((a) => a.path), ...plan.deletions];
  if (changed.size !== paths.length || !paths.every((p) => changed.has(p))) return null;
  // Each deletion as a deletion, and each file written with these contents.
  if (!plan.deletions.every((p) => changed.get(p)?.status === "removed")) return null;
  return plan.additions.every((a) => changed.get(a.path)?.status !== "removed" && changed.get(a.path)?.sha === blobSha(a.bytes)) ? tip.sha : null;
}

/** The id git gives a file's contents. */
export function blobSha(bytes: Buffer): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/**
 * Why the jobs' commit may not go onto this branch, or null when it may. Never onto a long-lived one: a
 * pull request can come from main itself, such as one from main into a release branch, and a commit there
 * would skip every review. The default branch and a protected one count.
 */
export function longLivedBranch(branch: string, defaultBranch: string | undefined, isProtected: boolean): string | null {
  if (defaultBranch && branch === defaultBranch) return `The pull request comes from ${branch}, the repository's default branch, and jobs never push to it.`;
  if (isProtected) return `The pull request comes from ${branch}, a protected branch, and jobs never push to one.`;
  return null;
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
  // Whatever goes wrong, the step's outputs say so: a later step that reports why nothing was pushed has a reason.
  try {
    let result: unknown;
    try {
      result = JSON.parse(readFileSync(o.from, "utf8"));
    } catch {
      return refuse(`The jobs result in ${o.from} can't be read.`, 1);
    }
    // A file with no list of changes is a broken one, not a run with nothing to push.
    if (!Array.isArray((result as JobsResult | null)?.changes)) return refuse(`The jobs result in ${o.from} can't be read.`, 1);
    if (!(result as JobsResult).changes.length) return refuse("The jobs changed nothing.", 0);

    const pr = await fetchPullRequest(ref);
    // GitHub gives a fork's pull request no token that can push to it, and Mergelight never asks for one.
    // GitHub ignores letter case in a repository's name. A fork's pull request is no failure: nothing can be pushed to it.
    if (!pr.sameRepo || !pr.headRef) return refuse("The pull request comes from another repository, and nothing is pushed to one.", 0);
    // Closed or merged while the jobs ran: a commit on its branch would go nowhere.
    if (pr.state && pr.state !== "open") return refuse("The pull request is closed.", 0);
    const api = new GitHub(pr.owner, pr.repo, { dryRun: o.dryRun, log: o.log });
    const branchPath = pr.headRef.split("/").map(encodeURIComponent).join("/");
    const branch = await api.get<{ protected?: boolean }>(`branches/${branchPath}`);
    const longLived = longLivedBranch(pr.headRef, pr.defaultBranch, branch?.protected === true);
    if (longLived) return refuse(longLived, 0);
    if ((result as JobsResult).head !== pr.headSha) {
      // Run again after its push landed: the branch is now at the commit it made, right on the one the
      // jobs ran on, with the jobs line and these very files. That is pushed, not refused.
      const api = new GitHub(pr.owner, pr.repo, { dryRun: o.dryRun, log: o.log });
      type File = { filename: string; previous_filename?: string; status: string; sha?: string };
      type Tip = { sha: string; parents: { sha: string }[]; commit: { message: string }; files?: File[] };
      const tip = await api.get<Tip>(`commits/${pr.headSha}`).catch(() => null);
      // Each file as the commit left it, a rename's old name as removed: these very changes, contents too.
      const changed = new Map<string, File>();
      for (const f of tip?.files ?? []) {
        changed.set(f.filename, f);
        if (f.previous_filename) changed.set(f.previous_filename, { filename: f.previous_filename, status: "removed" });
      }
      const changes = (result as JobsResult).changes.filter((c) => plainPath(c?.path));
      const sameChange = (c: (typeof changes)[number]) => {
        const f = changed.get(c.path);
        if (!f) return false;
        if ("deleted" in c) return f.status === "removed";
        return f.status !== "removed" && typeof c.contents === "string" && f.sha === blobSha(Buffer.from(c.contents, "base64"));
      };
      const ours =
        tip &&
        tip.parents.length === 1 &&
        tip.parents[0]?.sha === (result as JobsResult).head &&
        // The jobs line names the very jobs whose changes these are, as commitMessage writes it.
        (tip.commit.message.trim().split("\n").pop() ?? "") === `${JOBS_TRAILER}: ${(result as JobsResult).outcomes.filter((o) => o?.status === "changed" && Array.isArray(o.files) && o.files.some((f) => changes.some((c) => c.path === f))).map((o) => o.name).join(", ")}` &&
        changed.size === changes.length &&
        changes.every(sameChange);
      if (ours) {
        o.log(`Already pushed as ${pr.headSha.slice(0, 7)}.`);
        output({ pushed: "true", commit: pr.headSha });
        return 0;
      }
      return refuse(`The jobs ran on ${String((result as JobsResult).head).slice(0, 7)}, but the branch is at ${pr.headSha.slice(0, 7)} now. The next push runs them again.`, 0);
    }

    const { mirror, teamBase } = await fetchMirror(pr);
    const git = mirrorGit(mirror);
    // The jobs step runs no job on a commit jobs made, so a result for one is not its own.
    if (await isJobCommit(git, pr.headSha)) return refuse("The newest commit is one that jobs made, and no job runs on it.", 1);
    const { jobs: all, guarded: baseGuard, incomplete } = await jobFilesFor(mirror, teamBase);
    // The guard on the base branch couldn't be worked out in full: what the jobs step ran on is not checked.
    if (incomplete) return refuse(incomplete.replace(/so no job runs/g, "so nothing is pushed"), 0);
    // The head's own links and imports are guarded too, as in the jobs step.
    const headGuard = await headGuarded(mirror, pr.headSha, all);
    if ("why" in headGuard) return refuse(headGuard.why.replace(/so no job runs/g, "so nothing is pushed"), 0);
    const guarded = [...new Set([...baseGuard, ...headGuard.guarded])];
    // Only the jobs this pull request starts, worked out again the way the jobs step does: a job whose
    // files it doesn't change may change nothing, whatever the result file says.
    const mergeBase = await git.run(["merge-base", teamBase, pr.headSha]);
    if (mergeBase.code !== 0) throw new Error(`Couldn't find where ${pr.headRef} branched off ${pr.baseRef}.`);
    const touched = await git.run(["diff", "--name-only", "-z", "--no-renames", "--no-color", "--no-ext-diff", `${mergeBase.stdout.trim()}...${pr.headSha}`]);
    if (touched.code !== 0) throw new Error(`Couldn't read what the pull request changes.`);
    const jobs = jobsToRun(all, touched.stdout.split("\0").filter(Boolean));
    const paths = (result as JobsResult).changes.map((c) => c?.path).filter(plainPath);
    const { modes, files } = await headTree(mirror, pr.headSha, paths);
    const plan = checkPush(result, jobs, pr.headSha, modes, guarded, files);
    if ("why" in plan) return refuse(plan.why, 1);
    // Nor may a job delete a binary file, such as an image: checked against the head, as the jobs step does.
    for (const path of plan.deletions) {
      const binary = await blobIsBinary(git, `${pr.headSha}:${path}`);
      if (binary === null) throw new Error(`Couldn't read ${path} at ${pr.headSha.slice(0, 7)}.`);
      if (binary) return refuse(`${path} is a binary file, which a job may never delete.`, 1);
    }
    // The jobs step drops a job that writes a secret the file didn't have. The file it hands over is checked again.
    for (const a of plan.additions) {
      // The mirror holds no file contents until they are asked for, so this fetches them, with the login a private repository needs.
      let old = modes.get(a.path) && modes.get(a.path) !== "040000" ? await git.bytes(["cat-file", "blob", `${pr.headSha}:${a.path}`]) : Buffer.alloc(0);
      if (!old) {
        // Too large to hold, such as a huge file a job shrank: compared with nothing, so any key in the
        // new file counts as new, and the push is refused rather than one with a key let through.
        const size = await git.run(["cat-file", "-s", `${pr.headSha}:${a.path}`]);
        if (size.code !== 0 || !(Number(size.stdout.trim()) > 60 * 1024 * 1024)) throw new Error(`Couldn't read ${a.path} at ${pr.headSha.slice(0, 7)}.`);
        old = Buffer.alloc(0);
      }
      // A job never writes text over a binary file, such as an image, as the jobs step checks too. Told
      // from the file's start, so a file of any size is checked, and one that can't be is refused.
      if (modes.get(a.path) && modes.get(a.path) !== "040000") {
        const binary = await blobIsBinary(git, `${pr.headSha}:${a.path}`);
        if (binary === null) throw new Error(`Couldn't read ${a.path} at ${pr.headSha.slice(0, 7)}.`);
        if (binary) return refuse(`${a.path} is a binary file, which a job may never overwrite.`, 1);
      }
      // Read as the text it is, so a key in a UTF-16 file is seen too.
      const secret = newSecret(textOf(a.bytes), textOf(old));
      if (secret) return refuse(`${a.path} would hold what looks like ${secret === "a key or token" ? "a key or token" : `the runner's ${secret}`}.`, 1);
    }

    const message = commitMessage(plan);
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
      // An earlier try may have landed with its answer lost, and a later one then fails, saying the branch
      // moved or with a server error: if the branch now has our commit, it was pushed.
      const ours = await landedCommit(api, pr.headRef, pr.headSha, `${message.headline}\n\n${message.body}`, plan);
      if (ours) {
        o.log(`Pushed ${ours.slice(0, 7)}: ${message.headline}.`);
        output({ pushed: "true", commit: ours });
        return 0;
      }
      if (/STALE_DATA|expected branch to point to/i.test(why)) return refuse(`The branch moved while the jobs ran. The next push runs them again. (${why.slice(0, 200)})`, 0);
      return refuse(`GitHub refused the commit: ${why.slice(0, 300)}`, 1);
    }
    o.log(`Pushed ${commit.oid.slice(0, 7)}: ${message.headline}. ${commit.url}`);
    output({ pushed: "true", commit: commit.oid });
    return 0;
  } catch (err) {
    return refuse(`Something went wrong: ${(err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").slice(0, 300)}`, 1);
  }
}
