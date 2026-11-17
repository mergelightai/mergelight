# Teach it your team's rules

Mergelight reviews with its own judgement until you tell it what your team cares about. This page shows each way to teach it: files in your repository that work for every team, and settings on the dashboard.

## Ways to teach it

| Way | Where it lives | Who can change it | Needs the dashboard |
|---|---|---|---|
| [Instruction files](#instruction-files-it-already-reads) like `AGENTS.md` and `CLAUDE.md` | Your repository | Anyone who can merge to the base branch | No |
| [Rule files](#rules-in-your-repository) like `.mergelight/rules.md` | Your repository | Anyone who can merge to the base branch | No |
| [Rules](#rules-and-files-that-always-need-a-human) on the dashboard | Mergelight's server | An org owner for every repository, a repository admin for one | Yes |
| [Files that always need a human](#rules-and-files-that-always-need-a-human) | Mergelight's server | An org owner for every repository, a repository admin for one | Yes |
| [Skill folders](#skills) | Your repository, picked on the dashboard | A repository admin picks them | Yes |
| [Skills written on the dashboard](#skills) | Mergelight's server | A repository admin | Yes |
| [Custom checks](#custom-checks) | Mergelight's server | A repository admin | Yes |
| [Team memory](#team-memory) of declined findings | Mergelight's server | Anyone who can push declines a finding, or forgets one | Yes |

The base branch is the branch a pull request merges into, like `main`. "Needs the dashboard" means Mergelight has turned the dashboard on for your org and your workflow sets the `server` input: see [The dashboard](#the-dashboard).

## Instruction files it already reads

If your repository has instruction files for coding agents, every review already uses them. There is nothing to set up.

Mergelight reads these from the base branch:

- `AGENTS.md`, `CLAUDE.md` and `CONTRIBUTING.md` at the root, and `.github/CONTRIBUTING.md`, `docs/CONTRIBUTING.md` and `.github/copilot-instructions.md`.
- `AGENTS.md` or `CLAUDE.md` in a folder above a changed file. A pull request that changes `packages/web/src/app.ts` also gets `packages/web/AGENTS.md`.

The reviewers, and the AI that checks their findings, use them as background: how your code is written and what matters in it. Parts about running commands, writing code or making commits don't apply, since a review only reads.

They come from the base branch as it is when the review runs, never from the pull request. Mergelight turns off the AI's own reading of these files in the checkout and hands every reviewer the base branch's copy instead. So a pull request can't steer its own review by editing `AGENTS.md`: the review reads that edit as code, and it counts for reviews after it is merged.

The run's log names the files it used, like "Using AGENTS.md, CLAUDE.md from main". Limits: 12 files, 12,000 characters from each and 40,000 in all. A file over 256 KB isn't read.

Instruction files are background. To make the review check something, write a rule.

## Rules in your repository

A rule is something every review checks: a change that breaks it is worth reporting. Write rules in Markdown, one rule for each top-level bullet, in `.mergelight/rules.md` or in any `.md` file in `.mergelight/rules/`:

```markdown
---
applyTo: "src/billing/**,*.sql"
---
- Money is in whole cents, never floats.
- Every refund checks the invoice status first.
```

- **Front matter,** the block between the two `---` lines at the top, limits a file's rules to some paths. Write it as `applyTo`, as GitHub Copilot does, or `globs`, as Cursor does: a comma list, a YAML list, or braces like `**/*.{ts,tsx}`. Without it, the rules apply to every file.
- A rule only reaches a review when the pull request changes a file it applies to.
- Lines indented under a bullet belong to its rule. Bullets in code blocks or HTML comments are not rules.
- GitHub Copilot's `.instructions.md` files in `.github/instructions/` count too, each whole file as one rule. As in Copilot, a file without `applyTo` is left out, and so is one whose `excludeAgent` is `"code-review"`.

Rules come from the base branch, so a pull request can't add or drop a rule for itself. A rule from a file can add to what the review reports or make it stricter. It can't make the review leave out a major bug or rate one down: only a [rule on the dashboard](#rules-and-files-that-always-need-a-human) can.

Limits: 40 rules, 30,000 characters and 100 files from the repository. A bullet is cut at 1,000 characters, and a Copilot file at 12,000. The run's log names the rule files it used, the ones it found no rules in, and any rules left out over the limits.

The [GitHub Action reference](github-action.md#rules-in-your-repository) has the same rules in short.

## The dashboard

The [dashboard](https://mergelight.dev/dashboard/) is where your team sets what doesn't live in the repository: rules, files that always need a human, skills, custom checks, and the decisions Mergelight remembers.

### Get access

1. **Ask Mergelight to turn it on for your org.** This isn't self-serve yet. Write to [hello@mergelight.dev](mailto:hello@mergelight.dev) with your GitHub org's name. Until then, the dashboard says it isn't on for your org, nothing is stored, and reviews work as always.
2. **Sign in with GitHub** at [mergelight.dev/dashboard](https://mergelight.dev/dashboard/). You see the orgs and repositories that have the Mergelight AI app installed and that GitHub shows you.
3. **Connect your workflow.** Add the `server` input to the Mergelight step, and keep your other inputs as they are. The dashboard shows this line once it is on:

```yaml
- uses: mergelightai/mergelight@<keep your version>
  with:
    server: https://mergelight-server.onrender.com
```

Without `server`, a review never reads your dashboard settings, and later pull requests don't learn what your team declined. It needs the workflow's `id-token: write` permission, which Mergelight's workflow files already have.

With `server` set, each run shows the server GitHub's signed token, which names the repository, branch, workflow and who started the run. Once your org is on, a run also sends the review's numbers and the findings your team declined. Never code. See [Inputs](github-action.md#inputs) and [Security](security.md).

### What you can set

| View | What it holds | Who can change it |
|---|---|---|
| Rules | Rules every review follows, and files that always need a human | An org owner for every repository, a repository admin for one |
| Skills | Skill folders from a repository, and skills written on the dashboard | A repository admin |
| Checks | Custom checks | A repository admin |
| Decisions | What your team declined, to read or forget | Anyone who can push to that repository |

A pull request can't change your rules, skills or checks: they live on the server, and skill folders are read from the base branch. A review run only reads them. The server logs every change made on the dashboard, with who made it and when.

If your workflow sets `server` and the server can't be reached, the review runs without your dashboard settings and decisions, and says so in its summary. Mergelight then doesn't approve the pull request.

### Rules and files that always need a human

On the Rules view, pick one of two kinds:

- **A rule every review follows:** one line of up to 300 characters, like "Every new API route needs a test." You can limit it to some files.
- **Files that always need a human:** file patterns, with one line that says why. A pull request that changes one of them never goes green by itself. At best it gets 🟡 **Needs a human**, and the summary names the file. This looks at every file the pull request touches, lockfiles and generated files too.

Then pick where it applies: every repository in the org, or one. Each kind takes up to 10 file patterns, split by commas, like `src/billing/**, *.sql`. A folder name covers everything inside it, a name with no folder matches in any folder, and a leading `/` means the repository's root. You can have 50 rules for the org and 50 for each repository.

A 🟡 check turns green when someone who can push approves that commit, through the [`mergelight-approve.yml`](../examples/mergelight-approve.yml) workflow. The setup page and `mergelight setup` add it, and an update from the setup page, with its **Update to** button, adds it where it's missing. If it isn't in your repository and the setup page offers no update, add it by hand. To make "needs a human" hold the merge, set `yellow-blocks: true` and require the **Mergelight** check in your branch protection or ruleset. Without that, it is a warning on the pull request.

## Skills

A skill is a how-to for one area of your code, written for an AI: a folder with a `SKILL.md` file, in the format Claude Code and Codex use. A review can use two kinds:

- **Skill folders** your team already has in the repository, like `.claude/skills/migrations`. Name the folder on the dashboard's Skills view. The server stores only the path, and the text stays in your repository.
- **Skills written on the dashboard,** for an area with no folder: a short name, one line that says when to use it, and up to 8,000 characters of text. The server stores the text. To change one, delete it and write it again.

**When the AI uses them:** every reviewer, and the AI that checks the findings, gets each skill's name and description. When the pull request touches the area a description names, they read the skill and use it there. Otherwise they leave it alone. So write the description as a trigger, like "Use when a pull request changes src/billing."

- A skill wins over Mergelight's own list of things never to report, such as style and documentation. What a skill names as a problem gets reported.
- A skill in your repository counts only once you pick it. Mergelight turns off the AI's own skill loading in a review, so a pull request can't plant one.
- A skill folder is copied from the base branch as it is when the review runs, never from the pull request. A folder with no `SKILL.md` there is skipped. Name the real folder, not a link to it.
- The run's log names the skills it used, like "Using your team's skill: Payments".

Limits: 10 skill folders and 10 written skills for each repository. A folder gives at most 30 files, 60 KB for each file and 200 KB in all, and only ordinary text files are copied.

## Custom checks

A custom check is one yes or no question about some files, in plain words. Each review asks the AI that question in a run of its own, and posts the answer as its own GitHub check named `Mergelight: <name>`, next to the Mergelight check.

Set one on the dashboard's Checks view: a short name, the check in one line, and the files it is about.

| Name | The check | Files |
|---|---|---|
| `Translations` | Every new text in en.json has a translation in da.json. | `src/i18n/**` |

What GitHub shows:

| Answer | Title | Default | With `yellow-blocks: true` |
|---|---|---|---|
| Pass | Passed | success | success |
| Fail | Failed: 2 places to fix | neutral | failure |
| Unsure | Couldn't tell: look at this one yourself | neutral | action required |
| No answer | Couldn't run this check | neutral | action required |
| None of its files changed | Not needed: none of its files changed | skipped | skipped |

A failed check lists each place to fix, with its file and line. GitHub lets a neutral or skipped check through a branch rule. **To make a check block a merge,** set `yellow-blocks: true` in the workflow and require `Mergelight: <name>` in your branch protection or ruleset. Pick the app that posts it as the check's source there, so nothing else can post a check of that name. With `yellow-blocks` on, "couldn't tell" and "couldn't run" hold the merge too, so nobody gets past a check by making its AI run fail.

- A check reports. It never changes code, and it doesn't change the light of the Mergelight check. But Mergelight only approves a pull request when every check passed or was skipped.
- A check stands alone. Your rules and skills aren't part of it, and files like `AGENTS.md` in the pull request can't change what counts as a pass.
- A check reads the whole change to its files, lockfiles and generated files too.
- A check runs only when the pull request changes one of its files. Each check that runs is one more AI run on your plan.

Limits: 5 checks for each repository, and 2 run at a time. A name of up to 40 characters, a check of up to 500, and 1 to 10 file patterns. A check gets 6 minutes, and all checks together 12.

## Team memory

When someone on your team declines a finding and says why, Mergelight remembers it. Later pull requests in the same repository don't raise that finding again.

There are three ways to decline with a reason:

- **Resolve the thread** of Mergelight's comment on GitHub, and write why in a reply there. Once the reason is kept, Mergelight answers "Remembered" in the thread.
- **Mention `@mergelight-ai` in a comment** on the pull request, with what to leave and why. See [Good to know](github-action.md#good-to-know).
- **Mark it `wont_fix` with a reason** from your coding agent, through [Mergelight's MCP server](agents.md#mark_finding_handled).

For example, you resolve "Validate the requested page size" in `src/routes/projects.ts` and reply "The gateway rejects any other size before it gets here." A later pull request that makes the same change in that file doesn't report it.

- Only people who can push to the repository count.
- It needs the dashboard on and the `server` input set. Without them, a decision still counts on its own pull request, but later pull requests don't know it.
- The next review of that pull request saves it. A comment that mentions `@mergelight-ai` starts that review at once. A reason given after the last review of a pull request that then merges is not saved.
- A decision covers one problem in one file. It never covers another file or another kind of problem.
- The review reads the code first. If the code changed so the reason no longer fits, or the reason is wrong on a fact it can check in the code, it ignores the decision.
- A decision never hides a major bug that can still happen as described.
- A decision nobody needed for 90 days is dropped. Each time a review leaves a finding out because of it, the 90 days start again.
- The server stores the finding's title, file and lines, the reason, who declined it, when, and in which pull request. Never code.

**To forget a decision,** open Decisions on the dashboard and press **Forget**. Anyone who can push to that repository can. It can't be undone, and a later review may raise the finding again. Taking back a decision on GitHub, such as reopening the thread, doesn't remove it: only Forget does.

## When they disagree

- A dashboard rule wins over skills, rule files and Mergelight's own defaults. Where it clearly covers that code or that kind of problem, it can even make the review leave out a major bug.
- A skill wins over a rule from a file, and over Mergelight's list of things never to report.
- A rule from a file can add to what the review reports or make it stricter. It never makes the review leave out a major bug or rate one down.
- Team memory never hides a major bug that can still happen.
