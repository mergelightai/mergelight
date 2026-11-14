#!/usr/bin/env bash
# Saves the Codex login as the repository's secret, if it changed since it was last read or saved.
# Run from action.yml, which sets CODEX_HOME, RUNNER_TEMP, SECRET_NAME and optionally SECRETS_TOKEN.
set -euo pipefail

# Only the login this Action set up: a CODEX_HOME from anywhere else, such as a runner's own account, is never saved.
[ "${CODEX_HOME:-}" = "$RUNNER_TEMP/codex-home" ] || exit 0
auth="$CODEX_HOME/auth.json"
seen="$RUNNER_TEMP/codex-auth.sha256"
[ -f "$auth" ] || exit 0
current="$(sha256sum "$auth" | cut -d' ' -f1)"
if [ "$current" = "$(cat "$seen" 2>/dev/null)" ]; then
  echo "The Codex login didn't change."
  exit 0
fi

token="${SECRETS_TOKEN:-}"
if [ -z "$token" ]; then
  out="$RUNNER_TEMP/mergelight-login-token"
  : > "$out"
  TOKEN_SCOPE=login GITHUB_OUTPUT="$out" node "$GITHUB_ACTION_PATH/packages/mergelight/scripts/app-token.mjs"
  token="$(sed -n 's/^token=//p' "$out")"
  rm -f "$out"
fi

if [ -n "$token" ]; then
  GH_TOKEN="$token" gh secret set "$SECRET_NAME" --repo "$GITHUB_REPOSITORY" < "$auth"
  echo "$current" > "$seen"
  echo "Saved the Codex login to $SECRET_NAME."
else
  echo "::warning::Codex has a new login, but it couldn't be saved, so the next run may fail to log in. Install the Mergelight AI app and add \"id-token: write\", or run 'mergelight setup' again with --relogin."
fi
