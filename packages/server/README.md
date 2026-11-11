# Mergelight server

Stores what the Mergelight dashboard shows. Today that is numbers about each review. Memories, rules and settings come next, and the dashboard itself after that.

It is off unless a workflow sets the Action's `server` input, and it stores nothing for an org that hasn't turned the dashboard on.

A run that has the input set does tell the server who it is, even before the server says whether the org is on. It sends GitHub's signed token, which names the repository, the branch, the workflow, the run and who started it. The server reads the ids it needs from it and keeps none of it for an org that isn't on. So only point the input at a server you trust with those names.

## What it stores, and what it never does

Stored, per review: the repository's name and GitHub id, the pull request number, the commit, the light (green, yellow, red), how many findings of each kind, which AI ran it (`codex` or `claude`, and the model's name), how long it took, and the size of the change.

Stored, per rule: its text, its file patterns, where it applies, and the GitHub login and id of who set it.

Stored, per change on the dashboard: who made it, when, and what it was.

Stored, per finding a team declined: its title, the file and lines it was in, the reason the person gave, the GitHub login of who declined it, when, and in which pull request. This is the one place the server holds text about your code. It is what lets a later review leave that finding out.

Never stored, because it is never sent: code, diffs, findings nobody declined, pull request titles, AI logins.

## Rules

A team sets its rules on the dashboard. A review gets them with its other context, and every reviewer and the verifier follow them.

- A rule is one line, for the whole org or for one repository, and can be limited to files that match patterns like `src/billing/**`. A pattern that starts with a slash, like `/Dockerfile`, means the repository's root. A pattern that names a folder covers everything in it, however it is written: `src/billing`, `src/billing/` and `src/billing/**` mean the same, and a bare `migrations` covers a folder of that name anywhere.
- "Always needs a human" names files. A pull request that changes one never goes green by itself: it stops at "needs a human", and the summary says which file. An approval turns it green only when it comes from someone who can push to the repository, and only for the commit they approved. "Needs a human" stops a merge only where the Mergelight check is required and the workflow sets `yellow-blocks: true`. Without that it is a warning on the pull request.
- A rule for the whole org takes an owner of the org. A rule for one repository takes an admin of it. GitHub says who they are at sign-in. If GitHub won't say who owns an org, because the sign-in app may not read its members, nobody can set that org's rules, and repository rules still work.
- A rule is one line of plain text and its patterns are path characters only. It reaches the reviewers as a line of escaped JSON in a block of its own. A rule changes what is worth reporting. It can't change the output format or how text in the diff is treated.
- "Always needs a human" looks at every path a pull request touches, the lockfiles and generated files the reviewers skip included.
- If the server can't be reached, the review runs without the team's rules and says so in its summary. It doesn't change the light for that.
- A review run can only read rules. It can never write one.
- Every rule added or removed, and every decision forgotten, is written to a log with who did it and when. The log can only be added to.
- 50 rules for an org and 50 for each repository at most.

## Memory

When someone marks a finding "won't fix" and says why, the next review of that pull request sends the decision to the server. Later reviews of the same repository get the decisions about files they change, and the verifier leaves those findings out.

- A decision is about one problem in one file. It never covers another file or another kind of problem.
- It reaches the reviewing model as data: one line of escaped JSON in a block of its own, with the rules for using it above the block. Line breaks are taken out before it is stored, so a reason can't start a heading or an instruction of its own.
- Only a decision by someone who can push to the repository is sent, and only a decision written later than the one on file replaces it.
- The verifier reads the code first. If the code changed so the reason no longer fits, it ignores the decision. A major bug that can still happen is reported whatever was decided.
- A decision nobody needed for 90 days is dropped, on a clock, in every repository. A use starts the 90 days again, and a use is only counted when the verifier names the decision as the cause of a rejection in that file. A repository keeps 500 at most.
- The dashboard lists them. Anyone who can push to the repository can make Mergelight forget one. Its text is wiped and a marker stays, so the pull request it came from can't bring it back. A newer decision can.
- Taking a "won't fix" back on GitHub doesn't remove the decision. Forget on the dashboard does.
- A decision made right before a merge is not learned: it is sent by the next review of that pull request, and a merged one gets none.
- One GitHub setting widens who can send a decision. If an org lets pull requests from forks of a private repository run with write tokens, a fork's run can send one too. With that setting on, treat decisions as coming from anyone who can open such a pull request.
- The server takes a run's word for a decision. Someone who can push a branch can send one that nobody made on GitHub. That is the same group of people who can decline a finding for real, and the dashboard shows every decision with its pull request, so a made-up one can be found and removed. A decision is text for the reviewer to weigh, never an instruction to it.

`node dist/admin.js delete <github-account-id>` removes everything stored for an org.

## The dashboard's side

The dashboard page at `mergelight.dev/dashboard` signs a person in with GitHub and shows the server that GitHub token once (`POST /v1/session`). The server asks GitHub who the person is and which repositories they can see, keeps that answer for 15 minutes under a session token of its own, and drops the GitHub token. It is never stored and never logged.

- Sign-in goes through one GitHub App, Mergelight Setup by default (`SIGN_IN_APP`). Only that app's tokens count as a sign-in, and a person sees the orgs and repositories that app is installed on. So a team adds Mergelight Setup to the repositories it wants on the dashboard.
- A person only sees reviews of repositories GitHub shows them. Someone who loses access on GitHub stops seeing them within 15 minutes, when the session runs out and the page signs in again. An org they can't reach looks like one that doesn't exist.
- Sessions live in memory. Nothing about a sign-in is written to the database, and a restart signs everyone out.
- A run's token and a person's session never work on each other's routes.
- Only the sites in `DASHBOARD_ORIGINS` (default `https://mergelight.dev`) can read the answers from a browser.

## How a review talks to it

1. Before the review, Mergelight's program asks `GET /v1/context`. The answer says if the org uses the dashboard. If not, nothing more is sent.
2. The review runs as always.
3. After the review is posted, the program sends its numbers to `POST /v1/reviews`.

The reviewing model takes no part in this. It has no network and no tool for it, and its process can't even ask GitHub for a token.

A server that is down, slow or hostile can't stop or change a review. Each of the two questions gets 10 seconds in all, an answer larger than 64 KB is dropped unread, and a redirect is refused.

## Security

- **No key to store.** A run proves which repository it is with GitHub's OIDC token, like the token server. The server checks GitHub's signature, the issuer, the audience, the expiry and the event.
- **The org comes from the signature.** The org and repository are GitHub's own id numbers from the signed token. Nothing in a request's body or address can choose them. Ids, not names, because a name can be given up and taken by someone else.
- **A token is made for one server.** Its audience is this server's own address (`PUBLIC_URL`), with its path if it is mounted under one. A token made for another Mergelight server is refused, so a server someone else runs can't pass a token on to this one. The token server refuses these tokens too, so nothing that reaches this server can be turned into an app token. This server holds no GitHub key at all.
- **A token works once.** A copied token is worth nothing. The server keeps the used ones in memory, so this holds for one server between restarts. GitHub's tokens expire within minutes, which bounds the rest.
- **Runs aren't trusted.** Someone who can push a branch can change the workflow in their pull request and send anything from it. So a run can read its own org's data and add numbers about its own repository, and nothing else. Every field is checked, and no free text is kept. What is left: such a person can add made-up numbers for their own repository. On a `pull_request` run the pull request number must be the one GitHub signed; a `pull_request_target` run is signed for the base branch, so there it can't be checked.
- **The database keeps orgs apart by itself.** Every table has row-level security, forced for the table's owner too. The server names the org once per request, inside a transaction, and a query that names none sees no rows. The server refuses to start as a database role that can bypass this.
- **Limits.** 8 KB per request, 600 requests a minute per org, 30 seconds per request.
- **Logs** hold error names only. Never a token, a body or a row.

The tests in `test/` try each of these on a real Postgres, including reading and writing another org's rows on purpose.

## Run it

```bash
npm install
npm test                      # starts a throwaway Postgres in Docker, or uses TEST_DATABASE_URL
DATABASE_URL=postgres://... PUBLIC_URL=https://your-server.example npm start
```

`npm start` runs the built files, so run `npm run build` first (`npm test` builds too). The database role must not be a superuser. Tables are created on start. `PUBLIC_URL` is the address workflows reach the server at, and it must match the Action's `server` input.

Until sign-in exists, the operator turns the dashboard on for an org. Either set `CONNECT_ORGS` on the server, as `<github-account-id>:<login>` with commas between orgs, and it is done at each start. Taking an org out of the list doesn't turn it off again: `node dist/admin.js delete` does, and it removes what was stored. Or run the admin command on the server's host:

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
