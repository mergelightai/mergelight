import { CommandError, runOk } from "./run.js";
import type { PullRequest } from "./types.js";

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

/**
 * Accepts a pull request URL, owner/repo#123, or a bare number together with
 * a default repository ("owner/repo").
 */
export function parsePrRef(ref: string, defaultRepo?: string): PrRef {
  const url = ref.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (url) return { owner: url[1]!, repo: url[2]!, number: Number(url[3]) };

  const short = ref.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
  if (short) return { owner: short[1]!, repo: short[2]!, number: Number(short[3]) };

  const bare = ref.match(/^#?(\d+)$/);
  if (bare && defaultRepo) {
    const [owner, repo] = defaultRepo.split("/");
    if (owner && repo) return { owner, repo, number: Number(bare[1]) };
  }
  if (bare) {
    throw new Error(`"${ref}" is only a number. Pass --repo owner/name, or run this inside a clone of the repository.`);
  }
  throw new Error(`Could not read "${ref}" as a pull request. Use a URL, owner/repo#123, or a number with --repo.`);
}

/** The repository of the current directory, if gh can tell. */
export async function currentRepo(): Promise<string | undefined> {
  try {
    const { stdout } = await runOk("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

interface ApiPull {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  user: { login: string } | null;
  base: { ref: string; sha: string; repo?: { default_branch?: string } | null };
  head: { sha: string; ref: string; repo: { full_name: string } | null };
  state?: string;
  additions: number;
  deletions: number;
  changed_files: number;
}

/** gh api, retried a few times when GitHub answers with a 5xx or the network drops. */
async function ghApi(path: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      return (await runOk("gh", ["api", path])).stdout;
    } catch (err) {
      const transient = err instanceof CommandError && /HTTP 5\d\d|timeout|connection reset|EOF/i.test(err.message);
      if (!transient || attempt === 4) throw err;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

export async function fetchPullRequest(ref: PrRef): Promise<PullRequest> {
  const pull = JSON.parse(await ghApi(`repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`)) as ApiPull;
  return {
    owner: ref.owner,
    repo: ref.repo,
    number: pull.number,
    title: pull.title,
    body: pull.body ?? "",
    url: pull.html_url,
    author: pull.user?.login ?? "unknown",
    baseRef: pull.base.ref,
    baseSha: pull.base.sha,
    headSha: pull.head.sha,
    headRef: pull.head.ref,
    headRepo: pull.head.repo?.full_name ?? null,
    state: pull.state,
    defaultBranch: pull.base.repo?.default_branch,
    additions: pull.additions,
    deletions: pull.deletions,
    changedFiles: pull.changed_files,
  };
}
