#!/usr/bin/env bash
# Saves a Claude login made during this run as the repository's secret, so the next run has it.
# Run from action.yml, which sets MERGELIGHT_CLAUDE_TOKEN, RUNNER_TEMP and optionally SECRETS_TOKEN.
set -euo pipefail

[ -n "${MERGELIGHT_CLAUDE_TOKEN:-}" ] || exit 0

token="${SECRETS_TOKEN:-}"
if [ -z "$token" ]; then
  out="$RUNNER_TEMP/mergelight-login-token"
  : > "$out"
  TOKEN_SCOPE=login GITHUB_OUTPUT="$out" node "$GITHUB_ACTION_PATH/packages/mergelight/scripts/app-token.mjs"
  token="$(sed -n 's/^token=//p' "$out")"
  rm -f "$out"
fi

if [ -n "$token" ]; then
  printf '%s' "$MERGELIGHT_CLAUDE_TOKEN" | GH_TOKEN="$token" gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo "$GITHUB_REPOSITORY"
  echo "Saved the Claude login to CLAUDE_CODE_OAUTH_TOKEN."
else
  echo "::warning::Claude connected, but the login couldn't be saved, so the next run asks again. Install the Mergelight AI app and add \"id-token: write\"."
fi
