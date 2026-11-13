import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, posix } from "node:path";
import { run, runOk } from "./run.js";
import { importSkills, SKILL_GIT_TIMEOUT_MS, SKILL_IMPORT_TIMEOUT_MS, writeSkills, type TeamSkill, type WrittenSkill } from "./skills.js";
import type { Convention, TeamRule } from "./prompt.js";
import { guardedFolders, JOB_FILE, MAX_JOB_FILES, readJobs, refusedPath, type Job, type JobProblem } from "./jobs.js";
import { parseRuleFile, repoRules, RULE_FILE } from "./repo-rules.js";
import type { PullRequest } from "./types.js";

/** Lockfiles and generated files are left out of the diff the model sees. */
const EXCLUDES = [
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "Gemfile.lock",
  "go.sum",
  "*.snap",
  "*.min.js",
  "*.map",
  ".snapshot-*.json",
].map((p) => `:(glob,exclude)**/${p}`).concat([
  ":(glob,exclude)**/__snapshots__/**",
  ":(glob,exclude)**/dist/**",
]);

/** Above this size the diff is not inlined and the model reads it file by file. */
const MAX_INLINE_DIFF = 400_000;

export function cacheDir(): string {
  return process.env.MERGELIGHT_CACHE ?? join(homedir(), ".cache", "mergelight");
}

/** git, authenticated through gh for this call only, never prompting. */
function git(args: string[], cwd?: string) {
  return runOk(
    "git",
    ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", ...args],
    { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
  );
}

/**
 * Mergelight's own folder in the checkout, for the files it writes there: a diff too large for the
 * prompt, and the team's skills. The checkout holds the pull request's files, so the pull request
 * could have put a link at one of those names, to make a write land somewhere else on the machine.
 * A link or a file in the way is removed, never written through.
 */
export function ownFolder(checkout: string): string {
  const dir = join(checkout, ".mergelight");
  if (lstatSync(dir, { throwIfNoEntry: false })?.isDirectory() === false) rmSync(dir, { force: true });
  mkdirSync(dir, { recursive: true });
  // Removing a link removes the link alone, not what it points at.
  for (const name of ["pr.diff", "skills"]) rmSync(join(dir, name), { recursive: true, force: true });
  return dir;
}

/**
 * Skill folders Codex finds by itself and offers to the model. In the checkout they are the pull
 * request's, so its author could plant one that tells the reviewers what to skip. Codex has a switch
 * to stop that, but not every version has it, so the folders go. The diff still shows them.
 */
export const AGENT_SKILL_FOLDERS = [".agents/skills", ".codex/skills"];

export function removeAgentSkills(checkout: string): void {
  for (const folder of AGENT_SKILL_FOLDERS) {
    const parent = join(checkout, folder.split("/")[0]!);
    const kind = lstatSync(parent, { throwIfNoEntry: false });
    if (!kind) continue;
    // .codex or .agents can be a link the pull request made, to a folder anywhere on the machine.
    // Going through it would delete that folder's skills. A link or a file goes, alone.
    if (!kind.isDirectory()) {
      rmSync(parent, { force: true });
      continue;
    }
    // rmSync removes a link at this name without following it.
    rmSync(join(parent, "skills"), { recursive: true, force: true });
  }
}

/**
 * Copies the team's skills, and never lets that stop or hold up a review. The mirror has no file
 * contents of its own, so reading a skill the pull request changed asks GitHub for it: with the
 * same login as every other git call here, never with a prompt, and never for long.
 */
async function skillsFor(mirror: string, base: string, checkout: string, folders: string[]): Promise<TeamSkill[]> {
  if (!folders.length) return [];
  const gitInMirror = (args: string[]) =>
    run("git", ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", "-C", mirror, ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      timeoutMs: SKILL_GIT_TIMEOUT_MS,
    });
  let timer: NodeJS.Timeout | undefined;
  // A last stop, for a git process that doesn't end even when told to.
  const gaveUp = new Promise<TeamSkill[]>((resolve) => {
    timer = setTimeout(() => resolve([]), SKILL_IMPORT_TIMEOUT_MS + 2 * SKILL_GIT_TIMEOUT_MS);
    timer.unref();
  });
  try {
    return await Promise.race([importSkills(mirror, base, checkout, folders, gitInMirror).catch(() => []), gaveUp]);
  } finally {
    clearTimeout(timer);
  }
}

/** The root instruction files whose conventions the reviewers follow, read from the base branch. */
export const CONVENTION_FILES = ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", ".github/CONTRIBUTING.md", "docs/CONTRIBUTING.md", ".github/copilot-instructions.md"];
/** Per file, so one long file can't fill every prompt. */
export const MAX_CONVENTION_CHARS = 12_000;
/** All files together, and how many. */
export const MAX_CONVENTIONS_CHARS = 40_000;
export const MAX_CONVENTION_FILES = 12;
/** A file larger than this isn't read at all. */
const MAX_CONVENTION_BYTES = 256_000;

/** Which instruction files apply: the root ones, and AGENTS.md or CLAUDE.md in a folder above a changed file. */
export function conventionPaths(all: string[], changedPaths: string[]): string[] {
  // .github/instructions files are rules now (repo-rules.ts), not background.
  const folders = new Set<string>();
  for (const changed of changedPaths) {
    const parts = changed.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) folders.add(parts.slice(0, i).join("/"));
  }
  const present = new Set(all);
  const root = CONVENTION_FILES.filter((p) => present.has(p));
  const nested = all
    .filter((p) => {
      const at = p.lastIndexOf("/");
      return at > 0 && ["AGENTS.md", "CLAUDE.md"].includes(p.slice(at + 1)) && folders.has(p.slice(0, at));
    })
    // Closest to the root first: a folder's file comes before the ones in its subfolders.
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  return [...root, ...nested];
}

/**
 * The team's instruction files as the base branch has them. The checkout is the pull request's, and
 * its author could add or rewrite AGENTS.md there to steer the reviewers. A file that is a link is
 * followed once, to a file inside the repository. A file that is missing, too large, or can't be
 * read in time is left out: it never stops a review.
 */
export async function conventionsFor(mirror: string, base: string, changedPaths: string[] = []): Promise<Convention[]> {
  return (await teamFilesFor(mirror, base, changedPaths)).conventions;
}

/** A file as the base branch has it. */
interface BaseFile {
  path: string;
  sha: string;
  text: string;
  /** True when the path is a link, and text is what it leads to. */
  link: boolean;
  /** For a link, the file it leads to. */
  target?: string;
}

/**
 * The base branch's files, listed once, and a way to read one. A file that is a link is followed once,
 * to a file inside the repository. A file that is missing, too large or can't be read is null. Null as a
 * whole when the branch can't be listed.
 */
async function baseTree(mirror: string, base: string): Promise<{ paths: string[]; mode: (path: string) => string | undefined; read: (path: string) => Promise<BaseFile | null>; linkContent: (path: string) => Promise<string | null | "unread"> } | null> {
  const git = (args: string[]) =>
    run("git", ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", "-C", mirror, ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      timeoutMs: SKILL_GIT_TIMEOUT_MS,
    }).catch(() => null);
  const listed = await git(["ls-tree", "-r", "-z", "--full-tree", base]);
  if (listed?.code !== 0) return null;
  const tree = new Map<string, { mode: string; sha: string }>();
  for (const entry of listed.stdout.split("\0")) {
    const m = /^(\d{6}) blob ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(entry);
    if (m) tree.set(m[3]!, { mode: m[1]!, sha: m[2]! });
  }
  const blob = async (sha: string): Promise<string | null> => {
    const sized = await git(["cat-file", "-s", sha]);
    if (sized?.code !== 0 || !(Number(sized.stdout.trim()) <= MAX_CONVENTION_BYTES)) return null;
    const read = await git(["cat-file", "blob", sha]);
    return read?.code === 0 ? read.stdout : null;
  };
  /** What a link holds, as git keeps it: its target, as written. Null for no link, "unread" when git couldn't read it this time. */
  const linkContent = async (path: string): Promise<string | null | "unread"> => {
    const file = tree.get(path);
    if (file?.mode !== "120000") return null;
    return (await blob(file.sha)) ?? "unread";
  };
  const read = async (path: string): Promise<BaseFile | null> => {
    let file = tree.get(path);
    const link = file?.mode === "120000";
    let resolved: string | undefined;
    if (file && link) {
      // A link: git keeps the target's path as its content.
      const target = (await blob(file.sha))?.trim() ?? "";
      resolved = posix.normalize(posix.join(posix.dirname(path), target));
      if (!target || target.startsWith("/") || resolved === ".." || resolved.startsWith("../")) return null;
      file = tree.get(resolved);
    }
    if (!file || (file.mode !== "100644" && file.mode !== "100755")) return null;
    const text = (await blob(file.sha))?.trim();
    return text ? { path, sha: file.sha, text, link, ...(resolved ? { target: resolved } : {}) } : null;
  };
  return { paths: [...tree.keys()], mode: (path) => tree.get(path)?.mode, read, linkContent };
}

/**
 * The repository's jobs, as the base branch has them, and every job file that was left out with the
 * reason. A pull request can't add a job or widen one for itself: its own copies don't count.
 */
export async function jobFilesFor(mirror: string, base: string): Promise<{ jobs: Job[]; problems: JobProblem[]; guarded: string[]; incomplete?: string }> {
  const tree = await baseTree(mirror, base);
  if (!tree) return { jobs: [], problems: [], guarded: [], incomplete: "The base branch couldn't be read this time, so no job runs. The next push tries again." };
  const problems: JobProblem[] = [];
  // A file that looks meant as a job but sits deeper or ends in .MD is named, never skipped without a word.
  for (const p of tree.paths) {
    // A README or a .gitkeep explains or keeps the folder: neither is a job. A README written like a job is named.
    if (/^\.mergelight\/jobs\/(?:readme\.md|\.gitkeep)$/i.test(p)) {
      if (/readme\.md$/i.test(p) && (await tree.read(p))?.text.startsWith("---")) problems.push({ source: p, problem: "is the folder's notes, never read as a job: give the job a file name of its own" });
      continue;
    }
    if (p.toLowerCase().startsWith(".mergelight/jobs/") && !JOB_FILE.test(p)) problems.push({ source: p, problem: "isn't read: a job file sits right in .mergelight/jobs and ends in .md" });
    // A link in place of the folder, or a file next to it, holds no job either.
    else if (/^\.mergelight(?:\/jobs)?$/i.test(p) || p.toLowerCase().startsWith(".mergelight/jobs.")) problems.push({ source: p, problem: "isn't read: jobs are files right in the .mergelight/jobs folder, which can't be a link" });
  }
  const all = tree.paths.filter((p) => JOB_FILE.test(p) && !/\/readme\.md$/i.test(p)).sort();
  const files = await Promise.all(all.slice(0, MAX_JOB_FILES).map(tree.read));
  // A job file and a link to it, or two copies of one file, are one job. The real file wins over a link.
  const kept = new Map<string, BaseFile>();
  const read = files.filter((f): f is BaseFile => f !== null).sort((a, b) => Number(a.link) - Number(b.link) || a.path.localeCompare(b.path));
  const readPaths = new Set(all.slice(0, MAX_JOB_FILES));
  for (const f of read) {
    // By the file it is, so a link and what it leads to are one, but two copies with the same text aren't.
    const first = kept.get(f.target ?? f.path);
    // A job could change the file a link leads to, unless it sits where no job may write.
    if (f.target && !refusedPath(f.target)) problems.push({ source: f.path, problem: `is a link to ${f.target}, a file a job could change. Keep job files in .mergelight` });
    // A link to a file in .mergelight/jobs that isn't read as a job itself would run what is named as not read.
    else if (f.target && /^\.mergelight\/jobs(?:\/|\.|$)/i.test(f.target) && !readPaths.has(f.target)) problems.push({ source: f.path, problem: `is a link to ${f.target}, which isn't a job file that is read` });
    else if (first) problems.push({ source: f.path, problem: `is the same file as ${first.path}, so its job counts once` });
    else kept.set(f.target ?? f.path, f);
  }
  // A skill that isn't on the base branch: the job would run without what the team meant it to follow.
  // Only an ordinary SKILL.md counts, as the skill copy takes no links.
  const parsed = readJobs([...kept.values()], (folder) => ["100644", "100755"].includes(tree.mode(`${folder}/SKILL.md`) ?? ""));
  // A skill named through a linked folder: the copy only takes the real folder, so say that, not "no SKILL.md".
  for (const p of parsed.problems) {
    const skill = /its skill (\S+) has no SKILL\.md/.exec(p.problem)?.[1];
    const parts = skill?.split("/") ?? [];
    const linked = parts.map((_, i) => parts.slice(0, i + 1).join("/")).find((at) => tree.mode(at) === "120000");
    if (linked) p.problem = `its skill ${skill} is reached through ${linked}, which is a link: name the skill by its real folder`;
    else if (skill && tree.mode(`${skill}/SKILL.md`) === "120000") p.problem = `its skill ${skill} has a SKILL.md that is a link: it must be a real file`;
  }
  const unread = all.slice(0, MAX_JOB_FILES).filter((_, i) => files[i] === null).map((source) => ({ source, problem: "couldn't be read: it is empty, too large, a link to something that isn't a file in the repository, or git couldn't read it this time" }));
  const past = all.slice(MAX_JOB_FILES).map((source) => ({ source, problem: `only ${MAX_JOB_FILES} job files are read` }));
  // A file no job may change can be a link to one it could, like AGENTS.md to docs/ai-guide.md. Every link
  // from a protected file or folder is followed the way the file system would, through links in its
  // folders too, and every file and folder on the way is guarded. Links inside what that guards are
  // followed in turn, until nothing new turns up. If that can't be worked out in full, no job runs: the
  // guard is never quietly smaller than it should be.
  const sorted = [...parsed.problems, ...problems, ...unread, ...past].sort((a, b) => a.source.localeCompare(b.source));
  const targets = new Set<string>();
  const folders = guardedFolders(tree.paths, parsed.jobs);
  const inGuard = (p: string) => refusedPath(p) || [...folders, ...targets].some((t) => p === t || p.startsWith(`${t}/`));
  /**
   * A path with every link in it and in its folders followed, part by part, the way the file system does:
   * a link is followed before a ".." after it is applied. Where it ends is guarded. Null when it leaves
   * the repository; "deep" past the limit of links, or at the repository's root.
   */
  const resolve = async (path: string): Promise<string | null | "unread" | "deep"> => {
    const done: string[] = [];
    let rest = path.split("/");
    let hops = 0;
    while (rest.length) {
      const part = rest.shift()!;
      if (part === "" || part === ".") continue;
      if (part === "..") {
        if (!done.length) return null;
        done.pop();
        continue;
      }
      const at = [...done, part].join("/");
      if (tree.mode(at) !== "120000") {
        done.push(part);
        continue;
      }
      if (++hops > MAX_LINK_HOPS) return "deep";
      const content = await tree.linkContent(at);
      if (content === "unread") return "unread";
      // A link to an absolute path leads out of the repository. One to another link goes on from where it sits.
      if (content === null || content.startsWith("/")) return null;
      rest = [...content.split("/"), ...rest];
    }
    // A link to the repository's root would guard every file: that can't be told apart from a mistake.
    if (!done.length) return "deep";
    const end = done.join("/");
    if (!refusedPath(end)) targets.add(end);
    return end;
  };
  const followed = new Set<string>();
  let incomplete: string | undefined;
  for (;;) {
    const todo = tree.paths.filter((p) => tree.mode(p) === "120000" && !followed.has(p) && inGuard(p));
    if (!todo.length) break;
    if (followed.size + todo.length > MAX_GUARDED_LINKS) {
      incomplete = `The base branch has more than ${MAX_GUARDED_LINKS} links from files no job may change, so no job runs.`;
      break;
    }
    for (const link of todo) {
      followed.add(link);
      // The review's own reader (read, above) joins a link's target as text, trimmed: guard that reading too.
      const content = await tree.linkContent(link);
      if (typeof content === "string" && content.trim() && !content.trim().startsWith("/")) {
        const asRead = posix.normalize(posix.join(posix.dirname(link), content.trim())).replace(/\/+$/, "");
        if (asRead && asRead !== "." && !asRead.startsWith("..") && !refusedPath(asRead)) targets.add(asRead);
      }
      const end = await resolve(link);
      if (end === "unread") incomplete ??= `${link} couldn't be read this time, so no job runs. The next push tries again.`;
      if (end === "deep") incomplete ??= `${link} leads through more than ${MAX_LINK_HOPS} links, or to the repository's root, so no job runs.`;
    }
    if (incomplete) break;
  }
  // Every link is guarded too, whatever folder it sits in: a job never writes at or through a link, so a
  // link like docs/ci to .github/workflows can't carry a change into a protected place.
  const links = tree.paths.filter((p) => tree.mode(p) === "120000");
  const guarded = [...new Set([...folders, ...targets, ...links])].sort();
  return { jobs: parsed.jobs, problems: sorted, guarded, ...(incomplete ? { incomplete } : {}) };
}

/** How many links from files no job may change are followed, to guard what they lead to, and how far each. */
const MAX_GUARDED_LINKS = 1000;
const MAX_LINK_HOPS = 10;

/** How many rule files are read at most. */
const MAX_RULE_FILES = 100;

/**
 * The team's instruction files and rule files, as the base branch has them, from one listing of it.
 * Conventions are background for the reviewers; rules are what they check (repo-rules.ts).
 */
export async function teamFilesFor(mirror: string, base: string, changedPaths: string[] = []): Promise<{ conventions: Convention[]; rules: TeamRule[]; unreadRules: string[]; droppedRules: number }> {
  const none = { conventions: [], rules: [], unreadRules: [], droppedRules: 0 };
  const tree = await baseTree(mirror, base);
  if (!tree) return none;
  const { read } = tree;
  const allRulePaths = tree.paths.filter((p) => RULE_FILE.test(p)).sort((a, b) => Number(!a.startsWith(".mergelight/")) - Number(!b.startsWith(".mergelight/")) || a.localeCompare(b));
  const rulePaths = allRulePaths.slice(0, MAX_RULE_FILES);
  // Both kinds at once: one slow read mustn't leave the other no time.
  const [found, ruleFiles] = await Promise.all([
    Promise.all(conventionPaths(tree.paths, changedPaths).slice(0, MAX_CONVENTION_FILES * 2).map(read)),
    Promise.all(rulePaths.map(read)),
  ]);
  const conventions: Convention[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const f of found) {
    // AGENTS.md and CLAUDE.md are often one file and a link to it: the text goes in once.
    if (!f || seen.has(f.sha) || conventions.length >= MAX_CONVENTION_FILES) continue;
    const room = Math.min(MAX_CONVENTION_CHARS, MAX_CONVENTIONS_CHARS - total);
    if (room <= 0) break;
    seen.add(f.sha);
    conventions.push({ path: f.path, text: f.text.slice(0, room), truncated: f.text.length > room });
    total += Math.min(f.text.length, room);
  }
  // A rule file and a link to it are one file: its rules count once.
  const seenRules = new Set<string>();
  const readRules = ruleFiles.filter((f): f is BaseFile => f !== null && !seenRules.has(f.sha) && Boolean(seenRules.add(f.sha)));
  const stats = { dropped: 0 };
  const rules = repoRules(readRules, changedPaths.length ? changedPaths : undefined, stats);
  // A rule file that couldn't be read is named, never dropped without a word.
  // Read but with no rules in it (a Copilot file without applyTo, say), or past the limit of files: named too.
  const noRules = readRules.filter((f) => parseRuleFile(f.path, f.text).length === 0).map((f) => f.path);
  const unreadRules = [...rulePaths.filter((_, i) => ruleFiles[i] === null), ...noRules, ...allRulePaths.slice(MAX_RULE_FILES)];
  return { conventions, rules, unreadRules, droppedRules: stats.dropped };
}

/** The answer, or the fallback once the time is up, for work that must never hold up a review. */
async function withDeadline<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const gaveUp = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    timer.unref();
  });
  try {
    return await Promise.race([work.catch(() => fallback), gaveUp]);
  } finally {
    clearTimeout(timer);
  }
}

async function hasCommit(mirror: string, sha: string): Promise<boolean> {
  const r = await run("git", ["-C", mirror, "cat-file", "-e", `${sha}^{commit}`]);
  return r.code === 0;
}

/** Serializes work on one mirror across processes, so parallel reviews don't trip over each other. */
async function withLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const lock = join(dir, "mergelight.lock");
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10 * 60_000) rmSync(lock, { recursive: true, force: true });
      } catch {
        /* the lock went away between calls */
      }
      if (Date.now() - started > 15 * 60_000) throw new Error(`Timed out waiting for ${lock}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export interface Workspace {
  /** Read-only checkout of the commit under review. */
  dir: string;
  mergeBase: string;
  headSha: string;
  diff: string;
  diffStat: string;
  diffTruncated: boolean;
  /** Changed files (lockfiles and generated files left out), with lines added and removed. */
  changedFiles: { path: string; added: number; removed: number }[];
  /**
   * Every path the pull request touches, lockfiles and generated files included, exactly as git has
   * it. For the team's "always needs a human" rules, which must see a file the reviewers skip. A
   * renamed file counts under both its old and its new name.
   */
  touchedPaths: string[];
  /** The team's skills that were found on the base branch and copied into the checkout for the reviewer. */
  skills: TeamSkill[];
  /** The skills the team wrote on its dashboard, written into the checkout for the reviewer. */
  writtenSkills: TeamSkill[];
  /** AGENTS.md and the other instruction files, from the base branch. */
  conventions: Convention[];
  /** The rules written in the repository's rule files, from the base branch. */
  rules: TeamRule[];
  /** Rule files on the base branch that gave no rules: empty, too large, a link out, a Copilot file without applyTo or kept out of review, or past the limit of files. */
  unreadRules: string[];
  /** Rules for the changed files left out because the repository has more than the limits allow. */
  droppedRules: number;
  /** The instruction and rule files couldn't be read in time, so none are used. */
  teamFilesLate: boolean;
  cleanup: () => Promise<void>;
}

/**
 * Keeps a blobless bare mirror of the repository in the cache, fetches the PR,
 * and checks out the commit under review in a temporary worktree.
 */
export async function prepareWorkspace(pr: PullRequest, at?: string, skillFolders: string[] = [], writtenSkills: WrittenSkill[] = []): Promise<Workspace> {
  const mirror = join(cacheDir(), "repos", pr.owner, `${pr.repo}.git`);
  mkdirSync(join(cacheDir(), "repos", pr.owner), { recursive: true });

  if (!existsSync(mirror)) {
    await git(["clone", "--bare", "--filter=blob:none", "--quiet", `https://github.com/${pr.owner}/${pr.repo}.git`, mirror]);
  }

  return withLock(mirror, async () => {
    const fetch = (...refspecs: string[]) =>
      git(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "origin", ...refspecs], mirror);

    await fetch(`+refs/pull/${pr.number}/head:refs/mergelight/pull/${pr.number}`);

    // The base branch may be gone (deleted after merge). Its recorded commit is enough then.
    let haveBaseBranch = true;
    try {
      await fetch(`+refs/heads/${pr.baseRef}:refs/mergelight/base/${pr.baseRef}`);
    } catch {
      haveBaseBranch = false;
    }

    const headSha = at ?? pr.headSha;
    for (const sha of [headSha, pr.baseSha]) {
      if (!(await hasCommit(mirror, sha))) {
        try {
          await fetch(sha);
        } catch (err) {
          if (sha === headSha) throw err;
        }
      }
    }

    const baseCandidate = (await hasCommit(mirror, pr.baseSha))
      ? pr.baseSha
      : haveBaseBranch
        ? `refs/mergelight/base/${pr.baseRef}`
        : null;
    if (!baseCandidate) {
      throw new Error(`Can't find the base of #${pr.number}: branch ${pr.baseRef} is gone and commit ${pr.baseSha.slice(0, 7)} isn't fetchable.`);
    }
    const mergeBase = (await git(["merge-base", baseCandidate, headSha], mirror)).stdout.trim();

    const range = `${mergeBase}...${headSha}`;
    const diffArgs = ["--no-color", "--no-ext-diff", "--find-renames", range, "--", ...EXCLUDES];
    const diff = (await git(["diff", "-U5", ...diffArgs], mirror)).stdout;
    const diffStat = (await git(["diff", "--stat=200,150", ...diffArgs], mirror)).stdout.trim();
    const changedFiles = (await git(["diff", "--numstat", "--no-renames", ...diffArgs.filter((a) => a !== "--find-renames")], mirror)).stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [added, removed, path] = line.split("\t");
        return { path: path ?? "", added: Number(added) || 0, removed: Number(removed) || 0 };
      });

    // -z gives each path as it is, ended by a NUL. Without it git puts quotes around a name with odd characters in it.
    const touchedPaths = (await git(["diff", "--name-only", "-z", "--no-renames", "--no-color", "--no-ext-diff", range], mirror)).stdout.split("\0").filter(Boolean);

    const dir = mkdtempSync(join(tmpdir(), `mergelight-${pr.repo}-${pr.number}-`));
    await git(["worktree", "add", "--quiet", "--detach", dir, headSha], mirror);
    ownFolder(dir);
    removeAgentSkills(dir);
    // From the base branch as it is now: what the team merged. Not from the pull request, and not from
    // the commit it branched from either. Its author picks that commit, and could pick one from
    // before a skill was written or tightened.
    // The same goes for the instruction files.
    const teamBase = haveBaseBranch ? `refs/mergelight/base/${pr.baseRef}` : baseCandidate;
    const skills = await skillsFor(mirror, teamBase, dir, skillFolders);
    // The skills the team wrote on its dashboard go next to them. A skill that can't be written is one fewer, never a failed review.
    let written: TeamSkill[] = [];
    try {
      written = writeSkills(dir, writtenSkills);
    } catch {
      written = [];
    }
    const { conventions, rules: repoRuleList, unreadRules, droppedRules, timedOut } = await withDeadline<Awaited<ReturnType<typeof teamFilesFor>> & { timedOut?: boolean }>(teamFilesFor(mirror, teamBase, touchedPaths), SKILL_IMPORT_TIMEOUT_MS + 2 * SKILL_GIT_TIMEOUT_MS, { conventions: [], rules: [], unreadRules: [], droppedRules: 0, timedOut: true });

    return {
      dir,
      mergeBase,
      headSha,
      diff,
      diffStat,
      diffTruncated: diff.length > MAX_INLINE_DIFF,
      changedFiles,
      touchedPaths,
      skills,
      writtenSkills: written,
      conventions,
      rules: repoRuleList,
      unreadRules,
      droppedRules,
      teamFilesLate: timedOut === true,
      cleanup: async () => {
        await run("git", ["-C", mirror, "worktree", "remove", "--force", dir]);
        rmSync(dir, { recursive: true, force: true });
        await run("git", ["-C", mirror, "worktree", "prune"]);
      },
    };
  });
}
