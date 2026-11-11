# Mergelight server

Stores what the Mergelight dashboard shows and what a review reads before it starts: numbers about each review, the findings a team declined, its rules, its own checks, and the skill folders it picked.

It is off unless a workflow sets the Action's `server` input, and it stores nothing for an org that hasn't turned the dashboard on.

A run that has the input set does tell the server who it is, even before the server says whether the org is on. It sends GitHub's signed token, which names the repository, the branch, the workflow, the run and who started it. The server reads the ids it needs from it and keeps none of it for an org that isn't on. So only point the input at a server you trust with those names.

## What it stores, and what it never does

Stored, per review: the repository's name and GitHub id, the pull request number, the commit, the light (green, yellow, red), how many findings of each kind, which AI ran it (`codex` or `claude`, and the model's name), how long it took, and the size of the change.

Stored, per rule: its text, its file patterns, where it applies, and the GitHub login and id of who set it.

Stored, per skill a team picked: the path of its folder in the repository, and the GitHub login and id of who picked it. The skill's text is never sent: it stays in the repository.

Stored, per check a team wrote: its name, its text, its file patterns, and the GitHub login and id of who set it. The answers to a check are not stored: they go to the pull request on GitHub.

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

## Skills

A team that already wrote skills for Claude Code or Codex can use them in reviews. An admin of a repository names a skill's folder on the dashboard, the one that holds its `SKILL.md`, like `.claude/skills/migrations`. The path of the `SKILL.md` itself works too.

- The server stores the folder's path and nothing else. A review gets the list of paths with its other context.
- The review copies each folder from the branch the pull request merges into, as that branch is now. Never from the pull request itself, and not from the commit it branched from, which its author picks. So a pull request can't rewrite the skill that reviews it, can't add one, and can't go back to an older one. A folder with no `SKILL.md` on that branch is skipped.
- Only ordinary text files are copied. A link is never followed: not one inside the folder, and not a folder that is itself a link, so name the real folder. A picture or a file over 60 KB is left out, and a skill is 30 files and 200 KB at most. A skill whose `SKILL.md` can't be read is left out whole.
- The copies go to `.mergelight/skills/` in the review's checkout. Whatever the pull request put at that place is removed first, and a link there is never written through.
- Every reviewer and the verifier get each skill's name and description, as a line of escaped JSON in a block of its own, and read the skill's file when the pull request touches its area. A skill says what matters in its area. It can't change the output format or how text in the diff is treated.
- A path is letters, digits and `/ . - _ @ +` only. No wildcards and no `..`.
- Picking or removing a skill takes an admin of that repository, and each change is written to the log. 10 skills for each repository at most.
- A review run can only read the list. It can never write to it.
- If the server can't be reached, the review runs without the skills.
- The copy can't stop or hold up a review. A git call that hangs is given up after 20 seconds and the whole copy after a minute, and the review then runs without the skills that weren't read. Its log says how many were left out.

## Checks

A team writes a check in plain words, like "Every new text in en.json has a translation in da.json", and names the files it is about. Each review asks the AI that one question in a run of its own, and posts the answer on the pull request as a check named `Mergelight: <name>`.

- A check passes or fails. A failed one lists the places that break it, with file and line. When the AI couldn't see enough to tell, the check says "Couldn't tell" and asks for a person: it is never taken for a pass.
- A check runs only when a pull request changes a file that matches its patterns. Otherwise it is posted as skipped, and no AI run is spent.
- Each check that runs is one more AI run on the team's own plan. A repository has 5 at most, and 2 run at a time.
- A check reports. It never changes code, and it doesn't change the light of the Mergelight check. It does hold back Mergelight's own approval of the pull request: a green review approves only when every check passed or was skipped, and the dismissal names the check. A review that ran without the team's rules and checks, because the server couldn't be reached, doesn't approve either. To make it stop a merge, require `Mergelight: <name>` in the branch rules on GitHub, and pick the app that posts it as the check's source, so nothing else can post a check of that name.
- If the AI run for a check fails, its answer can't be read, or the review itself couldn't run, the check says "Couldn't run". "Couldn't tell" and "Couldn't run" are posted as "action required", not as neutral. Why: GitHub lets a neutral check through a branch rule, so the author of a pull request could get past a required check by making its run fail. A team that requires the check then runs the review again or pushes.
- This differs from the Mergelight check itself, which ends neutral when a review couldn't run.
- A check gets 6 minutes, and all checks together 12. One that takes longer ends as "Couldn't run". The review itself never waits for its checks beyond that, and a review that fails stops the checks that were waiting for their turn.
- A check reads the whole change to its own files, lockfiles and generated files included. The reviewers' diff leaves those out.
- For a check, the repository's instruction files such as `AGENTS.md` and `CLAUDE.md` are data. They are read from the pull request's own checkout, so its author must not be able to say there what counts as a pass. Codex loads `AGENTS.md`, and the skills under `.codex/skills` and `.agents/skills`, by itself. For a check it is started with both switched off, where the installed Codex has the switch for skills.
- A check is an instruction to the AI, so setting or removing one takes an admin of that repository, and each change is written to the log. A review run can only read the checks.
- Its name is letters, digits and single spaces, with `. _ -` inside, 40 characters at most. Its text is one line, 500 characters at most. Both are checked on the server and again in the run. The text reaches the AI as a line of escaped JSON in a block of its own, and it can't change the output format or how text in the diff is treated.
- What the AI answers is cut to size and written as plain text before it goes on GitHub: it can't post a link, a picture, a mention or markup under Mergelight's name. The check's own text is shown as code, for the same reason.
- If the server can't be reached, the review runs without the checks, and none is posted for that commit.

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
