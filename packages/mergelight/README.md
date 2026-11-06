# mergelight

The Mergelight review engine and CLI. It reviews a GitHub pull request with your own logged-in Codex CLI, checks what it finds with your own Claude Code, and tells you which problems are worth fixing.

Every finding is one of four kinds:

- 🔴 **Bug:** happens in normal use and breaks something that matters. Fix it before merging.
- 🟠 **Minor bug:** happens in normal use, but the damage is small, like a wrong label or a missing translation.
- 🟡 **Risk:** real, but needs specific conditions, like a race or an unusual account setup.
- ⚪ **Hardening:** doesn't happen in real use. Extra safety, left alone by default.

How likely a problem is and how bad it is are rated separately, so a small problem that really happens is a minor bug, not hardening. Style, nitpicks and "add a test" comments are never posted. Text users see is not style: wrong or missing labels, messages and translations are reported. Each finding says how it would actually happen, what breaks, what the smallest fix costs, and whether that fix is worth it.

## Status

Early. It runs locally only and doesn't post to GitHub yet.

## Requirements

- Node 20 or newer
- [GitHub CLI](https://cli.github.com), logged in (`gh auth login`)
- [Codex CLI](https://github.com/openai/codex), logged in with your ChatGPT plan (`codex login`)
- Recommended: [Claude Code](https://claude.com/claude-code), logged in with your Claude plan. Opus checks the findings when it's installed. Without it, Codex does, with noisier results.

## Usage

```bash
npm install
npm run build
node dist/cli.js review https://github.com/owner/repo/pull/123
```

Other ways to name the pull request: `owner/repo#123`, or just `123` inside a clone of the repository.

| Option | What it does |
|---|---|
| `--at <sha>` | Review an earlier commit of the PR |
| `--json` | Print the review as JSON |
| `--out <file>` | Also save the JSON review to a file |
| `--model <name>` | Codex model to use (default: your Codex config) |
| `--effort <level>` | Reasoning effort: `low`, `medium` or `high` (default: `high`) |
| `--verify-with <name>` | Who checks the findings: `claude` (default when Claude Code is installed) or `codex` |
| `--verify-model <name>` | Model for the checker, like `claude-opus-5-5` (default for Claude: `opus`) |
| `--keep` | Keep the temporary checkout |

The exit code is `2` when the review finds a bug that blocks the merge, `1` on errors and `0` otherwise.

## How it works

1. Fetches the PR with `gh` into a small cached mirror in `~/.cache/mergelight` and checks out the commit under review in a temporary folder.
2. Three hunters run in parallel, each a `codex exec` in a read-only sandbox with one area to cover: access (who can see and do what), money and data, and behavior (does the change do what the PR says, everywhere it's used). They're told to be thorough and to check the code before reporting.
3. A sweep pass reads the changed files no hunter reported anything in, up to 36 files in runs of 12, so big PRs aren't only reviewed where the hunters happened to look. Tests and docs are skipped.
4. A verifier tries to disprove every candidate. It runs on Claude Code with the latest Opus when Claude Code is installed, and on Codex otherwise. It merges candidates only when they share the same cause and the same fix, and rates the rest: class, how likely, how bad, what the fix costs, and whether to fix it, decide or leave it. Then it picks at most 3 a senior reviewer would hold the merge for.
5. Only those top picks get their own comment. Everything else it would **fix** is listed under **also worth fixing** in the summary. **Decide** becomes a one-line **your call**, for real trade-offs. **Leave** is collapsed under hardening. Each finding also gets a fingerprint that survives line shifts, so later review rounds can tell old findings from new ones.

On 20 real pull requests, Opus's top picks came to about 2 comments per PR and the team fixed 62% of them without ever seeing them, about the rate of Copilot's comments that the team did see. Posting everything the verifier would fix meant about 4 comments per PR with Opus and 6 with Codex.

The light is red when a major bug must be fixed, yellow when anything else is worth fixing or needs a decision, and green otherwise.

Plugins, MCP servers, hooks and web search are switched off for every Codex run, so code in a pull request can't reach your other tools. Claude Code runs with only Read, Grep and Glob, confined to the checkout, with plugins, hooks, MCP servers and skills off, and anything that would ask for permission is denied. Every Codex run uses high reasoning effort unless you pass `--effort`, whatever your Codex config says. It matters: in our eval, gpt-6.1-sol at its default low effort found about a third fewer real problems. A review takes about 4 to 15 minutes depending on the size of the PR, around 7 for a typical one.

Nothing is sent to Mergelight. The review runs on your own Codex and Claude logins, on your machine.

## Eval

`eval/` compares Mergelight with CodeRabbit and Copilot on PRs they already reviewed, and with what the team did about each comment. Results are written to `~/.cache/mergelight/eval`, never to this repository.

```bash
node eval/collect.mjs owner/repo --since 2026-10-01   # comments other bots left, per PR
node eval/run.mjs owner/repo --count 20               # Mergelight reviews the same commits
node eval/judge.mjs owner/repo                        # Codex judges which comments the team fixed before merging
node eval/score.mjs owner/repo                        # per reviewer: comments, comments fixed, fixed issues found
node eval/replay.mjs owner/repo --from v2 --tag opus --with claude   # same candidates, another verifier
```

`compare.mjs` is a cruder, faster version of the judge. It only checks whether the commented lines changed, which misses fixes that land a few lines away.
