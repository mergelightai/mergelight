# What is Mergelight

Mergelight is an AI code reviewer for GitHub pull requests. It runs in your own GitHub Actions on the Claude or ChatGPT plan you already pay for, and reports only the few problems worth holding a merge for.

## Why it exists

AI code review often comes with two problems.

- **A second bill.** Many AI review tools charge per seat or per review, on top of the AI plan your team already pays for. Mergelight reviews with that plan, so a plan login adds no per-review bill. You can use an API key instead, which your AI provider bills per use.
- **Review rounds that never end.** A reviewer built to find more always finds something. Each fix brings a new round of small notes, and a small change keeps growing. Mergelight weighs each finding, posts what matters and leaves rare edge cases alone. From the 4th review of a pull request on, only likely problems, major bugs and major security problems hold the merge.

## How it works

- **It runs in your GitHub Actions,** GitHub's own place to run jobs for a repository. It uses your own Claude or ChatGPT login, or an API key.
- **It looks, then checks.** One AI looks for problems. Then it, or a second AI if you connect both, tries to disprove each finding and drops the ones that don't hold up.
- **It posts in three places:** one summary comment that stays up to date on every push, at most 3 inline comments for the findings a senior reviewer would hold the merge for, and a live check called **Mergelight** with a green, yellow or red light. A check is the status line GitHub shows in a pull request's merge box.
- **Fixes happen in your own coding agent.** Mergelight's MCP server and skill let Claude Code, Codex or Cursor read the findings and fix them with your own tests. An MCP server is a small program your agent can call for data. See [Your coding agent](agents.md).

## What a review looks like

The check shows "Reviewing" while the review runs, then ends with one of three lights:

| Light | The check says | What it means |
|---|---|---|
| 🟢 | Safe to merge | Nothing worth holding the merge for. |
| 🟡 | Needs a human | Something is worth a fix or a decision, but it isn't a major bug. Read it and decide. |
| 🔴 | Blocked | A major bug to fix before you merge. The summary says what to fix first. |

By default, 🟡 and 🔴 end as "neutral", which GitHub counts as passing, so Mergelight doesn't block a merge on its own. To let it hold merges, see `yellow-blocks` in the [GitHub Action](github-action.md#inputs) reference.

The summary comment says what the pull request does, what's worth fixing, what's your call, and what was left alone on purpose. Each finding says how it happens, what breaks and the smallest fix.

## What it does not do

- **It doesn't change your code.** The review's GitHub token can only read your code, and the AI only gets tools that read files. The one exception is [Jobs](jobs.md), an opt-in feature that pushes one commit for tasks your team writes.
- **It doesn't send your code to Mergelight.** The review runs on your own GitHub Actions runner, the machine that runs the job. Your code goes from there to Anthropic or OpenAI under your own login. To post as the Mergelight AI app, a run sends only GitHub's signed pass for the run to Mergelight's token server, which keeps nothing.
- **It can't reach the internet during a review.** The AI gets no web search and no web fetch, and the commands Codex runs have no network. The AI's only connection is the Claude Code or Codex program's own link to Anthropic or OpenAI.

With the optional dashboard on, a run also sends the review's numbers and the findings your team declined, never code. See [Security and data](security.md).

## Who it is for

- Developers and teams on GitHub who already pay for Claude or ChatGPT.
- Teams that want a reviewer that knows when to stop, not one that adds rounds.
- Developers who fix code with a coding agent: Claude Code, Codex or Cursor.
- Teams that want their code and AI login to stay in their own CI.

## Next steps

- [Get started](quickstart.md): turn it on for one repository and see a first review.
- [How a review works](how-it-works.md): what happens between a push and the light.
- [Security and data](security.md): what runs where, and what Mergelight can see.
