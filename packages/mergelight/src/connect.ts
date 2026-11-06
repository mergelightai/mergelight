import { spawn } from "node:child_process";
import type { GitHub } from "./publish/api.js";
import { PENDING_MARKER, pendingSummaryBody, SUMMARY_MARKER } from "./publish/markdown.js";
import { CHECK_FAILED_TITLE, readPrReviewState, writeCheck } from "./publish/publish.js";

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

export interface DeviceLogin {
  url: string;
  code: string;
}

/** Reads the link and code from what `codex login --device-auth` prints. Only OpenAI's own link counts. */
export function parseDeviceLogin(output: string): DeviceLogin | null {
  const clean = output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  const url = clean.match(/https:\/\/auth\.openai\.com\/\S+/)?.[0];
  const code = clean.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,}\b/)?.[0];
  return url && code ? { url, code } : null;
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
    "**If OpenAI refuses the code:** turn on device code login in your ChatGPT security settings, or ask your workspace admin to.",
    "",
    `<sub>Reviews use the plan of the account you connect. This code comes from ${runUrl ? `[your own GitHub Actions run](${runUrl})` : "your own GitHub Actions run"}. The login is saved as this repository's secret and is never sent to Mergelight.</sub>`,
  ].join("\n");
}

export function installAppBody(): string {
  return [
    SUMMARY_MARKER,
    PENDING_MARKER,
    "### 🔌 One step left: install the Mergelight AI app",
    "",
    `[Install it on this repository](${INSTALL_URL}), then push a new commit. The app saves your ChatGPT login, so you only connect once.`,
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
  showCode: (login: DeviceLogin) => Promise<void>;
  connected: () => Promise<void>;
  failed: (reason: string) => Promise<void>;
}

export async function connect(deps: ConnectDeps): Promise<number> {
  let output = "";
  let shown = false;
  let showing: Promise<void> = Promise.resolve();
  const code = await deps.startLogin((text) => {
    output += text;
    if (shown) return;
    const login = parseDeviceLogin(output);
    if (login) {
      shown = true;
      showing = deps.showCode(login);
    }
  });
  await showing;
  if (code === 0) {
    await deps.connected();
    return 0;
  }
  await deps.failed(
    shown
      ? "The code ran out, or OpenAI refused it. Check that device code login is on in your ChatGPT security settings."
      : "Codex couldn't start a device login. Device code login may be turned off for this account or workspace.",
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

async function upsertSummary(api: GitHub, number: number, body: string): Promise<void> {
  const { summary } = await readPrReviewState(api, number);
  if (summary) await api.write("PATCH", `issues/comments/${summary.id}`, { body });
  else await api.write("POST", `issues/${number}/comments`, { body });
}

/** The real thing: Codex on this runner, and the pull request as the place to show the code. */
export function githubConnect(api: GitHub, number: number, headSha: string, log: (line: string) => void, env = process.env): ConnectDeps {
  const runUrl = env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : undefined;
  let checkId: number | null = null;
  const finish = (title: string, summary: string) =>
    writeCheck(api, checkId, headSha, { status: "completed", conclusion: "neutral", completed_at: new Date().toISOString(), output: { title, summary } }, log);
  return {
    startLogin: (onOutput) =>
      new Promise((resolve, reject) => {
        const child = spawn("codex", ["login", "--device-auth"], { stdio: ["ignore", "pipe", "pipe"] });
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
      const run = await writeCheck(api, null, headSha, {
        status: "in_progress",
        started_at: new Date().toISOString(),
        output: { title: "Waiting for you to connect ChatGPT", summary: "Follow the link and code in the pull request's Mergelight comment." },
      }, log);
      checkId = run?.id ?? null;
      log("Posted the link and code on the pull request. Waiting for the login.");
    },
    connected: async () => {
      await upsertSummary(api, number, pendingSummaryBody());
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
