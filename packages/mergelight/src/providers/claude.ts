import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../run.js";
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
  });
  if (opts.logFile) {
    mkdirSync(join(opts.logFile, ".."), { recursive: true });
    writeFileSync(opts.logFile, `${result.stdout}\n--- stderr ---\n${result.stderr}`);
  }

  let parsed: ClaudeResult;
  try {
    parsed = JSON.parse(result.stdout) as ClaudeResult;
  } catch {
    const tail = (result.stderr || result.stdout).trim().split("\n").slice(-6).join("\n");
    throw new Error(`Claude exited with code ${result.code} without a result.${opts.logFile ? ` Log: ${opts.logFile}` : ""}\n${tail}`);
  }
  if (parsed.is_error || parsed.subtype !== "success" || parsed.structured_output === undefined) {
    throw new Error(
      `Claude didn't finish (${parsed.subtype ?? "no result"}).${opts.logFile ? ` Log: ${opts.logFile}` : ""}\n${(parsed.result ?? "").slice(0, 400)}`,
    );
  }

  // The served model is the one that wrote the most; small helper models may show up too.
  const usage = Object.entries(parsed.modelUsage ?? {});
  const main = usage.sort((a, b) => (b[1].outputTokens ?? 0) - (a[1].outputTokens ?? 0))[0];
  const sum = (k: "inputTokens" | "outputTokens" | "cacheReadInputTokens" | "cacheCreationInputTokens") =>
    usage.reduce((n, [, u]) => n + (u[k] ?? 0), 0);
  return {
    output: parsed.structured_output,
    model: main?.[0] ?? opts.model ?? null,
    commands: parsed.num_turns ?? 0,
    usage: {
      input_tokens: sum("inputTokens") + sum("cacheReadInputTokens") + sum("cacheCreationInputTokens"),
      output_tokens: sum("outputTokens"),
    },
    cost_usd: parsed.total_cost_usd ?? null,
  };
}
