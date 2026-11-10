import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { init, serverCommand } from "../dist/init.js";

const skillDir = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "mergelight");
const NPX = "/x/node_modules/@mergelight/cli/dist/cli.js";

function fake({ agents = [], cursor = false, cursorConfig, fail = [], cliPath = NPX } = {}) {
  const home = mkdtempSync(join(tmpdir(), "mergelight-init-"));
  if (cursor) mkdirSync(join(home, ".cursor"));
  if (cursorConfig !== undefined) writeFileSync(join(home, ".cursor", "mcp.json"), cursorConfig);
  const calls = [];
  const logs = [];
  return {
    home,
    calls,
    logs,
    deps: {
      home,
      cliPath,
      skillDir,
      log: (l) => logs.push(l),
      run: async (cmd, args) => {
        calls.push([cmd, ...args].join(" "));
        if (args[0] === "--version") return { code: agents.includes(cmd) ? 0 : 1, stdout: "", stderr: "" };
        if (fail.includes(cmd) && args.includes("add")) return { code: 1, stdout: "", stderr: "nope" };
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  };
}

test("an installed copy starts through npx, and a clone runs its own file", () => {
  assert.deepEqual(serverCommand(NPX), { command: "npx", args: ["-y", "@mergelight/cli", "mcp"] });
  assert.equal(serverCommand("/x/node_modules/mergelight/dist/cli.js").command, "node", "only the real package name counts as installed");
  assert.deepEqual(serverCommand("/home/me/mergelight/packages/mergelight/dist/cli.js"), { command: "node", args: ["/home/me/mergelight/packages/mergelight/dist/cli.js", "mcp"] });
});

test("adds the server and the skill to every agent it finds", async () => {
  const f = fake({ agents: ["claude", "codex", "gh"], cursor: true });
  assert.equal(await init(f.deps), 0);
  assert.ok(f.calls.includes("claude mcp remove --scope user mergelight"), "an old entry goes first, so a second run works");
  assert.ok(f.calls.includes("claude mcp add --scope user mergelight -- npx -y @mergelight/cli mcp"));
  assert.ok(f.calls.includes("codex mcp add mergelight -- npx -y @mergelight/cli mcp"));
  for (const dir of [".claude/skills", ".agents/skills", ".cursor/skills"]) assert.ok(existsSync(join(f.home, dir, "mergelight", "SKILL.md")), dir);
  const cursor = JSON.parse(readFileSync(join(f.home, ".cursor", "mcp.json"), "utf8"));
  assert.deepEqual(cursor.mcpServers.mergelight, { type: "stdio", command: "npx", args: ["-y", "@mergelight/cli", "mcp"] });
  assert.equal(f.logs.filter((l) => l.startsWith("✓")).length, 3);
  assert.match(f.logs.at(-1), /Handle the Mergelight findings/);
});

test("keeps what is already in Cursor's file, and never overwrites a file it can't read", async () => {
  const kept = fake({ cursor: true, cursorConfig: JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x" } } }) });
  assert.equal(await init(kept.deps), 0);
  const after = JSON.parse(readFileSync(join(kept.home, ".cursor", "mcp.json"), "utf8"));
  assert.equal(after.theme, "dark");
  assert.deepEqual(after.mcpServers.other, { command: "x" });
  assert.ok(after.mcpServers.mergelight);

  const broken = fake({ cursor: true, cursorConfig: "{ not json" });
  assert.equal(await init(broken.deps), 1);
  assert.equal(readFileSync(join(broken.home, ".cursor", "mcp.json"), "utf8"), "{ not json");
  assert.ok(broken.logs.some((l) => /isn't valid JSON/.test(l)));
});

test("an agent that refuses is reported, and the others still get set up", async () => {
  const f = fake({ agents: ["claude", "codex"], fail: ["claude"] });
  assert.equal(await init(f.deps), 0);
  assert.ok(f.logs.some((l) => /Claude Code: couldn't add the MCP server \(nope\)/.test(l)));
  assert.ok(!existsSync(join(f.home, ".claude", "skills")), "no skill without its server");
  assert.ok(existsSync(join(f.home, ".agents", "skills", "mergelight", "SKILL.md")));
  assert.ok(f.logs.some((l) => /GitHub CLI/.test(l)), "says the GitHub CLI is missing");
});

test("with no agent it says where to look, and fails", async () => {
  const f = fake();
  assert.equal(await init(f.deps), 1);
  assert.match(f.logs.join("\n"), /No coding agent was set up/);
  assert.match(f.logs.join("\n"), /docs\/agents\.md/);
});
