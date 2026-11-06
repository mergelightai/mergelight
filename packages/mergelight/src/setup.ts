import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { run, runOk } from "./run.js";

export const INSTALL_URL = "https://github.com/apps/mergelight-ai/installations/new";
const SECRET = "CODEX_AUTH_JSON";
const BRANCH = "mergelight-setup";
const WORKFLOWS = ["mergelight.yml", "mergelight-approve.yml", "mergelight-refresh.yml"];
const SKIP_MARKER = "github.event.pull_request.head.repo.full_name == github.repository";

export interface SetupOptions {
  repo: string;
  /** Branch the workflows go to. Defaults to the repository's default branch. */
  base?: string;
  /** Pull requests from these branches aren't reviewed, like staging into main. */
  skipBranches?: string[];
  /** Log in to Codex again, even if the repository already has a login. */
  relogin?: boolean;
  /** Don't stop to ask whether the app is installed. */
  yes?: boolean;
}

export interface SetupDeps {
  gh: (args: string[], input?: string) => Promise<string>;
  /** Logs in to Codex and returns the contents of auth.json. */
  codexLogin: () => Promise<string>;
  open: (url: string) => Promise<void>;
  confirm: (question: string) => Promise<void>;
  log: (message: string) => void;
}

/** The workflow files, adjusted for this repository. */
export function workflowFiles(skipBranches: string[] = []): { name: string; content: string }[] {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "templates");
  return WORKFLOWS.map((name) => {
    let content = readFileSync(join(dir, name), "utf8");
    if (name === "mergelight.yml" && skipBranches.length) {
      if (!content.includes(SKIP_MARKER)) throw new Error(`${name} has changed: can't add the branches to skip.`);
      // GitHub expressions quote strings with single quotes, doubled inside, and fromJSON needs double quotes.
      const json = JSON.stringify(skipBranches).replace(/'/g, "''");
      // A function, so a $ in a branch name stays a $.
      content = content.replace(SKIP_MARKER, () => `${SKIP_MARKER} &&\n      !contains(fromJSON('${json}'), github.head_ref)`);
    }
    return { name, content };
  });
}

/** A ChatGPT login is only useful in CI if it can refresh itself. */
export function checkAuthJson(raw: string): void {
  let auth: { auth_mode?: string; tokens?: { refresh_token?: string } };
  try {
    auth = JSON.parse(raw);
  } catch {
    throw new Error("Codex wrote a login file that can't be read. Run setup again.");
  }
  if (auth.auth_mode !== "chatgpt" || !auth.tokens?.refresh_token) {
    throw new Error("That wasn't a ChatGPT login. Log in with your ChatGPT account, or use openai-api-key in the workflow.");
  }
}

async function hasFile(deps: SetupDeps, repo: string, path: string, ref: string): Promise<{ sha: string; content: string } | null> {
  try {
    const out = await deps.gh(["api", `repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`]);
    const file = JSON.parse(out) as { sha: string; content: string };
    return { sha: file.sha, content: Buffer.from(file.content, "base64").toString("utf8") };
  } catch {
    return null;
  }
}

/** Puts the workflows on a branch and opens a pull request. Returns its URL, or null if there's nothing to add. */
async function openWorkflowPr(deps: SetupDeps, opts: SetupOptions, base: string): Promise<string | null> {
  const { repo } = opts;
  const files = workflowFiles(opts.skipBranches);

  const missing: typeof files = [];
  for (const f of files) {
    const onBase = await hasFile(deps, repo, `.github/workflows/${f.name}`, base);
    if (onBase?.content !== f.content) missing.push(f);
  }
  if (!missing.length) return null;

  const baseSha = (await deps.gh(["api", `repos/${repo}/git/ref/heads/${base}`, "--jq", ".object.sha"])).trim();
  try {
    await deps.gh(["api", "-X", "POST", `repos/${repo}/git/refs`, "-f", `ref=refs/heads/${BRANCH}`, "-f", `sha=${baseSha}`]);
  } catch {
    // Left by an earlier setup. The files below are brought up to date on it.
  }
  for (const f of missing) {
    const path = `.github/workflows/${f.name}`;
    const existing = await hasFile(deps, repo, path, BRANCH);
    if (existing?.content === f.content) continue;
    await deps.gh([
      "api", "-X", "PUT", `repos/${repo}/contents/${path}`,
      "-f", `message=chore(ci): add ${f.name}`,
      "-f", `content=${Buffer.from(f.content).toString("base64")}`,
      "-f", `branch=${BRANCH}`,
      ...(existing ? ["-f", `sha=${existing.sha}`] : []),
    ]);
  }

  const open = JSON.parse(await deps.gh(["api", `repos/${repo}/pulls?head=${repo.split("/")[0]}:${BRANCH}&state=open`])) as { html_url: string }[];
  if (open[0]) return open[0].html_url;
  const created = await deps.gh([
    "api", "-X", "POST", `repos/${repo}/pulls`,
    "-f", "title=chore(ci): add Mergelight review",
    "-f", `head=${BRANCH}`,
    "-f", `base=${base}`,
    "-f", "body=Adds Mergelight's code review. This pull request reviews itself, so you can see it working before you merge.",
    "--jq", ".html_url",
  ]);
  return created.trim();
}

/** Sets up one repository: the app, the Codex login, then a pull request with the workflows. */
export async function setup(opts: SetupOptions, deps: SetupDeps): Promise<number> {
  const { repo, yes } = opts;
  const info = JSON.parse(await deps.gh(["api", `repos/${repo}`])) as { private: boolean; default_branch: string };
  const base = opts.base ?? info.default_branch;

  deps.log(`1 of 3: install the Mergelight AI app on ${repo}`);
  if (yes) {
    deps.log(`  Skipped asking. If it isn't installed: ${INSTALL_URL}`);
  } else {
    await deps.open(INSTALL_URL);
    await deps.confirm(`  Installed? Press Enter to continue. ${INSTALL_URL} `);
  }

  deps.log("2 of 3: Codex login");
  const secrets = JSON.parse(await deps.gh(["secret", "list", "--repo", repo, "--json", "name"])) as { name: string }[];
  if (secrets.some((s) => s.name === SECRET) && !opts.relogin) {
    deps.log(`  ${repo} already has one.`);
  } else {
    if (!info.private) {
      deps.log(`  OpenAI allows a ChatGPT login in CI for private repositories only. For ${repo}, set openai-api-key in the workflow.`);
      return 1;
    }
    const auth = await deps.codexLogin();
    checkAuthJson(auth);
    await deps.gh(["secret", "set", SECRET, "--repo", repo], auth);
    deps.log(`  Saved. It refreshes itself from now on.`);
  }

  deps.log(`3 of 3: add the workflows to ${base}`);
  const url = await openWorkflowPr(deps, opts, base);
  if (url) deps.log(`\nDone. Merge this to turn it on, it's reviewing itself now:\n${url}`);
  else deps.log(`\nDone. ${repo} already has the workflows on ${base}.`);
  return 0;
}

/** Logs in with a separate Codex home, so CI never shares a login with your own machine. */
export async function codexLogin(): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), "mergelight-codex-login-"));
  try {
    writeFileSync(join(home, "config.toml"), 'cli_auth_credentials_store = "file"\n');
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn("codex", ["login"], { stdio: "inherit", env: { ...process.env, CODEX_HOME: home } });
      child.on("error", reject);
      child.on("close", (c) => resolve(c ?? 1));
    });
    const file = join(home, "auth.json");
    if (code !== 0 || !existsSync(file)) throw new Error("Codex login didn't finish.");
    return readFileSync(file, "utf8");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

export function realDeps(): SetupDeps {
  return {
    gh: async (args, input) => (await runOk("gh", args, input === undefined ? {} : { input })).stdout,
    codexLogin,
    open: async (url) => {
      await run(process.platform === "darwin" ? "open" : "xdg-open", [url]).catch(() => undefined);
    },
    confirm: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      await rl.question(question);
      rl.close();
    },
    log: (message) => console.log(message),
  };
}
