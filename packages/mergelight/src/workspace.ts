import { existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, posix } from "node:path";
import { run, runOk } from "./run.js";
import { importSkills, SKILL_GIT_TIMEOUT_MS, SKILL_IMPORT_TIMEOUT_MS, writeSkills, type TeamSkill, type WrittenSkill } from "./skills.js";
import type { Convention, TeamRule } from "./prompt.js";
import { folded, guardedFolders, JOB_FILE, MAX_JOB_FILES, readJobs, refusedPath, type Job, type JobProblem } from "./jobs.js";
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
export async function skillsFor(mirror: string, base: string, checkout: string, folders: string[]): Promise<TeamSkill[]> {
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

/** A git read that failed this time, told apart from a file that is too large or missing. */
const FAILED = Symbol("failed");

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
async function baseTree(mirror: string, base: string): Promise<{ paths: string[]; mode: (path: string) => string | undefined; read: (path: string) => Promise<BaseFile | null>; readOrFail: (path: string, max?: number) => Promise<BaseFile | null | typeof FAILED>; size: (path: string) => Promise<number | null>; linkContent: (path: string) => Promise<string | null | "unread"> } | null> {
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
  /** A file's text, null when it is too large, or FAILED when git couldn't read it this time. */
  const blob = async (sha: string, max = MAX_CONVENTION_BYTES): Promise<string | null | typeof FAILED> => {
    const sized = await git(["cat-file", "-s", sha]);
    if (sized?.code !== 0) return FAILED;
    if (!(Number(sized.stdout.trim()) <= max)) return null;
    const read = await git(["cat-file", "blob", sha]);
    return read?.code === 0 ? read.stdout : FAILED;
  };
  /** What a link holds, as git keeps it: its target, as written. Null for no link, "unread" when git couldn't read it this time. Read once each. */
  const links = new Map<string, Promise<string | null | "unread">>();
  const linkContent = (path: string): Promise<string | null | "unread"> => {
    const known = links.get(path);
    if (known) return known;
    const file = tree.get(path);
    const read = file?.mode !== "120000" ? Promise.resolve(null) : blob(file.sha).then((content) => (content === FAILED || content === null ? "unread" : content));
    links.set(path, read);
    return read;
  };
  /** A file, null when there is none to read, or FAILED when git couldn't read it this time. */
  const readOrFail = async (path: string, max = MAX_CONVENTION_BYTES): Promise<BaseFile | null | typeof FAILED> => {
    let file = tree.get(path);
    const link = file?.mode === "120000";
    let resolved: string | undefined;
    if (file && link) {
      // A link: git keeps the target's path as its content.
      const content = await blob(file.sha);
      if (content === FAILED) return FAILED;
      const target = content?.trim() ?? "";
      resolved = posix.normalize(posix.join(posix.dirname(path), target));
      if (!target || target.startsWith("/") || resolved === ".." || resolved.startsWith("../")) return null;
      file = tree.get(resolved);
    }
    if (!file || (file.mode !== "100644" && file.mode !== "100755")) return null;
    const content = await blob(file.sha, max);
    if (content === FAILED) return FAILED;
    const text = content?.trim();
    return text ? { path, sha: file.sha, text, link, ...(resolved ? { target: resolved } : {}) } : null;
  };
  const read = async (path: string): Promise<BaseFile | null> => {
    const file = await readOrFail(path);
    return file === FAILED ? null : file;
  };
  /** A file's size in bytes, or null when git can't say. */
  const size = async (path: string): Promise<number | null> => {
    const file = tree.get(path);
    const sized = file ? await git(["cat-file", "-s", file.sha]) : null;
    return sized?.code === 0 ? Number(sized.stdout.trim()) : null;
  };
  return { paths: [...tree.keys()], mode: (path) => tree.get(path)?.mode, read, readOrFail, linkContent, size };
}

/**
 * The repository's jobs, as the base branch has them, and every job file that was left out with the
 * reason. A pull request can't add a job or widen one for itself: its own copies don't count.
 */
export async function jobFilesFor(mirror: string, base: string, guardFor?: Job[]): Promise<{ jobs: Job[]; problems: JobProblem[]; guarded: string[]; incomplete?: string }> {
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
  const tries = await Promise.all(all.slice(0, MAX_JOB_FILES).map((p) => tree.readOrFail(p)));
  // A job file git couldn't read this time would let another job take its place: no job runs instead.
  const failedRead = all.find((_, i) => tries[i] === FAILED);
  if (failedRead) return { jobs: [], problems: [], guarded: [], incomplete: `${failedRead} couldn't be read this time, so no job runs. The next push tries again.` };
  const files = tries.map((f) => (f === FAILED ? null : f));
  // A job file and a link to it, or two copies of one file, are one job. The real file wins over a link.
  const kept = new Map<string, BaseFile>();
  const read = files.filter((f): f is BaseFile => f !== null).sort((a, b) => Number(a.link) - Number(b.link) || a.path.localeCompare(b.path));
  const readPaths = new Set(all.slice(0, MAX_JOB_FILES));
  for (const f of read) {
    // By the file it is, so a link and what it leads to are one, but two copies with the same text aren't.
    const first = kept.get(f.target ?? f.path);
    // A job could change the file a link leads to, unless it sits where no job may write.
    if (f.target && !refusedPath(f.target)) problems.push({ source: f.path, problem: `is a link to ${f.target}, outside .mergelight: keep job files themselves in .mergelight` });
    // A link to a file in .mergelight/jobs that isn't read as a job itself would run what is named as not read.
    else if (f.target && /^\.mergelight\/jobs(?:\/|\.|$)/i.test(f.target) && !readPaths.has(f.target)) problems.push({ source: f.path, problem: `is a link to ${f.target}, which isn't a job file that is read` });
    else if (first) problems.push({ source: f.path, problem: `is the same file as ${first.path}, so its job counts once`, ...(f.target ? { target: f.target } : {}) });
    else kept.set(f.target ?? f.path, f);
  }
  // A skill that isn't on the base branch: the job would run without what the team meant it to follow.
  // Only an ordinary SKILL.md counts, as the skill copy takes no links.
  const parsed = readJobs([...kept.values()], (folder) => ["100644", "100755"].includes(tree.mode(`${folder}/SKILL.md`) ?? ""));
  // A SKILL.md the skill copy won't take: empty, or over its size. Said now, not as a failed job each run.
  for (const job of [...parsed.jobs]) {
    if (!job.skill) continue;
    const size = await tree.size(`${job.skill}/SKILL.md`);
    if (size !== null && (size === 0 || size > MAX_SKILL_FILE_BYTES)) {
      parsed.jobs.splice(parsed.jobs.indexOf(job), 1);
      parsed.problems.push({ source: job.source, problem: `its skill's SKILL.md is ${size === 0 ? "empty" : `over ${MAX_SKILL_FILE_BYTES / 1000} KB`}, so the skill can't be used` });
    }
  }
  // No job to run: no guard to work out, and nothing to say about one.
  // A link to a file that couldn't be a job doesn't "count once": say where the reason is.
  const refusedSources = new Set(parsed.problems.map((p) => p.source));
  for (const p of problems) {
    const same = /is the same file as (.+?), so its job counts once/.exec(p.problem)?.[1];
    if (same && refusedSources.has(same)) p.problem = `is a link to ${(p as JobProblem & { target?: string }).target ?? same}, which doesn't run as a job: see ${same}`;
  }
  // A skill named through a linked folder: the copy only takes the real folder, so say that, not "no SKILL.md".
  for (const p of parsed.problems) {
    const skill = /its skill (\S+) has no SKILL\.md/.exec(p.problem)?.[1];
    const parts = skill?.split("/") ?? [];
    const linked = parts.map((_, i) => parts.slice(0, i + 1).join("/")).find((at) => tree.mode(at) === "120000");
    if (linked) p.problem = `its skill ${skill} is reached through ${linked}, which is a link: name the skill by its real folder`;
    else if (skill && tree.mode(`${skill}/SKILL.md`) === "120000") p.problem = `its skill ${skill} has a SKILL.md that is a link: it must be a real file`;
  }
  const unread = all.slice(0, MAX_JOB_FILES).filter((_, i) => files[i] === null).map((source) => ({ source, problem: "couldn't be read: it is empty, too large, or a link to something that isn't a file in the repository" }));
  const past = all.slice(MAX_JOB_FILES).map((source) => ({ source, problem: `only ${MAX_JOB_FILES} job files are read` }));
  // A file no job may change can be a link to one it could, like AGENTS.md to docs/ai-guide.md. Every link
  // from a protected file or folder is followed the way the file system would, through links in its
  // folders too, and every file and folder on the way is guarded. Links inside what that guards are
  // followed in turn, until nothing new turns up. If that can't be worked out in full, no job runs: the
  // guard is never quietly smaller than it should be.
  const sorted = [...parsed.problems, ...problems, ...unread, ...past].map(({ source, problem }) => ({ source, problem })).sort((a, b) => a.source.localeCompare(b.source));
  // guardFor: the guard of this tree for those jobs, the base branch's, whatever jobs the tree itself has.
  const guarding = guardFor ?? parsed.jobs;
  if (!guarding.length) return { jobs: [], problems: sorted, guarded: [] };
  const targets = new Set<string>();
  const folders = guardedFolders(tree.paths, guarding);
  const inGuard = (p: string) => refusedPath(p) || [...folders, ...targets].some((t) => p === t || p.startsWith(`${t}/`));
  /**
   * A path with every link in it and in its folders followed, part by part, the way the file system does:
   * a link is followed before a ".." after it is applied. Where it ends is guarded. Null when it leaves
   * the repository; "deep" past the limit of links, or at the repository's root.
   */
  /** Every file, link and folder of the tree by its name in any letter case, built once. */
  let byCase: Map<string, string[]> | undefined;
  const caseFits = (path: string): string[] => {
    if (!byCase) {
      const index = new Map<string, Set<string>>();
      for (const p of tree.paths) {
        const parts = p.split("/");
        for (let i = 1; i <= parts.length; i++) {
          const at = parts.slice(0, i).join("/");
          const key = folded(at);
          index.set(key, (index.get(key) ?? new Set()).add(at));
        }
      }
      byCase = new Map([...index].map(([k, v]) => [k, [...v]]));
    }
    return byCase.get(folded(path)) ?? [];
  };
  const resolve = async (path: string, guard = true): Promise<string | null | "unread" | "deep"> => {
    const done: string[] = [];
    let rest = path.split("/");
    let hops = 0;
    /** Folders that hold a link on the way. No job may take a link away, so they stay folders. */
    const held = new Set<string>();
    while (rest.length) {
      const part = rest.shift()!;
      if (part === "" || part === ".") continue;
      if (part === "..") {
        if (!done.length) return null;
        // The folder it steps back out of must stay a folder for the path to lead anywhere: a job that
        // emptied it would make a protected file disappear. So it is guarded too, along with all in it,
        // unless a link sits in it, as when a link's own target starts with "..".
        const leaving = done.join("/");
        if (guard && !held.has(leaving)) targets.add(leaving);
        done.pop();
        continue;
      }
      let at = [...done, part].join("/");
      // A disk that ignores letter case opens docs/alias.md for Docs/alias.md: the guard follows it there
      // too. When two names fit, it can't tell which one is opened, so it gives up rather than guess.
      if (tree.mode(at) === undefined) {
        const fits = caseFits(at);
        if (fits.length && !fits.includes(at)) {
          if (fits.length > 1) return "deep";
          at = fits[0]!;
        }
      }
      const real = at.split("/").pop()!;
      if (tree.mode(at) !== "120000") {
        done.push(real);
        continue;
      }
      if (++hops > MAX_LINK_HOPS) return "deep";
      for (let i = 1; i <= done.length; i++) held.add(done.slice(0, i).join("/"));
      const content = await tree.linkContent(at);
      if (content === "unread") return "unread";
      // A link to an absolute path leads out of the repository. One to another link goes on from where it sits.
      if (content === null || content.startsWith("/")) return null;
      rest = [...content.split("/"), ...rest];
    }
    // A link to the repository's root would guard every file: that can't be told apart from a mistake.
    if (!done.length) return "deep";
    const end = done.join("/");
    // Guarded even when its own name is refused: a folder named like a refused file isn't refused inside.
    if (guard) targets.add(end);
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
        if (asRead && asRead !== "." && !asRead.startsWith("..")) targets.add(asRead);
      }
      const end = await resolve(link);
      if (end === "unread") incomplete ??= `${link} couldn't be read this time, so no job runs. The next push tries again.`;
      if (end === "deep") incomplete ??= `${link} leads through more than ${MAX_LINK_HOPS} links, or to the repository's root, so no job runs.`;
    }
    if (incomplete) break;
  }
  // Instruction files can pull other files in, like "@docs/ai-guide.md" in CLAUDE.md, which Claude Code
  // and Gemini CLI read as instructions too, up to 5 levels deep. Those files are guarded as well, through
  // any links on the way. A name that only looks like an import is guarded too: guarding too much is safe.
  if (!incomplete) {
    // Instruction files wherever a job may not write: refused names, and those inside guarded folders
    // and link targets, such as the rules in a folder .cursor links to.
    const isInstructions = (p: string) => /\.mdc?$/i.test(p) && inGuard(p);
    /** A file to scan, and the folders its imports are read from: its own, and the link's when it was reached through one. */
    const queue: { path: string; dirs: string[]; depth: number }[] = [];
    const queued = new Set<string>();
    // Once for each folder a file's imports are read from: one reached again through a link is read from
    // that link's folder too.
    const enqueue = (path: string, dirs: string[], depth: number) => {
      if (depth >= MAX_IMPORT_DEPTH || !tree.mode(path)) return;
      const fresh = [...new Set([posix.dirname(path), ...dirs])].filter((dir) => !queued.has(`${path}\0${dir}`));
      if (!fresh.length) return;
      for (const dir of fresh) queued.add(`${path}\0${dir}`);
      queue.push({ path, dirs: fresh, depth });
    };
    const follow = async (path: string): Promise<string | null> => {
      const end = await resolve(path);
      if (end === "unread") incomplete ??= `${path} couldn't be read this time, so no job runs. The next push tries again.`;
      if (end === "deep") incomplete ??= `${path} leads through more than ${MAX_LINK_HOPS} links, or to the repository's root, so no job runs.`;
      return typeof end === "string" ? end : null;
    };
    // Each instruction file, and where a linked one really leads: a tool that opens it by the link's
    // path reads its imports from the link's folder.
    for (const p of tree.paths.filter(isInstructions)) {
      const at = tree.mode(p) === "120000" ? await follow(p) : p;
      if (at) enqueue(at, [posix.dirname(p)], 0);
    }
    // A folder that is a link, like .claude to config/claude or packages/web to apps/web: the instruction
    // files in it are opened through the link too, so their imports are read from the folder they have
    // there as well. Through a guarded link every Markdown file counts; through any other, only
    // instruction files, and the folder itself isn't guarded for it.
    const markdown = tree.paths.filter((p) => /\.mdc?$/i.test(p));
    for (const link of tree.paths.filter((p) => tree.mode(p) === "120000")) {
      const guardedLink = inGuard(link);
      const end = guardedLink ? await follow(link) : await resolve(link, false);
      // An ordinary link to the root, or one too deep, holds no instruction file of its own that isn't
      // read already; only one git couldn't read this time leaves the guard unsure.
      if (end === "unread") {
        incomplete ??= `${link} couldn't be read this time, so no job runs. The next push tries again.`;
        break;
      }
      if (typeof end !== "string" || end === "deep") continue;
      for (const p of markdown) {
        if (!p.startsWith(`${end}/`)) continue;
        const through = `${link}/${p.slice(end.length + 1)}`;
        if (guardedLink || isInstructions(p) || refusedPath(through)) enqueue(p, [posix.dirname(through)], 0);
      }
    }
    const imported = new Set<string>();
    while (queue.length && !incomplete) {
      const { path, dirs, depth } = queue.shift()!;
      // A file that isn't Markdown, such as a package-lock.json named with @, is read up to a much higher
      // limit: its imports count all the same, and it is often larger than any instruction file.
      const limit = /\.mdc?$/i.test(path) ? MAX_INSTRUCTIONS_BYTES : MAX_IMPORTED_FILE_BYTES;
      const file = await tree.readOrFail(path, limit);
      if (file === FAILED) {
        incomplete = `${path} couldn't be read this time, so no job runs. The next push tries again.`;
        break;
      }
      // Too large to read for its imports: no job runs rather than one with a smaller guard.
      if (file === null && ((await tree.size(path)) ?? 0) > limit) {
        incomplete = `${path} is too large to check what it imports, so no job runs.`;
        break;
      }
      for (const m of file?.text.matchAll(/(?:^|\s)@(\S+)/g) ?? []) {
        // A full stop, comma or bracket after it ends the sentence, not the path. A home or absolute path is outside the repository.
        const raw = m[1]!.replace(/[.,;:)\]]+$/, "");
        if (!raw || raw.startsWith("~") || raw.startsWith("/")) continue;
        for (const dir of dirs) {
          const joined = posix.normalize(posix.join(dir, raw)).replace(/\/+$/, "");
          if (!joined || joined === "." || joined.startsWith("..") || imported.has(joined)) continue;
          imported.add(joined);
          // Guarding a name is cheap, so the limit is high: it only stops a run that would take too long.
          if (imported.size > MAX_IMPORTS) {
            incomplete = `The base branch's instruction files name more than ${MAX_IMPORTS} files, so no job runs.`;
            break;
          }
          targets.add(joined);
          const at = await follow(joined);
          if (at) enqueue(at, [posix.dirname(joined)], depth + 1);
        }
        if (incomplete) break;
      }
    }
  }
  // Every link is guarded too, whatever folder it sits in: a job never writes at or through a link, so a
  // link like docs/ci to .github/workflows can't carry a change into a protected place.
  const links = tree.paths.filter((p) => tree.mode(p) === "120000");
  const guarded = [...new Set([...folders, ...targets, ...links])].sort();
  // A guard that couldn't be worked out in full hands out no job, whatever reads them.
  return incomplete ? { jobs: [], problems: sorted, guarded, incomplete } : { jobs: parsed.jobs, problems: sorted, guarded };
}

/**
 * What the head guards: the files its own links and instruction files lead to, worked out the way the
 * base branch's are. A pull request can only add to the guard this way, never take from it, and the
 * jobs on the head never count. A head that can't be worked out in full says why.
 */
export async function headGuarded(mirror: string, head: string, jobs: Job[]): Promise<{ guarded: string[] } | { why: string }> {
  const { guarded, incomplete } = await jobFilesFor(mirror, head, jobs);
  if (incomplete) return { why: `The pull request's own links and instruction files couldn't be checked in full: ${incomplete.replace(/^The base branch/, "The pull request")}` };
  return { guarded };
}

/** The largest SKILL.md the skill copy takes (skills.ts). */
const MAX_SKILL_FILE_BYTES = 60_000;

/** How many links from files no job may change are followed, to guard what they lead to, and how far each. */
const MAX_GUARDED_LINKS = 1000;
const MAX_LINK_HOPS = 10;
/** How deep instruction files' @ imports are followed, as Claude Code does, how many names are guarded at most, and how large a file is read for them. */
const MAX_IMPORT_DEPTH = 5;
const MAX_IMPORTS = 20_000;
const MAX_INSTRUCTIONS_BYTES = 4_000_000;
/** How large any other file named with @ may be and still be read for its imports. */
const MAX_IMPORTED_FILE_BYTES = 64_000_000;

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
  /** The bare mirror the checkout comes from. */
  mirror: string;
  /** Where the team's files are read from: the base branch as it is now, or the commit the pull request names. */
  teamBase: string;
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
 * The mirror with the pull request's head and its base branch fetched, for the push step, which reads the
 * team's files and the head's file modes but checks nothing out. The team's files come from the base
 * branch as it is now. When it can't be fetched, this throws: an older commit could hold jobs the team
 * has since taken out, so the push never falls back to one.
 */
export async function fetchMirror(pr: PullRequest): Promise<{ mirror: string; teamBase: string }> {
  const mirror = join(cacheDir(), "repos", pr.owner, `${pr.repo}.git`);
  mkdirSync(join(cacheDir(), "repos", pr.owner), { recursive: true });
  if (!existsSync(mirror)) {
    // Cloned beside it and moved into place in one step: the lock lives in the mirror, so two runs on a
    // shared cache can't both be cloning into the same folder. The one that comes second keeps the first's.
    const fresh = mkdtempSync(`${mirror}.new-`);
    try {
      await git(["clone", "--bare", "--filter=blob:none", "--quiet", `https://github.com/${pr.owner}/${pr.repo}.git`, fresh]);
      try {
        renameSync(fresh, mirror);
      } catch {
        // Another run put its clone there first.
      }
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  }
  return withLock(mirror, async () => {
    const fetch = (...refspecs: string[]) => git(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "origin", ...refspecs], mirror);
    await fetch(`+refs/pull/${pr.number}/head:refs/mergelight/pull/${pr.number}`);
    if (!(await hasCommit(mirror, pr.headSha))) await fetch(pr.headSha);
    // Into a ref of this pull request's own: a cached ref of an older branch, such as base/release when
    // the base is now release/2, can't block it.
    const ref = `refs/mergelight/push/${pr.number}/base`;
    await fetch(`+refs/heads/${pr.baseRef}:${ref}`);
    // Pinned to one commit under the lock, as the jobs step does, so a later fetch can't move it.
    const pinned = (await git(["rev-parse", "--verify", `${ref}^{commit}`], mirror)).stdout.trim();
    return { mirror, teamBase: pinned };
  });
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
    // As one commit, read while the mirror is locked: another run can move the branch's ref later.
    const teamBase = (await git(["rev-parse", "--verify", `${haveBaseBranch ? `refs/mergelight/base/${pr.baseRef}` : baseCandidate}^{commit}`], mirror)).stdout.trim();
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
      mirror,
      teamBase,
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
