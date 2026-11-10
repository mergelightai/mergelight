# Mergelight server

Stores what the Mergelight dashboard shows. Today that is numbers about each review. Memories, rules and settings come next, and the dashboard itself after that.

It is off unless a workflow sets the Action's `server` input, and it stores nothing for an org that hasn't turned the dashboard on.

## What it stores, and what it never does

Stored, per review: the repository's name and GitHub id, the pull request number, the commit, the light (green, yellow, red), how many findings of each kind, which AI ran it (`codex` or `claude`, and the model's name), how long it took, and the size of the change.

Never stored, because it is never sent: code, diffs, finding text, file paths, pull request titles, AI logins.

`node dist/admin.js delete <github-account-id>` removes everything stored for an org.

## How a review talks to it

1. Before the review, Mergelight's program asks `GET /v1/context`. The answer says if the org uses the dashboard. If not, nothing more is sent.
2. The review runs as always.
3. After the review is posted, the program sends its numbers to `POST /v1/reviews`.

The reviewing model takes no part in this. It has no network and no tool for it, and its process can't even ask GitHub for a token.

A server that is down, slow or hostile can't stop or change a review. Each of the two questions gets 10 seconds in all, an answer larger than 64 KB is dropped unread, and a redirect is refused.

## Security

- **No key to store.** A run proves which repository it is with GitHub's OIDC token, like the token server. The server checks GitHub's signature, the issuer, the audience, the expiry and the event.
- **The org comes from the signature.** The org and repository are GitHub's own id numbers from the signed token. Nothing in a request's body or address can choose them. Ids, not names, because a name can be given up and taken by someone else.
- **A token is made for one server.** Its audience is this server's own address (`PUBLIC_URL`). A token made for another Mergelight server is refused, so a server someone else runs can't pass a token on to this one. The token server refuses these tokens too, so nothing that reaches this server can be turned into an app token. This server holds no GitHub key at all.
- **A token works once.** A copied token is worth nothing. The server keeps the used ones in memory, so this holds for one server between restarts. GitHub's tokens expire within minutes, which bounds the rest.
- **Runs aren't trusted.** Someone who can push a branch can change the workflow in their pull request and send anything from it. So a run can read its own org's data and add numbers about its own repository, and nothing else. Every field is checked, and no free text is kept.
- **The database keeps orgs apart by itself.** Every table has row-level security, forced for the table's owner too. The server names the org once per request, inside a transaction, and a query that names none sees no rows. The server refuses to start as a database role that can bypass this.
- **Limits.** 8 KB per request, 120 requests a minute per org, 30 seconds per request.
- **Logs** hold error names only. Never a token, a body or a row.

The tests in `test/` try each of these on a real Postgres, including reading and writing another org's rows on purpose.

## Run it

```bash
npm install
npm test                      # starts a throwaway Postgres in Docker, or uses TEST_DATABASE_URL
DATABASE_URL=postgres://... PUBLIC_URL=https://your-server.example npm start
```

`npm start` runs the built files, so run `npm run build` first (`npm test` builds too). The database role must not be a superuser. Tables are created on start. `PUBLIC_URL` is the address workflows reach the server at, and it must match the Action's `server` input.

Until sign-in exists, turn the dashboard on for an org from the server's host:

```bash
gh api users/<login> --jq .id
DATABASE_URL=postgres://... node dist/admin.js connect <github-account-id> <login>
```

Then set the Action's input in the workflow:

```yaml
- uses: mergelightai/mergelight@v0
  with:
    server: https://your-server.example
```

`packages/token-server` must sit beside this folder: the OIDC check is shared with it.
