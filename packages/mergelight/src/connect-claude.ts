import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { agentEnv } from "./providers/codex.js";

/**
 * Connects a Claude plan from a pull request, with no terminal.
 *
 * The unmodified `claude setup-token` runs in the customer's own GitHub Actions run. It makes the link, the
 * person confirms on Claude's own page, and Claude shows them a code. They paste it on the setup page, which
 * leaves it in their repository for this run to read. The code is useless without a secret that stays in this
 * run, and the token it buys is saved as the repository's secret. None of it passes through Mergelight.
 */

const WAIT_MS = 16 * 60_000;
const POLL_MS = 5_000;
const LINK_WAIT_MS = 45_000;
const TOKEN_WAIT_MS = 60_000;

function plain(output: string): string {
  return output
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[=>()][0-9A-B]?/g, "");
}

/** The sign-in link, once all of it has arrived. Only Claude's own site counts. */
export function parseClaudeLink(output: string): string | null {
  const found = plain(output).match(/https:\/\/claude\.(?:com|ai)\/\S+(?=\s)/)?.[0];
  if (!found) return null;
  try {
    const url = new URL(found);
    return url.pathname.includes("oauth/authorize") && url.searchParams.has("code_challenge") ? found : null;
  } catch {
    return null;
  }
}

export function parseClaudeToken(output: string): string | null {
  return plain(output).match(/\bsk-ant-oat[\w-]{20,}(?=\s)/)?.[0] ?? null;
}

/**
 * The code, if this is one. `claude setup-token` only takes `code#state`, and its state is 43 characters.
 */
export function readPastedCode(body: string): string | null {
  const text = body.trim();
  return /^[\w.~-]{10,500}#[\w.~-]{20,500}$/.test(text) ? text : null;
}

export interface ClaudeSignIn {
  url: string;
  /** Sends the code, and gives back the token if Claude accepts it. */
  finish: (code: string) => Promise<string | null>;
  stop: () => void;
}

type SpawnLike = (command: string, args: string[], options: object) => {
  stdin: { write: (text: string) => unknown; on?: (event: string, listener: () => void) => unknown };
  stdout: { setEncoding: (e: string) => unknown; on: (event: string, listener: (text: string) => void) => unknown };
  stderr: { on: (event: string, listener: () => void) => unknown } | null;
  on: (event: string, listener: () => void) => unknown;
  kill: (signal?: NodeJS.Signals) => unknown;
};

/**
 * Starts the sign-in. It needs a terminal, so `script` gives it one, wide enough that the link and the token
 * stay on one line. Nothing it prints is logged, because the token is in there. Null if no link appears.
 */
export function startClaudeSignIn(spawnImpl: SpawnLike = spawn as unknown as SpawnLike, wait = { link: LINK_WAIT_MS, token: TOKEN_WAIT_MS }): Promise<ClaudeSignIn | null> {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    let onOutput = () => {};
    let child: ReturnType<SpawnLike>;
    try {
      child = spawnImpl("script", ["-qfc", "stty cols 3000 rows 50; exec claude setup-token", "/dev/null"], { stdio: ["pipe", "pipe", "ignore"], env: { ...agentEnv(), TERM: "xterm-256color", BROWSER: "true" } });
    } catch {
      resolve(null);
      return;
    }
    const stop = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stop();
      resolve(null);
    }, wait.link);
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(null);
    });
    child.stdin.on?.("error", () => {});
    const finish = (code: string) =>
      new Promise<string | null>((done) => {
        output = "";
        const giveUp = setTimeout(() => done(null), wait.token);
        onOutput = () => {
          const token = parseClaudeToken(output);
          if (!token) return;
          clearTimeout(giveUp);
          done(token);
        };
        // Pasted first and confirmed a moment later, as a person would.
        child.stdin.write(code);
        setTimeout(() => child.stdin.write("\r"), 400);
      }).finally(stop);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text) => {
      output += text;
      onOutput();
      if (settled) return;
      const url = parseClaudeLink(output);
      if (!url) return;
      settled = true;
      clearTimeout(timer);
      resolve({ url, finish, stop });
    });
  });
}

/**
 * Where the setup page leaves the code: a Git reference outside branches and tags, so it shows nowhere on the
 * pull request and notifies nobody. Only someone with write access can make one. The name comes from this
 * sign-in's own state, so a run only ever finds the code meant for it. Null if the link has no usable state.
 */
export function claudeCodeRef(claudeUrl: string): string | null {
  try {
    const state = new URL(claudeUrl).searchParams.get("state") ?? "";
    return /^[\w-]{20,200}$/.test(state) ? `mergelight/claude-code/s${state}` : null;
  } catch {
    return null;
  }
}

/** What's waiting at that reference, if the setup page has been there yet. */
export async function readCodeRef(get: <T>(path: string) => Promise<T>, ref: string): Promise<string | null> {
  const refs = await get<{ ref: string; object: { sha: string; type: string } }[]>(`git/matching-refs/${ref}`);
  const found = refs.find((r) => r.ref === `refs/${ref}` && r.object.type === "blob");
  if (!found) return null;
  const blob = await get<{ content: string }>(`git/blobs/${found.object.sha}`);
  return Buffer.from(blob.content, "base64").toString("utf8");
}

export interface WaitDeps {
  read: () => Promise<string | null>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Stops waiting, when the other login got there first. */
  stopped?: () => boolean;
}

/** Waits for the code. A failed read just waits for the next one, and anything that isn't a whole code doesn't count. */
export async function waitForPastedCode(deps: WaitDeps, timeoutMs = WAIT_MS, pollMs = POLL_MS): Promise<string | null> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const end = now() + timeoutMs;
  while (now() < end && !deps.stopped?.()) {
    const code = readPastedCode((await deps.read().catch(() => null)) ?? "");
    if (code) return code;
    await sleep(pollMs);
  }
  return null;
}

/** Hands the token to the rest of the job: hidden in its logs, and available to the steps that save and use it. */
export function shareClaudeToken(token: string, env: NodeJS.ProcessEnv = process.env, print: (line: string) => void = console.log): void {
  if (!/^sk-ant-oat[\w-]+$/.test(token)) throw new Error("That doesn't look like a Claude token.");
  print(`::add-mask::${token}`);
  if (env.GITHUB_ENV) appendFileSync(env.GITHUB_ENV, `MERGELIGHT_CLAUDE_TOKEN=${token}\nMERGELIGHT_PROVIDER=claude\nMERGELIGHT_CONNECT=0\n`);
}
