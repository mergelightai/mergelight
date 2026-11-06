# Mergelight token server

Lets a workflow post as the Mergelight AI GitHub App, without anyone but this server holding the App's private key.

1. A workflow with `id-token: write` asks GitHub for an OIDC token, which proves which repository it runs in.
2. It sends that token to `POST /token`.
3. The server checks GitHub's signature, the issuer, the audience (`mergelight`), the expiry and the event.
4. If the App is installed on that repository, the server returns an App token limited to that one repository, with `checks: write`, `pull_requests: write` and `contents: read`. The token can't push code, and GitHub expires it after an hour.

A second kind of token, `POST /token?scope=login`, can only write Actions secrets. The Action asks for it only when Codex refreshed its login, to save the new one back. GitHub never lets it read a secret's value.

The server stores nothing, and never sees code or model logins. If it's down or the App isn't installed, the Action posts as `github-actions[bot]`.

## Run it

```bash
npm test
GITHUB_APP_CLIENT_ID=... GITHUB_APP_PRIVATE_KEY="$(cat key.pem)" npm start
```

It has no dependencies. In production it runs on Render, set up by `render.yaml` at the repository root.

Keep the private key out of any account other people can reach. It can act on every repository the App is installed on.
