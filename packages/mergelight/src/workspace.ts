import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { run, runOk } from "./run.js";
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
  cleanup: () => Promise<void>;
}

/**
 * Keeps a blobless bare mirror of the repository in the cache, fetches the PR,
 * and checks out the commit under review in a temporary worktree.
 */
export async function prepareWorkspace(pr: PullRequest, at?: string): Promise<Workspace> {
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

    return {
      dir,
      mergeBase,
      headSha,
      diff,
      diffStat,
      diffTruncated: diff.length > MAX_INLINE_DIFF,
      changedFiles,
      touchedPaths,
      cleanup: async () => {
        await run("git", ["-C", mirror, "worktree", "remove", "--force", dir]);
        rmSync(dir, { recursive: true, force: true });
        await run("git", ["-C", mirror, "worktree", "prune"]);
      },
    };
  });
}
