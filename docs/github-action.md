# Mergelight GitHub Action

Reviews every pull request with your own Claude or Codex login and posts:

- **One summary comment**, kept up to date on every push: what the PR does, what's worth fixing, what's your call, and what was left alone on purpose.
- **Inline comments** for the few findings a senior reviewer would hold the merge for, at most 3 per review, each with how it happens, what breaks and the smallest fix. Anything else worth fixing is listed in the summary.
- **A live check** called **Mergelight**. It shows "Reviewing" while it works, then:
  - 🟢 **Safe to merge:** success.
  - 🟡 **Needs a human:** neutral, so it doesn't block the merge. Read it and decide. It turns green if someone approves the PR.
  - 🔴 **Blocked:** a bug that must be fixed. Approving doesn't change it; fixing does.

If the review itself can't run, for example because the login expired, the check ends neutral so it doesn't block merging, and the workflow job fails so you notice.

## Which login to use

| Login | Repositories | Cost |
|---|---|---|
| **ChatGPT login** (`codex-auth-json`) | Any | Your ChatGPT plan |
| **OpenAI API key** (`openai-api-key`) | Any | Billed per use |
| **Claude plan** (`claude-code-oauth-token`) | Any | Your Claude plan |
| **Anthropic API key** (`anthropic-api-key`) | Any | Billed per use |

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

**To get each release by itself instead,** use `@v0`, which the files in `examples/` do, or run `mergelight setup owner/repo --no-pin`. `v0` moves to a release a day after it's published, so a bad one can be pulled first, but you're trusting each release as it comes. To get update pull requests from Dependabot, add this to `.github/dependabot.yml`:

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

**Optional: make it required.** In branch protection or a ruleset, require the **Mergelight** check. 🔴 then blocks the merge. 🟡 doesn't, unless your team sets `yellow-blocks: true` to make it wait for an approval.

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

## Inputs

| Input | Default | What it does |
|---|---|---|
| `codex-auth-json` | | ChatGPT login. Unset, the pull request shows a link to connect |
| `openai-api-key` | | OpenAI API key |
| `secrets-token` | | Only without the app: a token that can update secrets, to save refreshed logins |
| `auth-secret-name` | `CODEX_AUTH_JSON` | The secret the refreshed login is saved to |
| `model` | Codex default | Model to review with |
| `effort` | `high` | Reasoning effort: `low`, `medium` or `high` |
| `verify-with` | `codex` | Who checks the findings: `codex`, or `claude` on a runner with Claude Code logged in |
| `yellow-blocks` | `false` | Make a 🟡 check wait for an approval. For teams: GitHub doesn't let you approve your own PR |
| `codex-version` | `0.166.0` | Codex CLI version |
| `token-server` | Mergelight's | Where to get an app token. Empty means always post as `github-actions[bot]` |
| `github-token` | `github.token` | Posts comments and checks |

## Good to know

- **Forks and Dependabot:** GitHub gives their runs no secrets, so the example workflow skips them.
- **Whose plan:** whoever enters the login code decides whose ChatGPT plan pays for reviews, and anyone who can read the repository can see the code. So after connecting, Mergelight posts part of the account's email on the pull request. If it isn't yours, remove the `CODEX_AUTH_JSON` secret and push a commit to connect again.
- **Self-hosted Linux runners:** Codex's sandbox needs unprivileged user namespaces. On GitHub-hosted runners the Action enables them; on your own runners, allow them ahead of time (on Ubuntu 24.04: `kernel.apparmor_restrict_unprivileged_userns=0`). Without them Codex can't read the code, and the review fails instead of guessing from the diff.
- **Time:** a review takes about 2 to 15 minutes depending on the size of the PR, around 7 for a typical one.
- **Same finding, next push:** every review checks what earlier reviews found again, so a finding stays one comment even if it's worded differently or points at other lines.
- **Handled comments:** when a finding's code changed and the finding is gone, or the review drops it after someone resolved its thread, the next review edits that comment to a ✅ with the original behind a dropdown, and moves it to a Handled section in the summary. Nothing new gets posted. Reopen a thread and the comment comes back. GitHub Actions can't react to a thread being resolved, so that shows on the next push.
- **Resolving a thread is a decision:** it tells the next review your team decided to leave that finding, and the review respects that. The one exception is a major bug that can still happen as described: it stays listed and keeps counting toward the check, so resolving a thread can't wave a real bug through. Only resolves by people with write access count.
- **Fixing findings:** your coding agent can read the findings and mark them handled through the [MCP server and skill](agents.md). No extra workflow permissions: marks are comments under your own login.
- **Resolving threads:** GitHub only lets a workflow mark a thread resolved with `contents: write`, so the example workflow leaves that to you and fixed threads just collapse as outdated. The ✅ and the dropdown work either way. To have them resolved too, add `contents: write` to the workflow's permissions.
- **Your code:** the review runs inside your own GitHub Actions runner with your own Codex login. Nothing is sent to Mergelight.
