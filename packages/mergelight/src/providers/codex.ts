import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../run.js";
import type { ModelOptions, ModelResult } from "./index.js";

export type CodexOptions = ModelOptions;
export type CodexResult = ModelResult;

/** Codex's Linux sandbox (bubblewrap) can't start, so every command fails. */
export class SandboxError extends Error {}

/** The ChatGPT login didn't work. Worth saying plainly, because re-running usually fixes it. */
export class LoginError extends Error {}

/** What Codex says when a login is refused or can't be refreshed. */
const LOGIN_FAILURE = /access token could not be refreshed|401 Unauthorized/i;

export function loginFailureMessage(secretName = "CODEX_AUTH_JSON"): string {
  return `The ChatGPT login didn't work, most likely because another run already refreshed it. Re-run the Mergelight job from the Actions tab, or push again, to pick up the new one. If it fails again, the login has stopped working: delete the ${secretName} secret, then push, and this pull request shows a code to connect ChatGPT again.`;
}

const SANDBOX_FAILURE = /bwrap:|user namespace|new namespace|RTM_NEWADDR|uid map|sandbox.*(denied|not permitted)/i;

function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

function readUserConfig(): string {
  try {
    return readFileSync(join(codexHome(), "config.toml"), "utf8");
  } catch {
    return "";
  }
}

/** The model from the user's Codex config, for display only. */
export function configuredModel(config = readUserConfig()): string | null {
  const top = config.split(/^\[/m)[0] ?? "";
  return top.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1] ?? null;
}

/** Names of MCP servers in the user's Codex config, so they can be switched off for reviews. */
function mcpServers(config: string): string[] {
  const names = new Set<string>();
  for (const m of config.matchAll(/^\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\]\s*$/gm)) {
    const name = m[1] ?? m[2];
    if (name && !name.includes(".")) names.add(name);
  }
  return [...names];
}

/**
 * Commands Codex runs can read the whole disk but not write or reach the network. Code under review can try to
 * steer them, so the folder with the login is taken out of what they can read. Codex itself still reads it.
 */
export function sandboxArgs(home = codexHome()): string[] {
  return ["-c", 'default_permissions="mergelight_review"', "-c", `permissions.mergelight_review.filesystem={":root"="read",${JSON.stringify(home)}="none"}`];
}

/** Tokens the runner holds that a reviewing agent has no use for. It only needs its own login. */
const HIDDEN_ENV = new Set(["GH_TOKEN", "GITHUB_TOKEN", "SECRETS_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_RUNTIME_TOKEN", "ACTIONS_RESULTS_URL", "ACTIONS_CACHE_URL"]);

export function agentEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !HIDDEN_ENV.has(name)));
}

/** Codex also has no use for a Claude login. */
export function codexEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { CLAUDE_CODE_OAUTH_TOKEN: _token, ANTHROPIC_API_KEY: _key, ...rest } = agentEnv(env);
  return rest;
}

const JWT = /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]+/g;
const ANTHROPIC_SECRET = /\bsk-ant-[\w-]{20,}/g;

/** Takes login tokens out of text that's about to be posted, in case one got past the sandbox. */
export function scrubSecrets(text: string, home = codexHome(), env: NodeJS.ProcessEnv = process.env): string {
  let secrets: string[] = [];
  try {
    const { tokens, OPENAI_API_KEY: key } = JSON.parse(readFileSync(join(home, "auth.json"), "utf8")) as { tokens?: Record<string, unknown>; OPENAI_API_KEY?: unknown };
    secrets = [...Object.values(tokens ?? {}), key].filter((v): v is string => typeof v === "string" && v.length >= 20);
  } catch {
    // No login file to compare with. The pattern below still applies.
  }
  secrets.push(...[env.CLAUDE_CODE_OAUTH_TOKEN, env.ANTHROPIC_API_KEY].filter((v): v is string => typeof v === "string" && v.length >= 20));
  return secrets.reduce((out, secret) => out.split(secret).join("[removed]"), text).replace(JWT, "[removed]").replace(ANTHROPIC_SECRET, "[removed]");
}

/**
 * Runs the user's own logged-in Codex CLI, headless, in a sandbox that can read but not write or reach the network.
 * Plugins, MCP servers, hooks and notifications are switched off for the run,
 * so code in a pull request can't steer the reviewer into the user's other tools.
 * Everything else (provider, model, login) is the user's own Codex setup.
 */
export async function runCodex(opts: CodexOptions): Promise<CodexResult> {
  const config = readUserConfig();
  const work = mkdtempSync(join(tmpdir(), "mergelight-codex-"));
  const schemaFile = join(work, "schema.json");
  const outFile = join(work, "output.json");
  writeFileSync(schemaFile, JSON.stringify(opts.schema));

  const args = [
    "exec",
    ...sandboxArgs(),
    "--ephemeral",
    "--skip-git-repo-check",
    "--json",
    "-C", opts.cwd,
    "--output-schema", schemaFile,
    "-o", outFile,
    ...["plugins", "apps", "hooks", "image_generation", "browser_use", "computer_use"].flatMap((f) => ["--disable", f]),
    "-c", "notify=[]",
    "-c", 'web_search="disabled"',
    ...mcpServers(config).flatMap((name) => ["-c", `mcp_servers.${name}.enabled=false`]),
  ];
  if (opts.model) args.push("-m", opts.model);
  if (opts.effort) args.push("-c", `model_reasoning_effort="${opts.effort}"`);
  args.push("-");

  let commands = 0;
  let completed = 0;
  let sandboxFailures = 0;
  let firstSandboxError = "";
  /** Codex's own errors, kept apart from its stdout, which also carries the code it reads. */
  const failures: string[] = [];
  let usage: CodexResult["usage"] = null;
  let buffer = "";
  const onStdout = (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("{")) continue;
      try {
        const event = JSON.parse(line) as {
          type?: string;
          item?: { type?: string; command?: string; exit_code?: number | null; aggregated_output?: string };
          usage?: { input_tokens?: number; output_tokens?: number };
          message?: string;
          error?: { message?: string };
        };
        if (event.type === "error" || event.type === "turn.failed") failures.push(event.message ?? event.error?.message ?? "");
        if (event.type === "item.started" && event.item?.type === "command_execution") {
          commands++;
          opts.onCommand?.(event.item.command ?? "");
        }
        if (event.type === "item.completed" && event.item?.type === "command_execution") {
          completed++;
          const output = event.item.aggregated_output ?? "";
          if (event.item.exit_code !== 0 && SANDBOX_FAILURE.test(output)) {
            sandboxFailures++;
            firstSandboxError ||= output.split("\n").find((l) => SANDBOX_FAILURE.test(l))?.trim() ?? "";
          }
        }
        if (event.type === "turn.completed" && event.usage) {
          usage = {
            input_tokens: event.usage.input_tokens ?? 0,
            output_tokens: event.usage.output_tokens ?? 0,
          };
        }
      } catch {
        /* not an event line */
      }
    }
  };

  try {
    const result = await run("codex", args, {
      input: opts.prompt,
      timeoutMs: opts.timeoutMs ?? 25 * 60_000,
      onStdout,
      env: codexEnv(),
    });
    if (opts.logFile) {
      mkdirSync(join(opts.logFile, ".."), { recursive: true });
      writeFileSync(opts.logFile, `${result.stdout}\n--- stderr ---\n${result.stderr}`);
    }
    if (result.code !== 0) {
      const tail = scrubSecrets((result.stderr || result.stdout).trim().split("\n").slice(-6).join("\n"));
      // Only a ChatGPT login: a refused API key has a different fix.
      if (process.env.MERGELIGHT_CHATGPT === "1" && LOGIN_FAILURE.test(`${result.stderr}\n${failures.join("\n")}`)) {
        throw new LoginError(loginFailureMessage(process.env.SECRET_NAME || undefined));
      }
      throw new Error(`Codex exited with code ${result.code}.${opts.logFile ? ` Log: ${opts.logFile}` : ""}\n${tail}`);
    }
    // Without a working sandbox Codex can't read the code and reviews the diff blind.
    // Better to fail loudly than to post a review that only looks at the diff.
    if (completed > 0 && sandboxFailures === completed) {
      throw new SandboxError(
        `Codex couldn't run commands in its sandbox on this machine, so it can't read the code (${scrubSecrets(firstSandboxError) || "every command failed"}). On Linux this usually means unprivileged user namespaces are blocked; see docs/github-action.md.`,
      );
    }
    let raw: string;
    try {
      raw = readFileSync(outFile, "utf8");
    } catch {
      throw new Error(`Codex finished without a final answer.${opts.logFile ? ` Log: ${opts.logFile}` : ""}`);
    }
    return {
      output: JSON.parse(scrubSecrets(raw)),
      model: opts.model ?? configuredModel(config),
      commands,
      usage,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
