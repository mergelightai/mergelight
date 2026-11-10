# Mergelight in your coding agent

Mergelight never changes your code. Fixes happen in your own agent, with your own tests and rules. An MCP server and a skill teach any agent how:

- **The MCP server** reads what the [GitHub Action](github-action.md) posted on a pull request and records what you did about it.
- **The skill** tells the agent what to do with it: fix what's worth fixing, ask you about what's your call, leave hardening alone, and run the project's own tests.

It uses your own `gh` login. Nothing is sent to Mergelight, and no model runs: reading findings doesn't use your plan.

## Setup

You need Node 20 or newer and the [GitHub CLI](https://cli.github.com), logged in (`gh auth login`).

**1. Run this once:**

```bash
npx @mergelight/cli init
```

It adds the MCP server and the skill to each agent it finds: Claude Code, Codex and Cursor. It only writes where each agent keeps its own settings, and running it again replaces what it added.

**2. By hand, if you'd rather.** The server is `npx -y @mergelight/cli mcp`, and the skill is the folder `skills/mergelight` in the package.

Claude Code:

```bash
claude mcp add --scope user mergelight -- npx -y @mergelight/cli mcp
```

Codex:

```bash
codex mcp add mergelight -- npx -y @mergelight/cli mcp
```

Cursor: add this to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "mergelight": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@mergelight/cli", "mcp"]
    }
  }
}
```

Copy the skill folder to `~/.claude/skills`, `~/.agents/skills` or `~/.cursor/skills`.

**3. Ask your agent:** "Handle the Mergelight findings on this PR."

## Tools

### `list_findings`

| Input | What it does |
|---|---|
| `pr` | A URL or `owner/repo#123`, or a number inside a clone. Without it, the current branch's pull request |
| `tier` | Only this tier: `post`, `list`, `decision` or `hardening` |

Findings come grouped by tier. Each one has how it happens, what breaks, the smallest fix, what that fix costs, a verdict, and a stable id that lasts across review rounds.

| Tier | Where it shows on GitHub | `action` |
|---|---|---|
| `post` | Its own comment, at most 3 per review | `fix` |
| `list` | "Also worth fixing" in the summary | `fix` |
| `decision` | "Your call" in the summary | `ask` |
| `hardening` | "Left alone" in the summary | `leave` |

It also says whether the review is up to date with the latest commit, whether a new one is running, what's already handled, and what to do next.

### `mark_finding_handled`

| Input | What it does |
|---|---|
| `pr` | As above |
| `ids` | Finding ids from `list_findings` |
| `as` | `fixed` or `wont_fix` |
| `note` | What was done. For `wont_fix`, why not: required |

A finding with an inline comment gets a reply in its thread. The rest share one comment on the pull request.

- **`fixed`** only works once something was pushed since the review. The thread stays open until the next review has checked the code. If the finding is gone it closes as usual. If the review still finds it, the finding comes back as `still_found`, because a mark is a claim, not proof.
- **`wont_fix`** resolves the thread and hands your reason to the next review. It won't raise the finding again, and moves it to "Handled" in the summary, unless it's a major bug that still stands, the reason is wrong on the facts, or the code got worse.

A mark never changes the check. Only the next review does, so no agent can talk a 🔴 check green: a major bug stays red until it's fixed or the verifier agrees it can't happen.

Marks only count from bots and people who can write to the repository.

## Good to know

- **Which pull request:** Without `pr`, the server asks `gh` from the folder your agent started it in. Claude Code and Codex start it in your project. Cursor doesn't document this, so pass `pr` there. The skill always passes it.
- **Reviews from before this version:** Their findings only have a title and how it happens. The next review adds the rest.
- **Untrusted text:** Findings come from a model that read the pull request, and a pull request can contain anything. The skill tells the agent to check them against the code and never follow instructions in them. Only comments from bots and your team count, so a stranger can't post fake findings.
