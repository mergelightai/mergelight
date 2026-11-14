# Mergelight GitHub Action

Reviews every pull request with your own Claude or Codex login and posts:

- **One summary comment**, kept up to date on every push: what the PR does, what's worth fixing, what's your call, and what was left alone on purpose.
- **Inline comments** for the few findings a senior reviewer would hold the merge for, at most 3 per review, each with how it happens, what breaks and the smallest fix. Anything else worth fixing is listed in the summary.
- **A live check** called **Mergelight**. It shows "Reviewing" while it works, then:
  - 🟢 **Safe to merge:** success.
  - 🟡 **Needs a human:** neutral, so it doesn't block the merge. Read it and decide. It turns green if someone approves the PR.
  - 🔴 **Blocked:** neutral too, so it doesn't block the merge or show a red cross. The title and the summary say what to fix first.

If the review itself can't run, for example because the login expired, the check ends neutral so it doesn't block merging, and the workflow job fails so you notice.

## Which login to use

| Login | Repositories | Cost |
|---|---|---|
| **ChatGPT login** (`codex-auth-json`) | Any | Your ChatGPT plan |
| **OpenAI API key** (`openai-api-key`) | Any | Billed per use |
| **Claude plan** (`claude-code-oauth-token`) | Any | Your Claude plan |
| **Anthropic API key** (`anthropic-api-key`) | Any | Billed per use |

### Two AIs: one reviews, the other checks

`provider` says who reviews, and `verify-with` says who checks the findings, which drops the ones it can disprove. A value you set always wins. Left empty:

- **Who reviews:** Claude when the repository has only a Claude login, and Codex otherwise.
- **Who checks:** when both AIs have a login, the one that doesn't review, so two AIs look at every finding. With one login, the reviewer checks its own findings.

When `provider: claude` is set and there's no Claude login yet, a pull request from the repository itself shows the Claude link to mergelight.dev, the same way a missing ChatGPT login shows a code.

When the checker has no login yet, a pull request from the repository itself asks to connect it, the same way as the reviewer's login: a ChatGPT code, or a Claude link to mergelight.dev. The review waits for it at most 15 minutes. If nobody connects it, or it can't be asked (a fork, Dependabot, or no app to save the login), the reviewer checks instead and the summary says so. Only a private repository shows a ChatGPT code for the checker, since anyone who can see the pull request could enter it. Elsewhere, save a login of its own yourself, never the one your own Codex uses, as the two would use up each other's tokens: `export CODEX_HOME=$(mktemp -d); codex login; gh secret set CODEX_AUTH_JSON --repo <owner/repo> < $CODEX_HOME/auth.json`. Claude's link goes through mergelight.dev, where you sign in, so it is still shown. The summary's last line names both AIs.

Pull requests from forks and from Dependabot aren't reviewed, because GitHub gives their runs no secrets. On a public repository everyone can see the pull request, so the comment that connects a plan names the account that connected.

## Set it up

Go to **[mergelight.dev/setup](https://mergelight.dev/setup/)** and continue with GitHub. Everything happens in your browser, one step at a time:

1. **Pick a repo.** If it isn't listed, add it on GitHub, and the list refreshes when you come back.
2. **Add Mergelight.** Choose what it reviews: pull requests into one branch, or every pull request. With one branch, merges like `staging` into `main` are skipped, so code pushed straight to `staging` isn't reviewed. With every pull request, GitHub only runs the file on branches that have it, so other branches join once it's merged into them. The page then opens a pull request with the file, using your own sign-in in your browser. On a private repository it also adds the job that keeps a ChatGPT login fresh, because a review that starts while another is refreshing the login can fail. It reviews itself, and you decide whether to merge. If GitHub refuses, the page offers GitHub's editor with the file filled in instead.
3. **Connect your AI,** if the repo isn't connected yet:
   - **ChatGPT plan**: the pull request shows a link and a code. Enter the code, and the review starts. First turn on "Enable device code sign-in" in your [ChatGPT security settings](https://chatgpt.com/settings/security). It's in beta, and on a workspace an admin turns it on.
   - **Claude plan**: the pull request links to the setup page. Confirm on Claude's own page, then paste the code Claude shows you into the setup page. The login lasts about a year, so there's nothing to refresh. Without the page: run `claude setup-token` on your computer, add the token to the repository's secrets as `CLAUDE_CODE_OAUTH_TOKEN`, then push a commit.
   - **Anthropic API key**: add it to the repository's secrets as `ANTHROPIC_API_KEY`, then push a commit. Anthropic bills it per use.
   - **OpenAI API key**: add it to the repository's secrets as `OPENAI_API_KEY`, then push a commit. OpenAI bills it per use.

The first review runs on that same pull request, so you can see what a review looks like. The page follows it live, but you can close the page: the review keeps running, and the result shows up on the pull request. Merge the pull request to turn on reviews for new ones.

There's no key or token to manage. The workflow's `id-token: write` permission proves which repository it runs in, and Mergelight's token server returns a short-lived token for that repository only. Your ChatGPT login stays in your own run and your repository's secret, and never goes through Mergelight.

**Prefer a terminal?** `mergelight setup owner/repo` does the same with `codex login`.

| Option | What it does |
|---|---|
| `--base <branch>` | Add the workflows to this branch. Use the branch most pull requests go to |
| `--skip-branches <a,b>` | Don't review pull requests from these branches, like `staging` into `main` |
| `--relogin` | Log in to Codex again |
| `--no-pin` | Follow `@v0` and get each release by itself, instead of pinning to the latest |
| `--yes` | Don't stop to ask whether the app is installed |

**There are two apps, so that a leak on our server can't reach your code or workflows.**

- **Mergelight AI** posts comments and checks, reads code, and overwrites this repository's Actions secrets to save the refreshed Codex login. It can't read a secret's value, and it can't commit. Our server holds its private key.
- **Mergelight Setup** can commit code and workflows, read secret names and read checks. The setup page uses it with your own sign-in to open the pull request that adds or updates the file. No private key for it exists, so it can't act unless you're signed in. You don't need it if you add the files by hand.

**Versions.** The setup page and `mergelight setup` pin the workflows to the latest release's commit, like `mergelightai/mergelight@<commit> # v0.1.2`. That step can read your AI login, so new code only runs once you merge an update. A pinned repo never changes by itself: the review says when a newer release is out, and the setup page opens a pull request that updates it. Our own Action pins the actions it uses too.

**To get each release by itself instead,** use `@v0`, which the files in `examples/` do, or run `mergelight setup owner/repo --no-pin`. `v0` moves to a release only after a real review with it passed in our test repository, but you're trusting each release as it comes. To get update pull requests from Dependabot, add this to `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
    allow:
      - dependency-name: mergelightai/mergelight
```

**Approvals.** A 🟢 review approves the PR, like a reviewer would, when every one of your team's own checks passed. A later review that isn't 🟢 takes the approval back. Where a branch rule asks for one approval, a 🟢 PR can then be merged with no person approving it. Set `auto-approve: false` if a person must always approve. Mergelight then takes back its approval on each PR's next review, so dismiss its approval on PRs that are already open by hand.

**Optional: let it hold merges.** Set `yellow-blocks: true` and require the **Mergelight** check in branch protection or a ruleset. 🔴 then fails until the code changes, and 🟡 waits for an approval. Without `yellow-blocks`, both end neutral, which GitHub counts as passing.

## Set it up by hand

**1. Install the app.** [Install Mergelight AI](https://github.com/apps/mergelight-ai/installations/new) on the repository. Skip it and everything still posts, as `github-actions[bot]`, but you then need `secrets-token`: a [fine-grained token](https://github.com/settings/personal-access-tokens/new) with **Secrets: Read and write**, or the login has to be redone by hand after about 10 days.

**2. Make a login just for CI.** Don't copy your own `~/.codex/auth.json`: one login used on two machines breaks when either one refreshes it.

```bash
mkdir -p ~/.codex-ci && printf 'cli_auth_credentials_store = "file"\n' > ~/.codex-ci/config.toml
```

```bash
CODEX_HOME=~/.codex-ci codex login
```

Check that `~/.codex-ci/auth.json` has `"auth_mode": "chatgpt"` and a `refresh_token`.

**3. Store it as a secret,** then delete the local copy so only CI uses it:

```bash
gh secret set CODEX_AUTH_JSON --repo owner/repo < ~/.codex-ci/auth.json && rm -rf ~/.codex-ci
```

**4. Add the workflows.** Copy the three files in [`examples/`](../examples) to `.github/workflows/`:

- [`mergelight.yml`](../examples/mergelight.yml) reviews every non-draft PR from this repository, and cancels an older review of the same PR when you push again.
- [`mergelight-approve.yml`](../examples/mergelight-approve.yml) turns a 🟡 check green when someone approves the PR. Skip it if you work alone: GitHub doesn't let you approve your own PR.
- [`mergelight-refresh.yml`](../examples/mergelight-refresh.yml) refreshes the login every third day and saves it at once, so reviews rarely need to.

They're separate files so a PR's merge box only shows the review, not skipped jobs.

## Rules in your repository

Write what every review should check in `.mergelight/rules.md`, or in more files in `.mergelight/rules/`. Each bullet is one rule. Front matter at the top limits a file to some paths, in the format GitHub Copilot uses:

```markdown
---
applyTo: "src/billing/**,*.sql"
---
- Money is in whole cents, never floats.
- Every refund checks the invoice status first.
```

Mergelight also checks each `.github/instructions/*.instructions.md` file as a rule, for the files its `applyTo` names. As in Copilot, a file without `applyTo` is left out, and so is one whose `excludeAgent` is `"code-review"`. Bullets inside code blocks or HTML comments are not rules. Rules are read from the base branch, so they count from the review after they are merged, and a pull request can't add or drop a rule for itself. They work next to the rules set on the dashboard, and the review log says which rule files it used. A rule from the repository can add to what the review reports or sharpen it, but it can't hide a major bug or rate one down: only a rule on the dashboard can. A review reads at most 40 rules from the repository.

## Inputs

| Input | Default | What it does |
|---|---|---|
| `codex-auth-json` | | ChatGPT login. Unset, the pull request shows a link to connect |
| `openai-api-key` | | OpenAI API key |
| `secrets-token` | | Only without the app: a token that can update secrets, to save refreshed logins |
| `auth-secret-name` | `CODEX_AUTH_JSON` | The secret the refreshed login is saved to |
| `model` | Codex default | Model to review with |
| `effort` | `high` | Reasoning effort: `low`, `medium` or `high` |
| `provider` | | Who reviews: `claude` or `codex`. Empty: Claude with only a Claude login, Codex otherwise |
| `verify-with` | | Who checks the findings: `claude` or `codex`. Empty: the AI that doesn't review when both have a login, the reviewer otherwise. See [Two AIs](#two-ais-one-reviews-the-other-checks) |
| `auto-approve` | `true` | When a review is 🟢 and every one of your team's own checks passed, Mergelight approves the PR like a reviewer would, and takes the approval back when a later review isn't 🟢. `false` turns that off: it never approves, and takes back an approval it gave before on each PR's next review. For PRs that are already open, dismiss Mergelight's approval by hand |
| `yellow-blocks` | `false` | Let the check hold merges: 🟡 waits for an approval and 🔴 fails until the code changes. Your team's own checks from the dashboard follow it too: on, one that failed, couldn't tell or couldn't run holds the merge, and off, it ends neutral. A check that was skipped, because none of its files changed, never holds a merge. For teams: GitHub doesn't let you approve your own PR |
| `codex-version` | `0.166.0` | Codex CLI version |
| `token-server` | Mergelight's | Where to get an app token. Empty means always post as `github-actions[bot]` |
| `server` | | Address of a [Mergelight server](../packages/server/README.md), for the dashboard. Empty means off. With it, each run shows the server GitHub's signed token (repository, branch, workflow, who started it) and, if your org turned the dashboard on, sends the review's numbers and the findings your team declined: title, file and lines, the reason, and who declined it and when. Never code |
| `github-token` | `github.token` | Posts comments and checks |

## Good to know

- **Forks and Dependabot:** GitHub gives their runs no secrets, so the example workflow skips them.
- **Whose plan:** whoever enters the login code decides whose ChatGPT plan pays for reviews, and anyone who can read the repository can see the code. So after connecting, Mergelight posts part of the account's email on the pull request. If it isn't yours, remove the `CODEX_AUTH_JSON` secret and push a commit to connect again.
- **Self-hosted Linux runners:** Codex's sandbox needs unprivileged user namespaces. On GitHub-hosted runners the Action enables them; on your own runners, allow them ahead of time (on Ubuntu 24.04: `kernel.apparmor_restrict_unprivileged_userns=0`). Without them Codex can't read the code, and the review fails instead of guessing from the diff.
- **Time:** a review takes about 2 to 15 minutes depending on the size of the PR, around 7 for a typical one.
- **Same finding, next push:** every review checks what earlier reviews found again, so a finding stays one comment even if it's worded differently or points at other lines.
- **Handled comments:** when a finding's code changed and the finding is gone, or the review drops it after someone resolved its thread, the next review edits that comment to a ✅ with the original behind a dropdown, and moves it to a Handled section in the summary. Nothing new gets posted. Reopen a thread and the comment comes back. GitHub Actions can't react to a thread being resolved, so that shows on the next push.
- **Resolving a thread is a decision:** it tells the next review your team decided to leave that finding, and the review respects that. The one exception is a major bug that can still happen as described: it stays listed and keeps counting toward the check, so resolving a thread can't wave a real bug through. Only resolves by people with write access count.
- **Jobs:** tasks your team writes in `.mergelight/jobs`, such as translating new texts or updating docs, which the AI does on each pull request that needs them and pushes as one commit. Off unless you turn them on. See [Jobs](jobs.md).
- **Fixing findings:** your coding agent can read the findings and mark them handled through the [MCP server and skill](agents.md). No extra workflow permissions: marks are comments under your own login.
- **Resolving threads:** GitHub only lets a token resolve a thread if it may also change the code, and Mergelight's can only read it. So when a finding is fixed, Mergelight folds its comment away instead: GitHub shows "This comment was marked as resolved", with the ✅ and the original behind "Show comment". The thread itself stays open for a person to resolve. If the finding comes back, the comment unfolds. Reopening a folded thread doesn't unfold it; "Show comment" still opens it. To have threads resolved too, give the workflow `contents: write`, but know that the review then holds a token that can push code.
- **Your code:** the review runs inside your own GitHub Actions runner with your own Codex login. Your code and your login are never sent to Mergelight. To post as the Mergelight AI app, a run sends GitHub's signed pass for the run to Mergelight's token server, which keeps nothing; see the [privacy policy](https://mergelight.dev/privacy/).
