import { run } from "../run.js";

/**
 * GitHub API calls through the gh CLI, which is already logged in locally and
 * preinstalled on GitHub runners (it reads GH_TOKEN there). Transient errors
 * are retried: a single 503 shouldn't sink a review.
 */

export interface ApiOptions {
  /** Print writes instead of sending them. Reads still happen. */
  dryRun?: boolean;
  log?: (line: string) => void;
}

/** Errors that pass on their own: GitHub down or slow, a dropped connection, a rate limit. Worth another try. */
export const TRANSIENT =
  /HTTP 5\d\d|HTTP 429|timed? ?out|deadline exceeded|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|connection reset|connection refused|error connecting|no such host|unexpected EOF|socket hang up|rate limit|something went wrong|try again/i;

async function gh(args: string[], input?: string): Promise<string> {
  let lastError = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1500 * 2 ** (attempt - 1)));
    const result = await run("gh", args, { input });
    if (result.code === 0) return result.stdout;
    lastError = (result.stderr || result.stdout).trim();
    if (!TRANSIENT.test(lastError)) break;
  }
  throw new Error(`gh ${args.slice(0, 4).join(" ")} failed: ${lastError.split("\n").slice(-3).join(" ")}`);
}

export class GitHub {
  constructor(
    readonly owner: string,
    readonly repo: string,
    private readonly opts: ApiOptions = {},
  ) {}

  get dryRun(): boolean {
    return Boolean(this.opts.dryRun);
  }

  private repoPath(path: string): string {
    return path.startsWith("/") ? path.slice(1) : `repos/${this.owner}/${this.repo}/${path}`;
  }

  async get<T>(path: string): Promise<T> {
    return JSON.parse(await gh(["api", this.repoPath(path)])) as T;
  }

  /** Who this token belongs to. App and workflow tokens aren't a person, so GitHub refuses and this is null. */
  async viewer(): Promise<string | null> {
    return this.get<{ login: string }>("/user").then((u) => u.login, () => null);
  }

  /** All pages of a list endpoint, flattened. */
  async list<T>(path: string): Promise<T[]> {
    const sep = path.includes("?") ? "&" : "?";
    const out = await gh(["api", "--paginate", "--slurp", `${this.repoPath(path)}${sep}per_page=100`]);
    return (JSON.parse(out) as T[][]).flat();
  }

  async write<T>(method: "POST" | "PATCH" | "PUT" | "DELETE", path: string, body: unknown): Promise<T | null> {
    if (this.opts.dryRun) {
      this.opts.log?.(`[dry run] ${method} ${this.repoPath(path)}\n${JSON.stringify(body, null, 2)}`);
      return null;
    }
    const out = await gh(["api", "-X", method, this.repoPath(path), "--input", "-"], JSON.stringify(body));
    return (out.trim() ? JSON.parse(out) : null) as T | null;
  }

  async graphql<T>(query: string, variables: Record<string, string | number>, mutation = false): Promise<T | null> {
    if (mutation && this.opts.dryRun) {
      this.opts.log?.(`[dry run] graphql ${query.replace(/\s+/g, " ").slice(0, 80)} ${JSON.stringify(variables)}`);
      return null;
    }
    const args = ["api", "graphql", "-f", `query=${query}`];
    for (const [k, v] of Object.entries(variables)) args.push(typeof v === "number" ? "-F" : "-f", `${k}=${v}`);
    return (JSON.parse(await gh(args)) as { data: T }).data;
  }
}
