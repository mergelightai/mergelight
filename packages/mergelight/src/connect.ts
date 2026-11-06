import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GitHub } from "./publish/api.js";
import { PENDING_MARKER, pendingSummaryBody, SUMMARY_MARKER } from "./publish/markdown.js";
import { CHECK_FAILED_TITLE, readPrReviewState, writeCheck } from "./publish/publish.js";
import { stateBlock } from "./publish/state.js";

/**
 * Connects a repository to ChatGPT from its own pull request, with no terminal.
 *
 * Codex's device login runs inside the customer's own GitHub Actions run. The link and code go in
 * a comment on their private repository, and the login stays in the runner until the Action saves
 * it as their secret. None of it passes through Mergelight.
 */

/** Codex says the code lasts 15 minutes. */
export const LOGIN_TIMEOUT_MS = 16 * 60_000;

export const INSTALL_URL = "https://github.com/apps/mergelight-ai/installations/new";
export const CHATGPT_SECURITY_URL = "https://chatgpt.com/settings/security";

export interface DeviceLogin {
  url: string;
  code: string;
}

/**
 * Reads the link and code from what `codex login --device-auth` prints. Only OpenAI's own link counts.
 * Output arrives in pieces, so each one only counts once something follows it: a code cut off mid-way
 * would be posted once and could never be corrected.
 */
export function parseDeviceLogin(output: string): DeviceLogin | null {
  const clean = output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  const url = clean.match(/https:\/\/auth\.openai\.com\/\S+(?=\s)/)?.[0];
  const code = clean.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,}(?=\s)/)?.[0];
  return url && code ? { url, code } : null;
}

/** Part of the email of the account in a Codex login, so people can see whose it is. Null if it can't be read. */
export function connectedAccount(authJson: string): string | null {
  try {
    const { tokens } = JSON.parse(authJson) as { tokens: { id_token: string } };
    const { email } = JSON.parse(Buffer.from(tokens.id_token.split(".")[1]!, "base64url").toString("utf8")) as { email?: unknown };
    if (typeof email !== "string") return null;
    const [name, domain] = email.split("@");
    return name && domain ? `${name.slice(0, 2)}***@${domain}` : null;
  } catch {
    return null;
  }
}

/** Anyone who can read the repository could have entered the code, so say whose plan it is now, where it stays visible. */
export function connectedBody(account: string | null, secretName: string): string {
  const who = account ? `the ChatGPT account \`${account}\`` : "the ChatGPT account that entered the code";
  return `🔌 Reviews on this repository now use ${who}. If that isn't yours, remove the \`${secretName}\` secret and push a commit to connect again.`;
}

export function connectBody(login: DeviceLogin, runUrl?: string): string {
  return [
    SUMMARY_MARKER,
    PENDING_MARKER,
    "### 🔌 Connect ChatGPT to start reviewing",
    "",
    `1. Open ${login.url}`,
    `2. Enter this code: \`${login.code}\``,
    "",
    "The review starts by itself once you're connected. The code lasts 15 minutes. If it runs out, push a new commit to get another.",
    "",
    `**If OpenAI refuses the code:** turn on "Enable device code sign-in" in your [ChatGPT security settings](${CHATGPT_SECURITY_URL}), or ask your workspace admin to.`,
    "",
    `<sub>Reviews use the plan of whoever enters this code, so only enter it if you're setting up this repository. It comes from ${runUrl ? `[your own GitHub Actions run](${runUrl})` : "your own GitHub Actions run"}. The login is saved as this repository's secret and is never sent to Mergelight.</sub>`,
  ].join("\n");
}

export function installAppBody(): string {
  return [
    SUMMARY_MARKER,
    PENDING_MARKER,
    "### 🔌 One step left: install the Mergelight AI app",
    "",
    `[Install it on this repository](${INSTALL_URL}), or approve its updated permissions if it's already installed, then push a new commit. The app saves your ChatGPT login, so you only connect once.`,
  ].join("\n");
}

export function connectFailedBody(reason: string): string {
  return [
    SUMMARY_MARKER,
    "### ⚠️ Mergelight couldn't connect to ChatGPT",
    "",
    reason,
    "",
    "Push a new commit to try again. You can also use an OpenAI API key instead: https://mergelight.dev/setup",
  ].join("\n");
}

export interface ConnectDeps {
  /** Runs the login and resolves with its exit code. */
  startLogin: (onOutput: (text: string) => void) => Promise<number>;
  /** Ends a running login. */
  stopLogin: () => void;
  showCode: (login: DeviceLogin) => Promise<void>;
  connected: () => Promise<void>;
  failed: (reason: string) => Promise<void>;
}

export async function connect(deps: ConnectDeps): Promise<number> {
  let output = "";
  let shown = false;
  let notPosted = false;
  let showing: Promise<void> = Promise.resolve();
  const code = await deps.startLogin((text) => {
    output += text;
    if (shown) return;
    const login = parseDeviceLogin(output);
    if (login) {
      shown = true;
      // Nobody can finish a login whose code never reached the pull request, so don't wait for it.
      showing = deps.showCode(login).catch(() => {
        notPosted = true;
        deps.stopLogin();
      });
    }
  });
  await showing;
  if (notPosted) {
    await deps.failed("Mergelight couldn't post the login code on this pull request, because GitHub refused or didn't answer.");
    return 1;
  }
  if (code === 0) {
    await deps.connected();
    return 0;
  }
  await deps.failed(
    shown
      ? `The code ran out, or OpenAI refused it. Check that "Enable device code sign-in" is on in your [ChatGPT security settings](${CHATGPT_SECURITY_URL}).`
      : `Codex couldn't start a device login. "Enable device code sign-in" may be off in your [ChatGPT security settings](${CHATGPT_SECURITY_URL}), or for your workspace.`,
  );
  return 1;
}

/** Tells the pull request the app has to be installed first. There's nowhere to save a login without it. */
export async function askForApp(api: GitHub, number: number, headSha: string): Promise<void> {
  await upsertSummary(api, number, installAppBody());
  await writeCheck(api, null, headSha, {
    status: "completed",
    conclusion: "neutral",
    completed_at: new Date().toISOString(),
    output: { title: "Install the Mergelight AI app", summary: `Install it, then push a new commit: ${INSTALL_URL}` },
  });
}

/** The summary holds what earlier rounds found, so a login prompt on a reviewed pull request has to keep that. */
async function upsertSummary(api: GitHub, number: number, body: string): Promise<void> {
  const { summary } = await readPrReviewState(api, number);
  if (summary) await api.write("PATCH", `issues/comments/${summary.id}`, { body: withState(body, summary.body) });
  else await api.write("POST", `issues/${number}/comments`, { body });
}

export function withState(body: string, previous: string | undefined): string {
  const state = stateBlock(previous);
  return state ? `${body}\n${state}` : body;
}

/** The real thing: Codex on this runner, and the pull request as the place to show the code. */
export function githubConnect(api: GitHub, number: number, headSha: string, log: (line: string) => void, env = process.env): ConnectDeps {
  const runUrl = env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : undefined;
  let checkId: number | null = null;
  let running: ChildProcess | null = null;
  const finish = (title: string, summary: string) =>
    writeCheck(api, checkId, headSha, { status: "completed", conclusion: "neutral", completed_at: new Date().toISOString(), output: { title, summary } }, log);
  return {
    stopLogin: () => running?.kill("SIGTERM"),
    startLogin: (onOutput) =>
      new Promise((resolve, reject) => {
        const child = spawn("codex", ["login", "--device-auth"], { stdio: ["ignore", "pipe", "pipe"] });
        running = child;
        const timer = setTimeout(() => child.kill("SIGTERM"), LOGIN_TIMEOUT_MS);
        child.stdout.setEncoding("utf8").on("data", onOutput);
        child.stderr.setEncoding("utf8").on("data", onOutput);
        child.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve(code ?? 1);
        });
      }),
    showCode: async (login) => {
      await upsertSummary(api, number, connectBody(login, runUrl));
      log("Posted the link and code on the pull request. Waiting for the login.");
      // The comment is what people need. A check that can't be written shouldn't end a login that can still work.
      try {
        const run = await writeCheck(api, null, headSha, {
          status: "in_progress",
          started_at: new Date().toISOString(),
          output: { title: "Waiting for you to connect ChatGPT", summary: "Follow the link and code in the pull request's Mergelight comment." },
        }, log);
        checkId = run?.id ?? null;
      } catch (err) {
        log(`Couldn't show the waiting check: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    connected: async () => {
      await upsertSummary(api, number, pendingSummaryBody());
      let auth = "";
      try {
        auth = readFileSync(join(env.CODEX_HOME ?? "", "auth.json"), "utf8");
      } catch {
        // Without the file the note just doesn't name the account.
      }
      await api.write("POST", `issues/${number}/comments`, { body: connectedBody(connectedAccount(auth), env.SECRET_NAME || "CODEX_AUTH_JSON") });
      await finish("Connected to ChatGPT", "Starting the review.");
      log("Connected to ChatGPT.");
    },
    failed: async (reason) => {
      await upsertSummary(api, number, connectFailedBody(reason));
      await finish(CHECK_FAILED_TITLE, reason);
      log(reason);
    },
  };
}
