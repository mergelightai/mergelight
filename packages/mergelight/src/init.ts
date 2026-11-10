import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./run.js";

/**
 * Adds Mergelight to the coding agents on this computer: the MCP server that reads findings, and the skill
 * that says what to do with them. It only writes where each agent keeps its own settings, and running it
 * again replaces what it added before.
 */
export interface InitDeps {
  home: string;
  /** This program's own file, to tell an installed copy from a clone. */
  cliPath: string;
  /** The skill folder that ships with this program. */
  skillDir: string;
  run: (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  log: (line: string) => void;
}

const DOCS = "https://github.com/mergelightai/mergelight/blob/main/docs/agents.md";
/** The name on npm. Plain "mergelight" was refused there for being too close to an older package. */
const PACKAGE = "@mergelight/cli";

/** An installed copy starts through npx, so it keeps working when the package moves. A clone runs its own file. */
export function serverCommand(cliPath: string): { command: string; args: string[] } {
  return /[\\/]node_modules[\\/]@mergelight[\\/]cli[\\/]/.test(cliPath) ? { command: "npx", args: ["-y", PACKAGE, "mcp"] } : { command: "node", args: [cliPath, "mcp"] };
}

async function has(deps: InitDeps, cmd: string): Promise<boolean> {
  try {
    return (await deps.run(cmd, ["--version"])).code === 0;
  } catch {
    return false;
  }
}

function addSkill(deps: InitDeps, skills: string): void {
  mkdirSync(skills, { recursive: true });
  cpSync(deps.skillDir, join(skills, "mergelight"), { recursive: true });
}

const why = (r: { stdout: string; stderr: string }) => (r.stderr || r.stdout).trim().split("\n").at(-1)?.slice(0, 200) ?? "no reason given";

export async function init(deps: InitDeps): Promise<number> {
  const server = serverCommand(deps.cliPath);
  let added = 0;

  if (await has(deps, "claude")) {
    // Claude Code refuses a name that's already there, so the old entry goes first.
    await deps.run("claude", ["mcp", "remove", "--scope", "user", "mergelight"]).catch(() => undefined);
    const r = await deps.run("claude", ["mcp", "add", "--scope", "user", "mergelight", "--", server.command, ...server.args]);
    if (r.code === 0) {
      addSkill(deps, join(deps.home, ".claude", "skills"));
      deps.log("✓ MCP server and skill added for Claude Code");
      added++;
    } else deps.log(`Claude Code: couldn't add the MCP server (${why(r)})`);
  }

  if (await has(deps, "codex")) {
    const r = await deps.run("codex", ["mcp", "add", "mergelight", "--", server.command, ...server.args]);
    if (r.code === 0) {
      addSkill(deps, join(deps.home, ".agents", "skills"));
      deps.log("✓ MCP server and skill added for Codex");
      added++;
    } else deps.log(`Codex: couldn't add the MCP server (${why(r)})`);
  }

  const cursor = join(deps.home, ".cursor");
  if (existsSync(cursor)) {
    const file = join(cursor, "mcp.json");
    let config: { mcpServers?: Record<string, unknown> } | null = {};
    if (existsSync(file)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
        config = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as { mcpServers?: Record<string, unknown> }) : null;
      } catch {
        config = null;
      }
    }
    if (config) {
      const servers = config.mcpServers && typeof config.mcpServers === "object" ? config.mcpServers : {};
      writeFileSync(file, `${JSON.stringify({ ...config, mcpServers: { ...servers, mergelight: { type: "stdio", ...server } } }, null, 2)}\n`);
      addSkill(deps, join(cursor, "skills"));
      deps.log("✓ MCP server and skill added for Cursor");
      added++;
    } else deps.log(`Cursor: ${file} isn't valid JSON, so it's left as it is. To add Mergelight by hand, see ${DOCS}`);
  }

  if (!added) {
    deps.log(`No coding agent was set up. Mergelight looks for Claude Code, Codex and Cursor. To add it by hand, see ${DOCS}`);
    return 1;
  }
  if (!(await has(deps, "gh"))) deps.log("The server reads pull requests with the GitHub CLI. Install it from https://cli.github.com and run: gh auth login");
  deps.log('Now ask your agent: "Handle the Mergelight findings on this PR."');
  return 0;
}

export function realInitDeps(): InitDeps {
  const here = dirname(fileURLToPath(import.meta.url));
  return {
    home: homedir(),
    cliPath: join(here, "cli.js"),
    skillDir: join(here, "..", "skills", "mergelight"),
    run: (cmd, args) => run(cmd, args, { timeoutMs: 60_000 }),
    log: (line) => console.log(line),
  };
}
