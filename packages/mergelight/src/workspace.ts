import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, posix } from "node:path";
import { run, runOk } from "./run.js";
import { importSkills, SKILL_GIT_TIMEOUT_MS, SKILL_IMPORT_TIMEOUT_MS, type TeamSkill } from "./skills.js";
import type { Convention } from "./prompt.js";
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

/** Which instruction files apply: the root ones, AGENTS.md or CLAUDE.md in a folder above a changed file, and .github/instructions. */
export function conventionPaths(all: string[], changedPaths: string[]): string[] {
  const folders = new Set<string>();
  for (const changed of changedPaths) {
    const parts = changed.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) folders.add(parts.slice(0, i).join("/"));
  }
  const present = new Set(all);
  const root = CONVENTION_FILES.filter((p) => present.has(p));
  const github = all.filter((p) => p.startsWith(".github/instructions/") && p.endsWith(".instructions.md")).sort();
  const nested = all
    .filter((p) => {
      const at = p.lastIndexOf("/");
      return at > 0 && ["AGENTS.md", "CLAUDE.md"].includes(p.slice(at + 1)) && folders.has(p.slice(0, at));
    })
    // Closest to the root first: a folder's file comes before the ones in its subfolders.
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  // The rules closest to the changed code come before .github/instructions, so they aren't the ones crowded out.
  return [...root, ...nested, ...github];
}

/**
 * The team's instruction files as the base branch has them. The checkout is the pull request's, and
 * its author could add or rewrite AGENTS.md there to steer the reviewers. A file that is a link is
 * followed once, to a file inside the repository. A file that is missing, too large, or can't be
 * read in time is left out: it never stops a review.
 */
export async function conventionsFor(mirror: string, base: string, changedPaths: string[] = []): Promise<Convention[]> {
  const git = (args: string[]) =>
    run("git", ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", "-C", mirror, ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      timeoutMs: SKILL_GIT_TIMEOUT_MS,
    }).catch(() => null);
  const listed = await git(["ls-tree", "-r", "-z", "--full-tree", base]);
  if (listed?.code !== 0) return [];
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
  const read = async (path: string): Promise<{ path: string; sha: string; text: string } | null> => {
    let file = tree.get(path);
    if (file?.mode === "120000") {
      // A link: git keeps the target's path as its content.
      const target = (await blob(file.sha))?.trim() ?? "";
      const resolved = posix.normalize(posix.join(posix.dirname(path), target));
      if (!target || target.startsWith("/") || resolved === ".." || resolved.startsWith("../")) return null;
      file = tree.get(resolved);
    }
    if (!file || (file.mode !== "100644" && file.mode !== "100755")) return null;
    const text = (await blob(file.sha))?.trim();
    return text ? { path, sha: file.sha, text } : null;
  };
  const found = await Promise.all(conventionPaths([...tree.keys()], changedPaths).slice(0, MAX_CONVENTION_FILES * 2).map(read));
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
  return conventions;
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
  /** AGENTS.md and the other instruction files, from the base branch. */
  conventions: Convention[];
  cleanup: () => Promise<void>;
}

/**
 * Keeps a blobless bare mirror of the repository in the cache, fetches the PR,
 * and checks out the commit under review in a temporary worktree.
 */
export async function prepareWorkspace(pr: PullRequest, at?: string, skillFolders: string[] = []): Promise<Workspace> {
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
    const conventions = await withDeadline(conventionsFor(mirror, teamBase, touchedPaths), SKILL_IMPORT_TIMEOUT_MS + 2 * SKILL_GIT_TIMEOUT_MS, []);

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
      conventions,
      cleanup: async () => {
        await run("git", ["-C", mirror, "worktree", "remove", "--force", dir]);
        rmSync(dir, { recursive: true, force: true });
        await run("git", ["-C", mirror, "worktree", "prune"]);
      },
    };
  });
}
