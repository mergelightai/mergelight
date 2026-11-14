import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderName } from "./providers/index.js";
import type { GitHub } from "./publish/api.js";
import { FAILED_MARKER, PENDING_MARKER, pendingSummaryBody, SUMMARY_MARKER } from "./publish/markdown.js";
import { CHECK_FAILED_TITLE, readPrReviewState, writeCheck } from "./publish/publish.js";
import { stateBlock } from "./publish/state.js";
import { claudeCodeRef, readCodeRef, shareClaudeToken, startClaudeSignIn, waitForPastedCode } from "./connect-claude.js";

/**
 * Connects a repository to ChatGPT from its own pull request, with no terminal.
 *
 * Codex's device login runs inside the customer's own GitHub Actions run. The link and code go in
 * a comment on their private repository, and the login stays in the runner until the Action saves
 * it as their secret. None of it passes through Mergelight.
 */

/** Codex says the code lasts 15 minutes. */
export const LOGIN_TIMEOUT_MS = 16 * 60_000;
/** How long a checker's prompt waits for Claude's code: the 15 minutes the comment promises. */
const CHECK_WAIT_MS = 15 * 60_000;

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

/** The setup page reads the link and code from this hidden line, so a change to how the comment looks can't break it. */
export function connectData(login: DeviceLogin | null, claudeUrl?: string, purpose?: "check"): string {
  // "for" is only there for a checker's login, so the page can say what it connects.
  const data = { url: login?.url ?? "", code: login?.code ?? "", claudeUrl: claudeUrl ?? null, ...(purpose ? { for: purpose } : {}) };
  return `<!-- mergelight:connect:v1 ${JSON.stringify(data).replace(/--/g, "\\u002d\\u002d")} -->`;
}

const SETUP_URL = "https://mergelight.dev/setup/";

/** Opens the setup page on the step this pull request is waiting for. */
export function claudeSetupLink(repo: string | undefined, number: number): string {
  return repo ? `${SETUP_URL}?repo=${repo}&pr=${number}&connect=claude` : SETUP_URL;
}

export function connectBody(login: DeviceLogin | null, runUrl?: string, claudeUrl?: string, setupLink = SETUP_URL): string {
  const options = [
    ...(login ? [{ name: "ChatGPT", steps: `[Open ChatGPT](${login.url}) and enter \`${login.code}\`` }] : []),
    ...(claudeUrl ? [{ name: "Claude", steps: `[Connect on mergelight.dev](${setupLink})` }] : []),
  ];
  const only = options.length === 1 ? options[0] : null;
  const run = runUrl ? `[your own GitHub Actions run](${runUrl})` : "your own GitHub Actions run";
  return [
    SUMMARY_MARKER,
    PENDING_MARKER,
    connectData(login, claudeUrl),
    `### 🔌 Connect ${only?.name ?? "your AI"} to start reviews`,
    "",
    ...(only ? [`${only.steps}. The review then starts by itself.`] : ["Pick one, and the review starts by itself.", "", ...options.map((o) => `- **${o.name}:** ${o.steps}`)]),
    "",
    "<details><summary>Something not working?</summary>",
    "",
    "- **The link or code ran out:** they last 15 minutes. Push a new commit to get new ones.",
    ...(login ? [`- **OpenAI refuses the code:** turn on "Enable device code sign-in" in your [ChatGPT security settings](${CHATGPT_SECURITY_URL}), or ask your workspace admin to.`] : []),
    "",
    "</details>",
    "",
    `<sub>Reviews use the plan of whoever connects it, so only do this if you're setting up this repository. This comes from ${run}. The login is saved as this repository's secret and never reaches Mergelight.</sub>`,
  ].join("\n");
}

/** Which sign-in a connect offers, and what for: the review, as before, or checking another AI's review. */
export interface ConnectMode {
  purpose: "review" | "check";
  /** For a check: the AI to connect. For a review: claude offers only Claude's link, when Claude must review. */
  ai?: ProviderName;
  /** For a check: the AI that reviews, and checks instead when nobody connects. */
  reviewer?: ProviderName;
}

/** The name a person signs in with: ChatGPT for Codex. */
export function loginName(ai: ProviderName): string {
  return ai === "codex" ? "ChatGPT" : "Claude";
}

/** The name of the AI that does the work. */
export function aiName(ai: ProviderName): string {
  return ai === "codex" ? "Codex" : "Claude";
}

/**
 * The comment that asks to connect the AI that checks the review. The review doesn't wait for it longer
 * than the code lasts: without it, the reviewer's own AI checks, and the summary says so.
 */
export function connectCheckBody(ai: ProviderName, reviewer: ProviderName, login: DeviceLogin | null, runUrl?: string, claudeUrl?: string, setupLink = SETUP_URL): string {
  const steps = ai === "codex" ? (login ? `[Open ChatGPT](${login.url}) and enter \`${login.code}\`` : null) : claudeUrl ? `[Connect on mergelight.dev](${setupLink})` : null;
  const run = runUrl ? `[your own GitHub Actions run](${runUrl})` : "your own GitHub Actions run";
  return [
    SUMMARY_MARKER,
    PENDING_MARKER,
    connectData(ai === "codex" ? login : null, ai === "claude" ? claudeUrl : undefined, "check"),
    `### 🔌 Connect ${loginName(ai)} to check this review`,
    "",
    `${steps ?? "Follow the steps on mergelight.dev/setup"}. ${aiName(reviewer)}'s review then starts by itself, and ${aiName(ai)} checks its findings.`,
    "",
    `If nobody connects it within 15 minutes, the review starts anyway, checked by ${aiName(reviewer)}.`,
    "",
    "<details><summary>Something not working?</summary>",
    "",
    `- **The ${ai === "codex" ? "code" : "link"} ran out:** it lasts 15 minutes. Push a new commit to get a new one.`,
    ...(ai === "codex" ? [`- **OpenAI refuses the code:** turn on "Enable device code sign-in" in your [ChatGPT security settings](${CHATGPT_SECURITY_URL}), or ask your workspace admin to.`] : []),
    "",
    "</details>",
    "",
    `<sub>Checks use the plan of whoever connects it, so only do this if you're setting up this repository. This comes from ${run}. The login is saved as this repository's secret and never reaches Mergelight.</sub>`,
  ].join("\n");
}

/** The waiting check's title while the checker's login is asked for. */
export function checkWaitingTitle(ai: ProviderName): string {
  return `Waiting for you to connect ${loginName(ai)} to check the review`;
}

export function installAppBody(login = "ChatGPT"): string {
  return [
    SUMMARY_MARKER,
    PENDING_MARKER,
    "### 🔌 One step left: install the Mergelight AI app",
    "",
    `[Install it on this repository](${INSTALL_URL}), or approve its updated permissions if it's already installed, then push a new commit. The app saves your ${login} login, so you only connect once.`,
  ].join("\n");
}

export function connectFailedBody(reason: string, claudeOffered = false, onlyClaude = false): string {
  if (onlyClaude) {
    return [SUMMARY_MARKER, FAILED_MARKER, "### ⚠️ Mergelight couldn't connect to Claude", "", reason, "", "Push a new commit to get a new link. You can also use an Anthropic API key instead: https://mergelight.dev/setup"].join("\n");
  }
  return [
    SUMMARY_MARKER,
    FAILED_MARKER,
    claudeOffered ? "### ⚠️ Mergelight couldn't connect your AI" : "### ⚠️ Mergelight couldn't connect to ChatGPT",
    "",
    reason,
    "",
    claudeOffered ? "Push a new commit to get a new link and code. You can also use an API key instead: https://mergelight.dev/setup" : "Push a new commit to try again. You can also use an OpenAI API key instead: https://mergelight.dev/setup",
  ].join("\n");
}

/** A second way to connect, running beside the ChatGPT one. Whichever finishes first wins. */
export interface ClaudeConnect {
  url: string;
  wait: () => Promise<boolean>;
  stop: () => void;
}

export interface ConnectDeps {
  /** Only this sign-in is offered: Claude's, with no ChatGPT code. */
  only?: "claude";
  /** Why Claude can't be offered, when there is a reason to tell, such as the workflow not passing its login on. */
  claudeUnavailable?: () => string | undefined;
  /** Why ChatGPT's code isn't offered, when there is a reason to tell, such as the workflow not passing its login on. */
  chatgptUnavailable?: () => string | undefined;
  /** Starts the Claude sign-in, when this repository can use it. Null if it can't. */
  startClaude?: () => Promise<ClaudeConnect | null>;
  /** Runs the login and resolves with its exit code. */
  startLogin: (onOutput: (text: string) => void) => Promise<number>;
  /** Ends a running login. */
  stopLogin: () => void;
  showCode: (login: DeviceLogin | null, claudeUrl?: string) => Promise<void>;
  connected: (via?: "chatgpt" | "claude") => Promise<void>;
  failed: (reason: string) => Promise<void>;
}

export async function connect(deps: ConnectDeps): Promise<number> {
  let output = "";
  let shown = false;
  let notPosted = false;
  let showing: Promise<void> = Promise.resolve();
  // First, so its link is in the comment that shows the ChatGPT code.
  const claude = deps.startClaude ? await deps.startClaude().catch(() => null) : null;
  const show = (login: DeviceLogin | null) => {
    shown = true;
    // Nobody can finish a login whose code never reached the pull request, so don't wait for it.
    showing = deps.showCode(login, claude?.url).catch(() => {
      notPosted = true;
      deps.stopLogin();
      claude?.stop();
    });
  };
  const codexLogin = deps.startLogin((text) => {
    output += text;
    if (shown) return;
    const login = parseDeviceLogin(output);
    if (login) show(login);
  });
  const claudeWait = claude ? claude.wait().catch(() => false) : Promise.resolve(false);
  const winner = await new Promise<"chatgpt" | "claude" | number>((resolve, reject) => {
    let code: number | null = null;
    let claudeOver = !claude;
    codexLogin.then((exit) => {
      code = exit;
      if (exit === 0) resolve("chatgpt");
      else if (claudeOver || notPosted) resolve(exit);
      // ChatGPT's device sign-in can be switched off. Claude's link still has to reach the pull request.
      else if (!shown) show(null);
    }, reject);
    claudeWait.then((ok) => {
      claudeOver = true;
      if (ok) resolve("claude");
      else if (code !== null) resolve(code);
    });
  });
  await showing;
  if (winner === "claude") deps.stopLogin();
  else claude?.stop();
  if (notPosted) {
    await deps.failed("Mergelight couldn't post the login code on this pull request, because GitHub refused or didn't answer.");
    return 1;
  }
  if (winner === "chatgpt" || winner === "claude") {
    await deps.connected(winner);
    return 0;
  }
  await deps.failed(
    deps.only === "claude"
      ? claude
        ? "The Claude link ran out before anyone finished signing in."
        : (deps.claudeUnavailable?.() ?? "Claude's sign-in couldn't start on this run.")
      : claude
      ? "The ChatGPT code and the Claude link both ran out before anyone finished signing in."
      : !shown && deps.chatgptUnavailable?.()
      ? deps.chatgptUnavailable()!
      : shown
      ? `The code ran out, or OpenAI refused it. Check that "Enable device code sign-in" is on in your [ChatGPT security settings](${CHATGPT_SECURITY_URL}).`
      : `Codex couldn't start a device login. "Enable device code sign-in" may be off in your [ChatGPT security settings](${CHATGPT_SECURITY_URL}), or for your workspace.`,
  );
  return 1;
}

/** Tells the pull request the app has to be installed first. There's nowhere to save a login without it. */
export async function askForApp(api: GitHub, number: number, headSha: string, login = "ChatGPT"): Promise<void> {
  await upsertSummary(api, number, installAppBody(login));
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
/**
 * Whether the workflow passes a Claude login on to Mergelight. A repository set up before Claude support
 * doesn't, so connecting Claude there would only ask again next time: "no". A workflow that calls a
 * reusable one may pass it on in a file this can't tell, and one that can't be read can't say: "unknown".
 */
export function claudeInWorkflow(text: string | null, input = "claude-code-oauth-token", job?: string, secret?: string): "yes" | "no" | "unknown" {
  if (text === null) return "unknown";
  // Lines that are code, not comments: a line commented out passes nothing on.
  let lines = text.split("\n").map((line) => line.replace(/(^|\s)#.*$/, ""));
  const indent = (line: string) => line.match(/^\s*/)![0].length;
  // Only this run's job: an input another job passes on doesn't reach this one.
  if (job) {
    const at = lines.findIndex((line) => new RegExp(`^\\s+["']?${job.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?\\s*:\\s*$`).test(line));
    if (at >= 0) {
      let end = at + 1;
      while (end < lines.length && (!lines[end]!.trim() || indent(lines[end]!) > indent(lines[at]!))) end++;
      lines = lines.slice(at, end);
    }
  }
  // Each step that uses Mergelight itself, or a fork of it (a repository named mergelight), from its "-" on.
  const steps: string[] = [];
  lines.forEach((line, i) => {
    if (!/^\s*(?:-\s*)?uses:\s*["']?[^\s"'/]+\/mergelight@/i.test(line)) return;
    let start = i;
    while (start > 0 && !/^\s*-\s/.test(lines[start]!)) start--;
    const dash = indent(lines[start]!);
    let end = start + 1;
    while (end < lines.length && (!lines[end]!.trim() || indent(lines[end]!) > dash)) end++;
    const step = lines.slice(start, end).join("\n");
    // A step that runs only when someone approves needs no AI login: it only turns the check green.
    if (/^\s*(?:-\s*)?if:[^\n]*==\s*["']pull_request_review["']/m.test(step) && !/pull_request["']/.test(step.replace(/pull_request_review["']/g, ""))) return;
    steps.push(step);
  });
  // A reusable workflow or a composite action of the team's own may pass the login on in a file this
  // can't see: unless Mergelight is used here in plain sight, it can't say. Nor through YAML's shared
  // parts (an alias like *inputs, or a << merge), which this doesn't follow.
  if (!steps.length || steps.some((step) => /(^|[\s:{,\[])\*[\w-]+|<<\s*:/m.test(step))) return "unknown";
  // The name may be quoted, or in a flow mapping, as YAML allows. Every Mergelight step of this job must
  // pass it on: which one runs now can't be told from here, and a login saved for a step that doesn't
  // pass it on would replace the one another step uses. The message then says what to add.
  // And from the secret the login is saved to: a login saved as CLAUDE_CODE_OAUTH_TOKEN never reaches
  // a step that reads another secret.
  const passes = (step: string) => {
    const value = new RegExp(`(?:^|[\\s{,])["']?${input}["']?\\s*:\\s*([^\\n,}]*)`, "m").exec(step)?.[1];
    if (value === undefined) return false;
    const named = /secrets\.([A-Za-z0-9_]+)/.exec(value)?.[1];
    return !secret || !named || named === secret;
  };
  return steps.every(passes) ? "yes" : "no";
}

async function workflowHasClaude(api: GitHub, env: NodeJS.ProcessEnv, input = "claude-code-oauth-token", secret = "CLAUDE_CODE_OAUTH_TOKEN"): Promise<"yes" | "no" | "unknown"> {
  const [, path, ref] = (env.GITHUB_WORKFLOW_REF ?? "").match(/^[^/]+\/[^/]+\/(.+?)@(.+)$/) ?? [];
  if (!path || !ref) return "unknown";
  const text = await api.get<{ content: string }>(`contents/${path}?ref=${encodeURIComponent(env.GITHUB_SHA ?? ref)}`).then((f) => Buffer.from(f.content, "base64").toString("utf8"), () => null);
  return claudeInWorkflow(text, input, env.GITHUB_JOB, secret);
}

/** The same for a ChatGPT login: a workflow that doesn't pass codex-auth-json would never see one saved now. */
export function chatgptInputMissing(secret = "CODEX_AUTH_JSON"): string {
  return `The workflow doesn't pass a ChatGPT login to Mergelight, so one connected now would never reach a later run. Add \`codex-auth-json: \${{ secrets.${secret} }}\` under \`with:\` where the workflow uses Mergelight, then push a commit.`;
}

/** What to do when the workflow doesn't pass a Claude login on: a login saved now would never reach a later run. */
export const CLAUDE_INPUT_MISSING =
  "The workflow doesn't pass a Claude login to Mergelight, so one connected now would never reach a later run. Add `claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}` under `with:` where the workflow uses Mergelight, then push a commit.";

export function githubConnect(api: GitHub, number: number, headSha: string, log: (line: string) => void, env = process.env, mode: ConnectMode = { purpose: "review" }): ConnectDeps {
  const checker = mode.purpose === "check" && mode.ai ? mode.ai : null;
  const reviewer = mode.reviewer ?? (checker === "codex" ? "claude" : "codex");
  // Claude's link alone: Claude checks, or Claude must review and has no login yet.
  const onlyClaude = mode.ai === "claude";
  const runUrl = env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : undefined;
  let checkId: number | null = null;
  let running: ChildProcess | null = null;
  let claudeOffered = false;
  /** Whether the prompt reached the pull request: only then is there a prompt to replace. */
  let prompted = false;
  /** Why Claude isn't offered, when the workflow is the reason. */
  let claudeMissing: string | undefined;
  let chatgptMissing: string | undefined;
  /**
   * The app's token dies if the app is removed during the login, which can wait 15 minutes. The comment
   * still has to change, or it keeps offering a dead code, and the workflow's own token can do that.
   */
  const updateSummary = async (body: string) => {
    try {
      await upsertSummary(api, number, body);
    } catch (err) {
      const fallback = env.GITHUB_WORKFLOW_TOKEN;
      if (!fallback || fallback === env.GH_TOKEN || !/Bad credentials|HTTP 401/i.test(err instanceof Error ? err.message : String(err))) throw err;
      log("GitHub refused the app's token, so this updates the comment with the workflow's token.");
      env.GH_TOKEN = fallback;
      await upsertSummary(api, number, body);
    }
  };
  const finish = (title: string, summary: string) =>
    writeCheck(api, checkId, headSha, { status: "completed", conclusion: "neutral", completed_at: new Date().toISOString(), output: { title, summary } }, log);
  /**
   * Connected: the check stays going and the review carries it on. A check finished now would stand
   * neutral until the review starts, and a branch rule takes neutral for passed.
   */
  const handOn = async (title: string, summary: string) => {
    if (!checkId) return;
    await writeCheck(api, checkId, headSha, { status: "in_progress", output: { title, summary } }, log);
    if (env.GITHUB_ENV) appendFileSync(env.GITHUB_ENV, `MERGELIGHT_CHECK_RUN=${checkId}\n`);
  };
  return {
    ...(onlyClaude ? { only: "claude" as const } : {}),
    claudeUnavailable: () => claudeMissing,
    chatgptUnavailable: () => chatgptMissing,
    stopLogin: () => running?.kill("SIGTERM"),
    startClaude: async () => {
      // Connecting ChatGPT to check a Claude review offers only ChatGPT: Claude already has a login.
      if (checker === "codex") return null;
      // Claude is offered only where the workflow passes its login on. Beside ChatGPT, only when that is
      // sure. Asked for by name, also when a reusable workflow may pass it on where this can't see.
      const passes = await workflowHasClaude(api, env);
      if (passes === "no") {
        claudeMissing = CLAUDE_INPUT_MISSING;
        return null;
      }
      if (!onlyClaude && passes !== "yes") return null;
      const signIn = await startClaudeSignIn();
      if (!signIn) {
        log("Claude's sign-in didn't start, so only ChatGPT is offered.");
        return null;
      }
      const ref = claudeCodeRef(signIn.url);
      if (!ref) {
        log("Claude's sign-in link wasn't the expected shape, so only ChatGPT is offered.");
        signIn.stop();
        return null;
      }
      claudeOffered = true;
      let over = false;
      return {
        url: signIn.url,
        stop: () => {
          over = true;
          signIn.stop();
        },
        wait: async () => {
          // As long as the comment says: a checker's prompt promises the review starts after 15 minutes.
          const code = await waitForPastedCode({ read: () => readCodeRef((path) => api.get(path), ref), stopped: () => over }, checker ? CHECK_WAIT_MS : undefined);
          if (!code) return false;
          const token = await signIn.finish(code);
          if (!token) {
            log("Claude didn't accept that code.");
            return false;
          }
          shareClaudeToken(token, env, console.log, !checker);
          return true;
        },
      };
    },
    startLogin: async (onOutput) => {
      // Connecting Claude alone starts no ChatGPT sign-in.
      if (onlyClaude) return 1;
      // A checker's ChatGPT login is asked for only where the workflow passes it on to later runs.
      if (checker === "codex" && (await workflowHasClaude(api, env, "codex-auth-json", env.SECRET_NAME || "CODEX_AUTH_JSON")) === "no") {
        chatgptMissing = chatgptInputMissing(env.SECRET_NAME || "CODEX_AUTH_JSON");
        return 1;
      }
      return new Promise<number>((resolve, reject) => {
        const child = spawn("codex", ["login", "--device-auth"], { stdio: ["ignore", "pipe", "pipe"] });
        running = child;
        // A checker's prompt promises the review starts after 15 minutes.
        const timer = setTimeout(() => child.kill("SIGTERM"), checker ? CHECK_WAIT_MS : LOGIN_TIMEOUT_MS);
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
      });
    },
    showCode: async (login, claudeUrl) => {
      const setupLink = claudeSetupLink(env.GITHUB_REPOSITORY, number);
      prompted = true;
      await upsertSummary(api, number, checker ? connectCheckBody(checker, reviewer, login, runUrl, claudeUrl, setupLink) : connectBody(login, runUrl, claudeUrl, setupLink));
      log("Posted the link and code on the pull request. Waiting for the login.");
      // The comment is what people need. A check that can't be written shouldn't end a login that can still work.
      try {
        const run = await writeCheck(api, null, headSha, {
          status: "in_progress",
          started_at: new Date().toISOString(),
          output: checker
            ? { title: checkWaitingTitle(checker), summary: `Follow the steps in the pull request's Mergelight comment. Without it, the review starts in 15 minutes, checked by ${aiName(reviewer)}.` }
            : { title: onlyClaude ? "Waiting for you to connect Claude" : claudeUrl ? "Waiting for you to connect your AI" : "Waiting for you to connect ChatGPT", summary: "Follow the steps in the pull request's Mergelight comment." },
        }, log);
        checkId = run?.id ?? null;
      } catch (err) {
        log(`Couldn't show the waiting check: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    connected: async (via = "chatgpt") => {
      // A comment that can't be updated mustn't leave the check waiting.
      await updateSummary(pendingSummaryBody()).catch((err) => log(`Couldn't update the comment: ${err instanceof Error ? err.message : String(err)}`));
      if (checker) {
        let account: string | null = null;
        if (checker === "codex") {
          try {
            account = connectedAccount(readFileSync(join(env.CODEX_HOME ?? "", "auth.json"), "utf8"));
          } catch {
            // Without the file the note just doesn't name the account.
          }
        }
        // A ChatGPT login now, as one from the secret would be: a rejected one is then known as such, so
        // the reviewer can check instead, and the steps that refresh and save it run.
        if (checker === "codex" && env.GITHUB_ENV) appendFileSync(env.GITHUB_ENV, "MERGELIGHT_CHATGPT=1\n");
        const who = checker === "claude" ? "the Claude plan that confirmed the sign-in" : account ? `the ChatGPT account \`${account}\`` : "the ChatGPT account that entered the code";
        const secret = checker === "claude" ? "CLAUDE_CODE_OAUTH_TOKEN" : env.SECRET_NAME || "CODEX_AUTH_JSON";
        // The note failing to post mustn't leave the check waiting.
        await api
          .write("POST", `issues/${number}/comments`, { body: `🔌 ${aiName(checker)} now checks reviews on this repository, with ${who}. If that isn't yours, remove the \`${secret}\` secret and push a commit to connect again.` })
          .catch((err) => log(`Couldn't post who connected: ${err instanceof Error ? err.message : String(err)}`));
        await handOn(`Connected to ${loginName(checker)}`, `Starting the review, checked by ${aiName(checker)}.`);
        log(`Connected to ${loginName(checker)} to check the review.`);
        return;
      }
      if (via === "claude") {
        await api.write("POST", `issues/${number}/comments`, { body: "🔌 Reviews on this repository now use the Claude plan that confirmed the sign-in. If that isn't yours, remove the `CLAUDE_CODE_OAUTH_TOKEN` secret and push a commit to connect again." });
        await handOn("Connected to Claude", "Starting the review.");
        log("Connected to Claude.");
        return;
      }
      let auth = "";
      try {
        auth = readFileSync(join(env.CODEX_HOME ?? "", "auth.json"), "utf8");
      } catch {
        // Without the file the note just doesn't name the account.
      }
      // A ChatGPT login now, as one from the secret would be, so a rejected one is called that.
      if (env.GITHUB_ENV) appendFileSync(env.GITHUB_ENV, "MERGELIGHT_CHATGPT=1\n");
      await api.write("POST", `issues/${number}/comments`, { body: connectedBody(connectedAccount(auth), env.SECRET_NAME || "CODEX_AUTH_JSON") });
      await handOn("Connected to ChatGPT", "Starting the review.");
      log("Connected to ChatGPT.");
    },
    failed: async (reason) => {
      // A checker that wasn't connected holds nothing up: the review starts, checked by the reviewer's AI,
      // and its summary says so. The comment it replaces is the connect one, so it is left for the review.
      if (checker) {
        // The prompt's code or link is dead now, and the review is about to start: the summary says that.
        // With no prompt posted, the last review's summary stays until this one replaces it.
        if (prompted) await updateSummary(pendingSummaryBody()).catch((err) => log(`Couldn't update the comment: ${err instanceof Error ? err.message : String(err)}`));
        // The review goes on, so the check does too: it isn't finished in between.
        await handOn(`${loginName(checker)} wasn't connected`, `${reason} The review goes on, checked by ${aiName(reviewer)}.`).catch((err) => log(`Couldn't update the check: ${err instanceof Error ? err.message : String(err)}`));
        log(`${reason} The review goes on, checked by ${aiName(reviewer)}.`);
        return;
      }
      // One failed write mustn't stop the other. Only the app that made a check can finish it.
      await updateSummary(connectFailedBody(reason, claudeOffered, onlyClaude)).catch((err) => log(`Couldn't update the comment: ${err instanceof Error ? err.message : String(err)}`));
      await finish(CHECK_FAILED_TITLE, reason).catch((err) => log(`Couldn't finish the check: ${err instanceof Error ? err.message : String(err)}`));
      log(reason);
    },
  };
}
