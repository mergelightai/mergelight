import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../run.js";
import { agentEnv, LoginError, scrubSecrets } from "./codex.js";
import type { ModelOptions, ModelResult } from "./index.js";

/** Claude Code's file tools. No shell: the diff is in the prompt and the checkout can be read file by file. */
const TOOLS = "Read,Grep,Glob";

interface ClaudeResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  num_turns?: number;
  modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }>;
}

const LOGIN_FAILURE = /invalid api key|please run \/login|authentication_error|invalid bearer|oauth token|not logged in/i;

export function claudeLoginMessage(): string {
  return 'The Claude login didn\'t work. Run "claude setup-token" on your computer, save the result as the CLAUDE_CODE_OAUTH_TOKEN secret, then push a commit. With an API key, check the ANTHROPIC_API_KEY secret.';
}

/** The login for Claude Code. An empty secret isn't a login, and a plan is used before an API key that bills per use. */
export function claudeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = agentEnv(env);
  for (const name of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]) if (!out[name]) delete out[name];
  if (out.CLAUDE_CODE_OAUTH_TOKEN) delete out.ANTHROPIC_API_KEY;
  return out;
}

/** True when the Claude Code CLI is installed. Login is checked by the run itself. */
export async function claudeAvailable(): Promise<boolean> {
  try {
    return (await run("claude", ["--version"], { timeoutMs: 15_000 })).code === 0;
  } catch {
    return false;
  }
}

/**
 * Runs the user's own logged-in Claude Code CLI, headless.
 * Only Read, Grep and Glob are available, confined to the checkout (--restricted).
 * Plugins, hooks, MCP servers, skills and CLAUDE.md auto-loading are off (--safe-mode),
 * and anything that would ask for permission is denied. Login and plan are the user's own.
 */
export async function runClaude(opts: ModelOptions): Promise<ModelResult> {
  const args = [
    "-p",
    "--output-format", "json",
    "--json-schema", JSON.stringify(opts.schema),
    "--tools", TOOLS,
    "--restricted",
    "--safe-mode",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--permission-prompts", "none",
    "--model", opts.model ?? "opus",
  ];
  if (opts.effort) args.push("--effort", opts.effort);

  const result = await run("claude", args, {
    cwd: opts.cwd,
    input: opts.prompt,
    timeoutMs: opts.timeoutMs ?? 25 * 60_000,
    env: claudeEnv(),
  });
  const checkLogin = (text: string) => {
    if (process.env.MERGELIGHT_PROVIDER === "claude" && LOGIN_FAILURE.test(text)) throw new LoginError(claudeLoginMessage());
  };
  if (opts.logFile) {
    mkdirSync(join(opts.logFile, ".."), { recursive: true });
    writeFileSync(opts.logFile, `${result.stdout}\n--- stderr ---\n${result.stderr}`);
  }

  let parsed: ClaudeResult;
  try {
    parsed = JSON.parse(result.stdout) as ClaudeResult;
  } catch {
    const tail = scrubSecrets((result.stderr || result.stdout).trim().split("\n").slice(-6).join("\n"));
    checkLogin(`${result.stderr}\n${result.stdout}`);
    throw new Error(`Claude exited with code ${result.code} without a result.${opts.logFile ? ` Log: ${opts.logFile}` : ""}\n${tail}`);
  }
  if (parsed.is_error || parsed.subtype !== "success" || parsed.structured_output === undefined) {
    const said = parsed.result ?? "";
    checkLogin(`${result.stderr}\n${said}`);
    // Claude calls a refused request a "success" with is_error set, so its status word can't go in the message.
    const how = parsed.is_error ? "an error" : parsed.subtype === "success" ? "no structured answer" : (parsed.subtype ?? "no result");
    const why = /\blimit\b/i.test(said) ? "Your Claude plan hit its usage limit." : `Claude didn't finish (${how}).`;
    throw new Error(`${why}${opts.logFile ? ` Log: ${opts.logFile}` : ""}\n${scrubSecrets(said.slice(0, 400))}`);
  }

  // The served model is the one that wrote the most; small helper models may show up too.
  const usage = Object.entries(parsed.modelUsage ?? {});
  const main = usage.sort((a, b) => (b[1].outputTokens ?? 0) - (a[1].outputTokens ?? 0))[0];
  const sum = (k: "inputTokens" | "outputTokens" | "cacheReadInputTokens" | "cacheCreationInputTokens") =>
    usage.reduce((n, [, u]) => n + (u[k] ?? 0), 0);
  return {
    output: JSON.parse(scrubSecrets(JSON.stringify(parsed.structured_output))),
    model: main?.[0] ?? opts.model ?? null,
    commands: parsed.num_turns ?? 0,
    usage: {
      input_tokens: sum("inputTokens") + sum("cacheReadInputTokens") + sum("cacheCreationInputTokens"),
      output_tokens: sum("outputTokens"),
    },
    cost_usd: parsed.total_cost_usd ?? null,
  };
}
