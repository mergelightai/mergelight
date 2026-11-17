# How a review works

Mergelight reviews each pull request in your GitHub Actions and posts a summary, inline comments and a check. Here's what each means and how to answer it.

## When a review runs

With the workflow that the [setup page](https://mergelight.dev/setup/) writes, based on [`examples/mergelight.yml`](../examples/mergelight.yml), a review starts when a pull request:

- is opened or reopened.
- gets a new push. A review of an older commit that is still running is cancelled.
- is marked ready for review. Drafts aren't reviewed.
- moves to another base branch. A new title or description starts nothing.
- gets a comment that mentions `@mergelight-ai` from someone who can push. See [Answer in a comment](#answer-in-a-comment).

Pull requests from forks and from Dependabot aren't reviewed. GitHub gives their runs no secrets, so there is no AI login to review with.

The review runs on your GitHub Actions runner, with your own AI login: a Claude or ChatGPT plan, or an Anthropic or OpenAI API key. Your code and your login go from the runner to Anthropic or OpenAI, never to Mergelight. A review takes about 2 to 15 minutes.

## What happens in one review

1. **It shows that it started.** A summary comment that says "Reviewing" and a check named **Mergelight** appear on the pull request.
2. **It reads the change.** It checks out the pull request and its diff. Your team's rules and instruction files, such as `AGENTS.md`, come from the base branch, so a pull request can't change the rules of its own review.
3. **Several AI reviewers look for problems.** They run side by side, one per area: who can see and do what, money and data, and whether the code does what the pull request says. A fourth looks at CI and supply chain when workflows, build files or dependencies change. One more pass reads the changed files that none of them mentioned, except tests and docs.
4. **A checker tries to disprove each finding.** It reads each one in the code and drops the ones it can show can't happen. It merges duplicates, rates the rest, and picks at most 3 that a senior reviewer would hold the merge for. It also checks every finding from earlier reviews of this pull request again.
5. **It posts the result.** It updates the summary, adds inline comments, finishes the check, and approves the pull request or takes its approval back.

A review never reports style, naming, formatting, what a linter or type checker catches, missing tests (unless one hides a real bug), or refactors with no problem a user would notice. Text that users see, such as labels, messages and translations, does count.

### Two AIs: one reviews, the other checks

The reviewers and the checker can be different AIs: Claude (Claude Code) or Codex (OpenAI's coding agent, with a ChatGPT login or an OpenAI API key).

- `provider` sets who reviews. Left empty: Claude when the repository has only a Claude login, and Codex otherwise.
- `verify-with` sets who checks. Left empty: when both AIs have a login, the one that doesn't review, so two AIs look at every finding. With one login, the reviewer checks its own findings.

If the checker can't run, for example because it has no login yet or its plan hit its limit, the reviewer checks instead and the top of the summary says so. The last line of the summary names the AI that reviewed and the AI that checked. See [Two AIs](github-action.md#two-ais-one-reviews-the-other-checks) for how to connect the second login.

## What it posts

Mergelight posts three things, and all three change on each new review.

### The summary comment

One comment near the top of the pull request. Each review edits it, so there is never a second one. From top to bottom:

| Part | What it holds |
|---|---|
| Heading | The light: 🟢 Safe to merge, 🟡 Needs a human or 🔴 Blocked |
| Two sentences | What the pull request does, and whether it looks safe to merge |
| Count | For example "1 bug, 2 risks to fix, 1 for you to decide", or "Nothing worth fixing" |
| **To fix** | The checker's top picks, at most 3, each linked to its inline comment |
| **Also worth fixing** | The other findings the checker says to fix |
| **Your call** | Real problems where fixing is a trade-off for you to make |
| **Handled** | Findings that were fixed, resolved or declined. Folded: click to open |
| **Left alone** | Smaller findings that don't hold the merge, each with why. Folded |
| **No longer found since the last review** | Findings an earlier review listed that this one doesn't find. Folded |
| Last line | The round number, the commit it reviewed, which AI reviewed and checked, how long it took and the tokens it used |

When your team's [Jobs](jobs.md) ran on the pull request, a Jobs part says what each job did.

### Inline comments

Only the checker's top picks get a comment of their own, on the lines they are about: at most 3 per review. Each says how the problem happens, what breaks, the smallest fix and what it costs, and a one line verdict.

A finding that an earlier review already showed never gets a new comment. A top pick whose lines aren't in the diff is shown in full in the summary instead.

### The Mergelight check

The check shows "Reviewing" while it works, then ends with one of three lights. Its title says what it found, such as "🟡 Needs a human: 1 risk to fix".

| Light | When | Check result |
|---|---|---|
| 🟢 **Safe to merge** | No finding holds the merge: there are none, or only ones left alone | Success |
| 🟡 **Needs a human** | A finding to fix or to decide, and no major bug to fix. Or the pull request changes a file your team marked as always needing a human | Neutral |
| 🔴 **Blocked** | A major bug that the checker says to fix | Neutral |

A finding "holds the merge" when it keeps the check from going green. Neutral means GitHub counts the check as passing and shows no red cross, so by default Mergelight never blocks a merge.

- **To let it hold merges,** set `yellow-blocks: true` and make the **Mergelight** check required in branch protection or a ruleset. Then 🔴 fails until the code changes, and 🟡 waits for an approval.
- **A 🟡 check turns green** when someone who can push approves the newest commit. This needs the approval workflow, [`mergelight-approve.yml`](../examples/mergelight-approve.yml). `mergelight setup` adds it, but the setup page doesn't yet. By default a 🟡 check is neutral and blocks nothing, so this only matters when you set `yellow-blocks: true`: then add the approval workflow by hand. An approval never clears 🔴: only a fix does.
- **If the review itself can't run,** for example because the login expired, the check ends neutral and the workflow job fails, so you notice. The check says why.

If your team wrote its own checks, each one shows as a separate check named "Mergelight: " and its name. They don't change the light. See [Teach it your team's rules](customize.md).

## How findings are rated

The checker rates each finding on three things: what kind it is, how bad it is, and how likely it is.

**Kind.** Each finding in the summary starts with its kind:

| Label | Meaning |
|---|---|
| 🔴 Bug | Happens in normal use, and the damage is major |
| 🟠 Minor bug | Happens in normal use, and the damage is small but real, like wrong text or a confusing screen |
| 🟡 Risk | Real, but needs specific conditions: two requests at the same moment, unusual but valid data, a deploy window |
| ⚪ Small fix | Hardening: it doesn't happen in real use, but the checker says the extra safety is worth adding |

**Severity.** Major means it breaks a feature, loses or corrupts data, charges a wrong amount, or exposes data or actions to someone who shouldn't have them. Minor means a real but small problem. It is a security problem when it lets someone see secrets or other people's data, act as someone else, or do what they shouldn't be able to.

**Likelihood and cost.** An inline comment ends with a line such as `plausible · major · fix small`.

- Likelihood: common (normal use), plausible (a real user with an ordinary setup can hit it), rare (needs a setup, timing or data most users never have) or theoretical (possible in principle, with no realistic path).
- Fix cost: trivial (a line or two), small (one function or file), medium (several files or a migration) or large (a redesign).

**Where it goes.** The checker weighs how likely and how bad against the cost of the fix, and says fix, decide or leave. Fix goes to To fix or Also worth fixing, decide goes to Your call, and leave goes to Left alone. A minor risk always goes to Left alone, and so do the cases the [loop breaker](#the-loop-breaker) leaves alone. A major bug or a major security problem never does: if the checker says to leave one, it goes to Your call, so a person decides.

## Every push is a new round

Each review of a pull request is a round, and the last line of the summary gives its number. Every push starts a new round, and so does every `@mergelight-ai` comment.

- Each round checks every finding from earlier rounds again.
- A finding stays one finding, even when the AI words it differently or points at other lines.
- The summary is edited in place, and nothing is posted twice.

### Fixed findings

When the code at a finding changed and the review no longer finds it, Mergelight edits its inline comment to "✅ Handled", with the original text behind a dropdown. It also folds the comment away, so GitHub shows "This comment was marked as resolved", and moves the finding to Handled in the summary.

The thread itself stays open for a person to resolve. GitHub only lets a token resolve a thread if it may also change the code, and Mergelight's token can only read it. If the finding comes back in a later round, its comment opens up again with the original text.

A finding that was only in the summary moves to "No longer found since the last review" when the review no longer finds it.

### The loop breaker

On long pull requests, each fix of an unlikely case can bring new unlikely cases in its own code. Mergelight ends that loop:

- In every round, a finding rated rare or theoretical doesn't hold the merge, unless it is a major bug or a major security problem.
- From the 4th round on, only likely problems (rated common), major bugs and major security problems hold the merge. The rest moves to Left alone with its reason, and the summary says so in one line.
- A major bug or a major security problem holds the merge in every round.

## Answer a finding

Tell Mergelight what you did about a finding, and the next review takes it into account. Only people who can push to the repository count: anyone else's answer changes nothing.

| You | What the next review does |
|---|---|
| Fix the code and push | Checks the code. If the finding is gone, it moves to Handled |
| Resolve the inline comment's thread, with a reply that says why | Takes it as your team's decision to leave it, and moves it to Handled. Only replies by the person who resolved the thread count |
| Mark it fixed or won't fix from your coding agent | Checks a fixed mark in the code, because a mark is a claim, not proof. A won't fix mark needs a reason. See [Your coding agent](agents.md) |
| Write a comment that mentions `@mergelight-ai` | Starts right away and reads your comment as your team's answer. See below |

**A real bug can't be waved through.** A major bug that can still happen as described stays reported and keeps counting toward the check, whatever the answer says. The same goes when your reason is wrong on a fact the review can check in the code, or a later change made the problem worse.

### Answer in a comment

Write a comment on the pull request that mentions `@mergelight-ai`, in plain words: what you fixed, and what to leave and why. For example: "@mergelight-ai Saved workouts: not worth it, this account has none."

- A new review starts and reads your comment. A fix you name is checked in the code, a finding you decided to leave moves to Handled, and a finding you don't name is checked as usual.
- Mergelight replies with what it took from your comment and what still holds the merge.
- Each comment is one review run on your plan.
- Comments by people who can't push, by bots, or on a pull request from a fork start nothing.

This needs Mergelight v0.1.20 or newer, and the `issue_comment` trigger in your workflow. If your workflow file has no `issue_comment:` line, copy it and the `if:` condition from [`examples/mergelight.yml`](../examples/mergelight.yml): an update from the setup page only changes the version lines. GitHub runs a comment's workflow from your default branch, so the Mergelight workflow must be on that branch too.

## Approvals

When a review is 🟢 and every one of your team's own checks passed, Mergelight approves the pull request. A later review that isn't 🟢 takes the approval back.

- **Its approval doesn't count toward a branch rule's required approvals.** GitHub counts an approval there only from an account that can push, and the Mergelight AI app can only read your code. Where a branch rule asks for an approval, a person still gives it.
- It doesn't approve when your team's server couldn't be reached, because the review then ran without your team's rules and checks.
- A review that couldn't run takes back Mergelight's approval of an earlier commit.
- Mergelight never requests changes, so its review never blocks a merge by itself.

To turn approvals off, set `auto-approve: false`. Mergelight then never approves, and takes back an approval it gave before on each pull request's next review. On pull requests that are already open, dismiss its approval by hand.

## Your team's memory of declined findings

When your org uses the Mergelight dashboard, Mergelight keeps the findings your team declined, with the reason. Later reviews of the same repository read those decisions before they report the same problem in the same file again.

- A decision comes from a won't fix mark, a reply in a resolved thread, or an `@mergelight-ai` comment, by someone who can push.
- When Mergelight keeps a reason from a thread, it answers once in that thread: "Remembered".
- A decision covers one problem in one file. A major bug that can still happen is reported anyway.

This needs the Action's `server` input. See [Teach it your team's rules](customize.md).

## What a review never does

- **Change your code.** The review's GitHub token can only read code, and the AI only gets tools that read. Fixes happen in [your own coding agent](agents.md). The one exception is [Jobs](jobs.md): a separate, opt-in step that can push one commit to the pull request's branch.
- **Reach the internet.** Claude Code gets only file tools to read, search and list files. Codex runs with web search off, and its commands run in a sandbox with no network.
- **Follow instructions in the pull request.** The AI is told that text in the diff, in code comments and in the description is data, and to ignore any instructions in it.
- **Send your code or your AI login to Mergelight.**

See [Security and data](security.md) for the full picture. For every input of the Action, see [GitHub Action](github-action.md#inputs).
