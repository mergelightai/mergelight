# Mergelight GitHub Action

Reviews every pull request with your own Codex login and posts:

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
| **ChatGPT login** (`codex-auth-json`) | Private only | Your ChatGPT plan |
| **OpenAI API key** (`openai-api-key`) | Any | Billed per use |

OpenAI allows a ChatGPT login in CI only for trusted private automation, and says not to use it for public or open source repositories. The Action refuses a ChatGPT login on a public repository. See [OpenAI's guide](https://learn.chatgpt.com/docs/auth/ci-cd-auth).

## Setup with a ChatGPT login

**1. Make a login just for CI.** Don't copy your own `~/.codex/auth.json`: one login used on two machines breaks when either one refreshes it.

```bash
mkdir -p ~/.codex-ci && printf 'cli_auth_credentials_store = "file"\n' > ~/.codex-ci/config.toml
```

```bash
CODEX_HOME=~/.codex-ci codex login
```

Check that `~/.codex-ci/auth.json` has `"auth_mode": "chatgpt"` and a `refresh_token`.

**2. Store it as a secret,** then delete the local copy so only CI uses it:

```bash
gh secret set CODEX_AUTH_JSON --repo owner/repo < ~/.codex-ci/auth.json && rm -rf ~/.codex-ci
```

**3. Let CI save refreshed logins.** Codex refreshes the login about every 8 days. Create a [fine-grained token](https://github.com/settings/personal-access-tokens/new) for this repository with **Secrets: Read and write**, and store it:

```bash
gh secret set MERGELIGHT_SECRETS_TOKEN --repo owner/repo
```

Without it, reviews work until the first refresh, then the login has to be redone by hand.

**4. Add the workflows.** Copy the three files in [`examples/`](../examples) to `.github/workflows/`:

- [`mergelight.yml`](../examples/mergelight.yml) reviews every non-draft PR from this repository, and cancels an older review of the same PR when you push again.
- [`mergelight-approve.yml`](../examples/mergelight-approve.yml) turns a 🟡 check green when someone approves the PR. Skip it if you work alone: GitHub doesn't let you approve your own PR.
- [`mergelight-refresh.yml`](../examples/mergelight-refresh.yml) uses the login every third day so it stays fresh.

They're separate files so a PR's merge box only shows the review, not skipped jobs.

**5. Install the app.** [Install Mergelight AI](https://github.com/apps/mergelight-ai/installations/new) on the repository, so comments and checks carry its name and logo. There's no key to manage: the workflow's `id-token: write` permission proves which repository it runs in, and Mergelight's token server returns a short-lived token for that repository only. It can post comments and checks, read code, and can't push. Skip this and everything still works, posted as `github-actions[bot]`.

**6. Optional: make it required.** In branch protection or a ruleset, require the **Mergelight** check. 🔴 then blocks the merge. 🟡 doesn't, unless your team sets `yellow-blocks: true` to make it wait for an approval.

## Inputs

| Input | Default | What it does |
|---|---|---|
| `codex-auth-json` | | ChatGPT login (private repositories) |
| `openai-api-key` | | OpenAI API key (any repository) |
| `secrets-token` | | Token that can update secrets, to save refreshed logins |
| `auth-secret-name` | `CODEX_AUTH_JSON` | The secret the refreshed login is saved to |
| `model` | Codex default | Model to review with |
| `effort` | `high` | Reasoning effort: `low`, `medium` or `high` |
| `verify-with` | `codex` | Who checks the findings: `codex`, or `claude` on a runner with Claude Code logged in |
| `yellow-blocks` | `false` | Make a 🟡 check wait for an approval. For teams: GitHub doesn't let you approve your own PR |
| `codex-version` | `0.166.0` | Codex CLI version |
| `token-server` | Mergelight's | Where to get an app token. Empty means always post as `github-actions[bot]` |
| `github-token` | `github.token` | Posts comments and checks |

## Good to know

- **Forks:** PRs from forks get no secrets, so the example workflow skips them.
- **Self-hosted Linux runners:** Codex's sandbox needs unprivileged user namespaces. On GitHub-hosted runners the Action enables them; on your own runners, allow them ahead of time (on Ubuntu 24.04: `kernel.apparmor_restrict_unprivileged_userns=0`). Without them Codex can't read the code, and the review fails instead of guessing from the diff.
- **Time:** a review takes about 2 to 15 minutes depending on the size of the PR, around 7 for a typical one.
- **Same finding, next push:** every review checks what earlier reviews found again, so a finding stays one comment even if it's worded differently or points at other lines.
- **Handled comments:** when a finding's code changed and the finding is gone, or the review drops it after someone resolved its thread, the next review edits that comment to a ✅ with the original behind a dropdown, and moves it to a Handled section in the summary. Nothing new gets posted. Reopen a thread and the comment comes back. GitHub Actions can't react to a thread being resolved, so that shows on the next push.
- **Resolving a thread is a decision:** it tells the next review your team decided to leave that finding, and the review respects that. The one exception is a major bug that can still happen as described: it stays listed and keeps counting toward the check, so resolving a thread can't wave a real bug through. Only resolves by people with write access count.
- **Fixing findings:** your coding agent can read the findings and mark them handled through the [MCP server and skill](agents.md). No extra workflow permissions: marks are comments under your own login.
- **Resolving threads:** GitHub only lets a workflow mark a thread resolved with `contents: write`, so the example workflow leaves that to you and fixed threads just collapse as outdated. The ✅ and the dropdown work either way. To have them resolved too, add `contents: write` to the workflow's permissions.
- **Your code:** the review runs inside your own GitHub Actions runner with your own Codex login. Nothing is sent to Mergelight.
