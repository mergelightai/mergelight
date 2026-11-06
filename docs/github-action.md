# Mergelight GitHub Action

Reviews every pull request with your own Codex login and posts:

- **One summary comment**, kept up to date on every push: what the PR does, what's worth fixing, what's your call, and what was left alone on purpose.
- **Inline comments** for the few findings a senior reviewer would hold the merge for, at most 3 per review, each with how it happens, what breaks and the smallest fix. Anything else worth fixing is listed in the summary.
- **A live check** called **Mergelight**. It shows "Reviewing" while it works, then:
  - 🟢 **Safe to merge:** success.
  - 🟡 **Needs a human:** action required. It turns green when someone approves the PR.
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
- [`mergelight-approve.yml`](../examples/mergelight-approve.yml) turns a 🟡 check green when someone approves the PR.
- [`mergelight-refresh.yml`](../examples/mergelight-refresh.yml) uses the login every third day so it stays fresh.

They're separate files so a PR's merge box only shows the review, not skipped jobs.

**5. Optional: make it required.** In branch protection or a ruleset, require the **Mergelight** check. 🔴 then blocks the merge, and 🟡 waits for an approval.

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
| `codex-version` | `0.166.0` | Codex CLI version |
| `github-token` | `github.token` | Posts comments and checks |

## Good to know

- **Forks:** PRs from forks get no secrets, so the example workflow skips them.
- **Self-hosted Linux runners:** Codex's sandbox needs unprivileged user namespaces. On GitHub-hosted runners the Action enables them; on your own runners, allow them ahead of time (on Ubuntu 24.04: `kernel.apparmor_restrict_unprivileged_userns=0`). Without them Codex can't read the code, and the review fails instead of guessing from the diff.
- **Time:** a review takes about 2 to 15 minutes depending on the size of the PR, around 7 for a typical one.
- **Same finding, next push:** every review checks what earlier reviews found again, so a finding stays one comment even if it's worded differently or points at other lines. A Mergelight thread is resolved when its code changed and the finding is gone.
- **Your code:** the review runs inside your own GitHub Actions runner with your own Codex login. Nothing is sent to Mergelight.
