# Mergelight

AI code review that runs on the ChatGPT or Claude plan you already pay for. Mergelight reviews a GitHub pull request, tries to disprove every problem it finds before you see it, and tells you which ones are worth fixing.

## Start here

**Reviews on every pull request.** Set it up at [mergelight.dev/setup](https://mergelight.dev/setup). It runs in your own GitHub Actions, on your own plan. See the [GitHub Action guide](https://github.com/mergelightai/mergelight/blob/main/docs/github-action.md).

**Findings in your coding agent.** One command adds the MCP server and the skill to Claude Code, Codex and Cursor:

```bash
npx @mergelight/cli init
```

Then ask your agent: "Handle the Mergelight findings on this PR." See [Mergelight in your coding agent](https://github.com/mergelightai/mergelight/blob/main/docs/agents.md).

**One review from your terminal.** It uses your Codex login, or your Claude login with `--provider claude`.

```bash
npx @mergelight/cli review https://github.com/owner/repo/pull/123
```

## What a review says

Every finding is one of four kinds:

- 🔴 **Bug:** happens in normal use and breaks something that matters. Fix it before merging.
- 🟠 **Minor bug:** happens in normal use, but the damage is small, like a wrong label or a missing translation.
- 🟡 **Risk:** real, but needs specific conditions, like a race or an unusual account setup.
- ⚪ **Hardening:** doesn't happen in real use. Extra safety, left alone by default.

How likely a problem is and how bad it is are rated separately, so a small problem that really happens is a minor bug, not hardening. Style, nitpicks and "add a test" comments are never posted. Text users see is not style: wrong or missing labels, messages and translations are reported. Each finding says how it would actually happen, what breaks, what the smallest fix costs, and whether that fix is worth it.

## Requirements

- Node 20 or newer
- [GitHub CLI](https://cli.github.com), logged in (`gh auth login`)
- The [Codex CLI](https://github.com/openai/codex), logged in with your ChatGPT plan (`codex login`). It looks for the problems by default.
- Or [Claude Code](https://claude.com/claude-code), logged in with your Claude plan. With only Claude Code installed, add `--provider claude` to every `review` command.
- With both installed, Codex looks for problems and Claude checks them. `--provider claude` makes Claude do both.

## Usage

```bash
npx @mergelight/cli review https://github.com/owner/repo/pull/123
```

Installed with `npm i -g @mergelight/cli`, the command is `mergelight`. From a clone of the repository: `npm install`, `npm run build`, then `node dist/cli.js` in place of `mergelight`.

Other ways to name the pull request: `owner/repo#123`, or just `123` inside a clone of the repository.

| Option | What it does |
|---|---|
| `--at <sha>` | Review an earlier commit of the PR |
| `--json` | Print the review as JSON |
| `--out <file>` | Also save the JSON review to a file |
| `--provider <name>` | Who looks for problems: `codex` (default) or `claude` |
| `--model <name>` | Model to use (default: your Codex config, or `opus` with Claude) |
| `--effort <level>` | Reasoning effort: `low`, `medium` or `high` (default: `high`) |
| `--verify-with <name>` | Who checks the findings: `claude` (default when Claude Code is installed) or `codex` |
| `--verify-model <name>` | Model for the checker, like `claude-opus-5-5` (default for Claude: `opus`) |
| `--keep` | Keep the temporary checkout |
| `--post` | Post the review to the PR: inline findings, one summary comment and a **Mergelight** check. GitHub only lets Apps write checks, so a personal `gh` login gets the comments and no check. The [GitHub Action](https://github.com/mergelightai/mergelight/blob/main/docs/github-action.md) gets all three |
| `--dry-run` | With `--post`, `post` or `approve`: print what would be posted and change nothing |
| `--yellow-blocks` | With `--post` or `post`: a 🟡 check waits for an approval and a 🔴 one fails, instead of both being neutral |

Two more commands, used by the GitHub Action:

- `mergelight post review.json` posts a review saved with `--out`.
- `mergelight approve owner/repo#123 --by login` turns a 🟡 "needs a human" check green after someone approves the PR. A 🔴 check stays red.

`mergelight init` adds Mergelight to your coding agents, and `mergelight mcp` is the MCP server they start, so Claude Code, Codex or Cursor can read a PR's findings and mark them handled. `mergelight setup owner/repo` sets up the GitHub Action from a terminal.

The exit code is `2` when the review finds a bug that blocks the merge, `1` on errors and `0` otherwise. With `--post` it is `0` unless the review fails, since the check carries the verdict. On a personal `gh` login, where GitHub doesn't allow checks, the summary comment carries it instead.

## How it works

1. Fetches the PR with `gh` into a small cached mirror in `~/.cache/mergelight` and checks out the commit under review in a temporary folder.
2. Three hunters run in parallel, each a `codex exec` in a read-only sandbox, or Claude Code with file tools only, with one area to cover: access (who can see and do what), money and data, and behavior (does the change do what the PR says, everywhere it's used). A fourth covers CI and supply chain, and only runs when a PR touches workflows, container, deploy or dependency files. They're told to be thorough and to check the code before reporting.
3. A sweep pass reads the changed files no hunter reported anything in, up to 36 files in runs of 12, so big PRs aren't only reviewed where the hunters happened to look. Tests and docs are skipped.
4. A verifier tries to disprove every candidate. It runs on Claude Code with the latest Opus when Claude Code is installed, and on Codex otherwise. It merges candidates only when they share the same cause and the same fix, and rates the rest: class, how likely, how bad, what the fix costs, and whether to fix it, decide or leave it. Then it picks at most 3 a senior reviewer would hold the merge for.
5. Only those top picks get their own comment. Everything else it would **fix** is listed under **also worth fixing** in the summary. **Decide** becomes a one-line **your call**, for real trade-offs. **Leave** is collapsed under hardening. With `--post`, later review rounds hand the verifier what earlier rounds found. It checks each one again, so a finding keeps its id and its one comment even if it's worded differently or points at other lines, and "no longer found" means it was checked, not just missed. It also sees what the team marked as fixed or won't fix: a fix gets checked like anything else, and a decision not to fix is respected unless a major bug still stands.

On 32 real pull requests across two repositories, Opus's top picks came to about 2 comments per PR, and the team fixed 65% of the problems they describe. The team never saw these comments, but another bot had raised the same problem in 37 of the 63 cases. Among problems only Mergelight raised, the team fixed 38% of the top picks on its own and 14% of the other findings worth fixing, so the picks are a real signal, on a small sample. Posting everything the verifier would fix meant about 4.5 comments per PR with Opus and 6 with Codex.

The light is red when a major bug must be fixed, yellow when anything else is worth fixing or needs a decision, and green otherwise.

Plugins, MCP servers, hooks and web search are switched off for every Codex run, so code in a pull request can't reach your other tools. Claude Code runs with only Read, Grep and Glob, confined to the checkout, with plugins, hooks, MCP servers and skills off, and anything that would ask for permission is denied. Every Codex run uses high reasoning effort unless you pass `--effort`, whatever your Codex config says. It matters: in our eval, gpt-6.1-sol at its default low effort found about a third fewer real problems. A review takes about 2 to 15 minutes depending on the size of the PR, around 7 for a typical one.

Nothing is sent to Mergelight. The review runs on your own Codex or Claude login, on your machine or in your own GitHub Actions.

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

## License

Mergelight is under the [Functional Source License](https://github.com/mergelightai/mergelight/blob/main/LICENSE.md) (FSL-1.1-MIT). In plain words:

- You can use it, alone or in your company, and you can change it, fork it and share it.
- You can't offer it, or something built from it, as a commercial product or service that takes its place.
- Each version becomes MIT two years after it's released.

Changes are welcome as pull requests. See [CONTRIBUTING.md](https://github.com/mergelightai/mergelight/blob/main/CONTRIBUTING.md).
