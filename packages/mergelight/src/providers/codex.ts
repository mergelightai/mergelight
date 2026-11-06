import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../run.js";
import type { ModelOptions, ModelResult } from "./index.js";

export type CodexOptions = ModelOptions;
export type CodexResult = ModelResult;

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
 * Runs the user's own logged-in Codex CLI, headless, in a read-only sandbox.
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
    "--sandbox", "read-only",
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
          item?: { type?: string; command?: string };
          usage?: { input_tokens?: number; output_tokens?: number };
        };
        if (event.type === "item.started" && event.item?.type === "command_execution") {
          commands++;
          opts.onCommand?.(event.item.command ?? "");
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
    });
    if (opts.logFile) {
      mkdirSync(join(opts.logFile, ".."), { recursive: true });
      writeFileSync(opts.logFile, `${result.stdout}\n--- stderr ---\n${result.stderr}`);
    }
    if (result.code !== 0) {
      const tail = (result.stderr || result.stdout).trim().split("\n").slice(-6).join("\n");
      throw new Error(`Codex exited with code ${result.code}.${opts.logFile ? ` Log: ${opts.logFile}` : ""}\n${tail}`);
    }
    let raw: string;
    try {
      raw = readFileSync(outFile, "utf8");
    } catch {
      throw new Error(`Codex finished without a final answer.${opts.logFile ? ` Log: ${opts.logFile}` : ""}`);
    }
    return {
      output: JSON.parse(raw),
      model: opts.model ?? configuredModel(config),
      commands,
      usage,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
