# Security and data

Mergelight reviews your pull requests inside your own GitHub Actions, with your own AI login. This page says where your code goes, what the AI can and can't do, what reaches Mergelight, and where the limits are.

## The short version

- **Reviews run in your own GitHub Actions runner.** From there, Codex or Claude Code sends your code to OpenAI or Anthropic, under your own account.
- **Your code, your diffs and your AI login never reach Mergelight.** By default, Mergelight only sees GitHub's signed pass for each run, so it can give the run a token to post with.
- **The AI can only read.** Claude gets file tools and no shell. Codex runs its commands in a sandbox that can't write or reach the network. Neither can search the web, and neither loads instructions from the pull request.
- **The review never pushes code.** Its GitHub token can read code and post comments and checks. Only the opt-in [Jobs](jobs.md) feature pushes, from a separate step that runs no AI.
- **Mergelight keeps data only for an organization that uses the dashboard.** Then it stores review numbers, the findings your team declined with their reasons, and your team's rules, checks and skills. Never code.

## Where your code goes

A review runs in your repository's GitHub Actions runner: one of GitHub's machines, or your own. There, Mergelight's program checks out the pull request and starts Codex or Claude Code with the login you saved as a secret: a ChatGPT or Claude plan, or an OpenAI or Anthropic API key. That program sends the diff, and the code it reads, to OpenAI or Anthropic under your account and their terms. Mergelight isn't part of that connection.

### What reaches Mergelight

When a review runs, by default one thing reaches Mergelight: GitHub's signed pass for the run. This pass is an OIDC token, a short-lived token that GitHub signs for each workflow run so the run can prove where it runs. The run sends it to Mergelight's token server, which answers with a GitHub token so the review can post as the Mergelight AI app.

The pass names the repository, its owner, the GitHub account that started the run, the branch, the commit, the event, the workflow and the run. The token server checks it, keeps nothing, and never sees code or AI logins.

Never sent to Mergelight:

- Your source code and your diffs.
- Your Claude or ChatGPT login, your API keys, and your other secrets.
- Pull request titles and descriptions, and what the AI writes about your code. The one exception is a finding your team declines with a reason, when your organization uses the [dashboard server](#the-dashboard-server-optional).

To leave Mergelight out completely, set the Action's `token-server` and `server` inputs to empty in every Mergelight workflow. Reviews then post as `github-actions[bot]`, and saving a new or refreshed AI login to your secret needs a `secrets-token` (see [Inputs](github-action.md#inputs)).

The [privacy policy](https://mergelight.dev/privacy/) lists all the data, including what the setup page and the dashboard send when you sign in, and how long it is kept.

## What the AI can do during a review

A review only needs to read code, so that is all the AI gets.

**Claude Code** starts with:

- Three file tools, `Read`, `Grep` and `Glob`, kept inside the review's copy of the code. No shell, no web search and no web fetch.
- Plugins, hooks, MCP servers, skills and the automatic loading of `CLAUDE.md` switched off.
- Every action that would ask for a permission denied.

**Codex** starts with:

- A sandbox for its shell commands that can read files, but can't write them or reach the network. The folder that holds the ChatGPT login is hidden from those commands.
- Web search off.
- Plugins, apps, hooks, image generation, browser use, computer use, notifications and every MCP server off.
- `AGENTS.md` from the checkout not loaded. Mergelight also removes the skill folders `.agents/skills` and `.codex/skills` from the review's copy of the code, so a pull request can't plant a skill there.

**Both:**

- Neither program saves its session to disk.
- The AI's process gets no GitHub token. Mergelight removes GitHub's tokens from its environment, including the ones it would need to ask GitHub for a signed pass.

Mergelight tested the network block on macOS, with the same settings a review uses. Told to reach the internet, Codex's commands couldn't connect, Claude had no tool that could try, and a test server on the same machine got no requests.

## Prompt injection

Prompt injection is text written to make an AI follow it instead of its real instructions. A pull request can hide such text anywhere, so Mergelight treats everything in it as data.

- **The prompt says so.** The AI is told that text in the diff, in code comments and in the pull request description is data, and to ignore any instructions in it. The same goes for your team's answers in comments, earlier findings and decisions your team made before.
- **What steers the review comes from the base branch.** The base branch is the branch the pull request merges into. Mergelight reads your instruction files (`AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md` and the like), your [rule files](github-action.md#rules-in-your-repository), your skill folders and your [jobs](jobs.md) from there, never from the pull request. So a pull request can't add, change or remove the instructions that review it. The pull request's own copies of those files are reviewed as code.
- **Rules, checks and skills written on the dashboard aren't in the repository,** so a pull request can't change them either.
- **The AI answers in a fixed form.** It returns JSON that must match a fixed schema. Mergelight's own program reads that answer and posts the comments and checks. The AI can't post anything itself.
- **Secrets are taken out before posting.** Before an answer goes on GitHub, Mergelight removes the AI logins and API keys the run holds from it, and any text shaped like a login token.

## Tokens and permissions

### The review's GitHub token

1. The workflow has the `id-token: write` permission, so the run can ask GitHub for its signed pass.
2. Mergelight's token server checks the pass: GitHub's signature, with the algorithm fixed to RS256, the issuer, the audience `mergelight`, the expiry, and the event. Only pull request, review and comment events get a token.
3. It asks GitHub for a Mergelight AI app token for that one repository, with `checks: write`, `pull_requests: write` and `contents: read`. GitHub expires it after one hour.

So the review can't push code: its token can read code and write comments, reviews and checks. You store no key or password for this, because the pass proves the repository. If the app isn't installed or the token server can't be reached, the run posts as `github-actions[bot]` with the workflow's own token, whose permissions your workflow file sets.

A second kind of token can only write this repository's Actions secrets. The Action asks for it only to save a new or refreshed AI login back to your repository's secret. GitHub never lets it read a secret's value.

A green review can approve the pull request as the Mergelight AI app (see [Approvals](how-it-works.md#approvals)). That approval doesn't count toward a branch rule's required approvals, because GitHub only counts approvals from accounts that can push. So where a branch rule asks for an approval, a person still gives it. Set `auto-approve: false` to turn Mergelight's approval off.

### The two GitHub Apps

- **Mergelight AI** posts the reviews. It reads code, writes comments and checks, and overwrites this repository's Actions secrets to save a new or refreshed AI login. It can't commit. Its private key is on Mergelight's token server. The dashboard signs you in through it.
- **Mergelight Setup** can commit code and workflows. The setup page uses it, with your own GitHub sign-in in your browser, to open the pull request that adds Mergelight. No private key exists for it, so it can't act unless you're signed in. You don't need it if you add the files by hand.

There are two apps so that a leak on Mergelight's server can't change your code or your workflows.

### Versions

The setup page and `mergelight setup` pin your workflow to the commit of a release. The Mergelight step can read your AI login, so new Mergelight code runs in your repository only after you merge an update. The review says when a newer release is out.

The files in [`examples/`](../examples) use the `@v0` tag instead, which moves to each new release by itself. Then you trust each release as it comes. The Action also pins the actions it uses to a commit, and installs set versions of Codex and Claude Code.

## Who counts

Mergelight acts on what people write on a pull request, so it checks who wrote it. "Can push" means GitHub gives the person write or admin access to the repository.

- **A comment that mentions `@mergelight-ai`** starts a review only when GitHub says its author can push. If GitHub can't say, nothing starts. Comments by bots, and comments on a pull request from a fork, start nothing.
- **A resolved thread** counts as your team's decision only when the person who resolved it can push.
- **A "fixed" or "won't fix" mark** from your [coding agent](agents.md) counts when its author can push, or is a bot account. A mark from someone GitHub says can't push is ignored.
- **An approval** turns a "Needs a human" check green only when the approver can push, and only for the commit they approved.
- **A decision** goes to the dashboard server only when GitHub says its author can push. Being a member of the organization isn't enough.
- **Pull requests from forks and from Dependabot** aren't reviewed and run no jobs, because GitHub gives their runs no secrets.

No mark, resolved thread or comment hides a major bug that can still happen: it stays listed and keeps counting toward the check.

## The dashboard server (optional)

The Mergelight server holds what the [dashboard](https://mergelight.dev/dashboard/) shows, and what a review reads before it starts. It's off unless your workflow sets the Action's `server` input.

With `server` set, Mergelight's program talks to it before the AI starts and after the review is posted. The AI takes no part.

1. First the run shows the server GitHub's signed pass. The server reads the ids it needs, and keeps nothing for an organization that hasn't turned the dashboard on. So only point the input at a server you trust with your repository, branch and user names.
2. If your organization uses the dashboard, the run then sends the review's numbers and the findings your team declined.

### What it stores

- **Numbers for each review:** the repository's name and id, the pull request number, the commit, the result, how many findings of each kind, which AI and model ran, how long it took and the size of the change.
- **Declined findings:** the title, file and lines, the reason, who declined it, when, and in which pull request. This is the only text about your code it holds. A decision nobody needed for 90 days is deleted.
- **Your team's rules, checks and written skills,** with who set them. For a skill folder picked from your repository, only its path.
- **A log of changes** that can't be edited: who changed what, and when.

Never stored: code, diffs, findings nobody declined, pull request titles, AI logins.

### How it keeps data apart

- **Identity comes from GitHub's signature.** The organization and the repository are GitHub's numeric ids from the signed pass, and nothing in a request can choose them. Ids, not names, because a name can be given up and taken by someone else.
- **A pass works for one server.** It is made for that server's own address. Another server refuses it, and so does the token server, so a pass sent to the dashboard server can never become a GitHub token.
- **The database keeps organizations apart by itself.** Every table has row-level security: a database rule that shows each request only the rows of its own organization. It holds for the table's owner too, and the server refuses to start as a database role that could skip it.
- **The server holds no GitHub key.**
- **A review run can only read your rules, checks and skills.** Setting one takes an admin of the repository, or an owner of the organization for a rule that covers every repository.
- **A server that is down or slow can't stop a review.** Each question to it gets 10 seconds. The review then runs without your team's rules, checks and skills, and says so.

### Signing in and deleting

You sign in to the dashboard with GitHub. The server uses your GitHub token once, to learn who you are and which repositories you can see, then drops it. It never stores or logs it. Your session is a key of its own that lasts 15 minutes, held in the server's memory. You only see repositories that GitHub shows you.

An owner of the organization can delete all of its data on the dashboard, under Settings. It goes at once, the log of changes too. You can also write to hello@mergelight.dev.

## Jobs: the one feature that pushes code

[Jobs](jobs.md) is a separate, opt-in feature: tasks your team writes in `.mergelight/jobs/`, which the AI does on each pull request that needs them. It is the one place Mergelight pushes code. A repository with the plain workflow runs no jobs, and holds no token that can push.

- **The AI never holds a token that can push.** It runs in one GitHub Actions job with a token that can only read. A second job, with no AI and no AI login, checks the change and pushes it. The two never share a machine.
- **One commit, to the pull request's own branch only.** Never to the default branch or a protected branch, and never with force. GitHub refuses the commit if the branch moved on in the meantime.
- **Only the files the job names.** The program checks every changed file against the job's `may-change` list, and the push step checks them all again against the jobs on the base branch.
- **Some files no job can change,** whatever it says: anything under `.github` or `.mergelight`, `CODEOWNERS`, CI files, the files AI agents take instructions from, skills, links and files that can run. See the full list in [Jobs](jobs.md#safety).
- **Jobs come from the base branch,** so a pull request can't add or change a job for itself. Pull requests from forks and from Dependabot run no jobs.
- **Every commit a job makes is reviewed,** and you merge it like any other.

Before any job runs, the jobs step asks Mergelight's server whether Jobs is on for your organization. It shows the server GitHub's signed pass for the run, and nothing about your code.

## Limits

- **The AI can't look anything up on the web,** such as a library's docs. That is the cost of giving it no network.
- **Your AI provider sees your code.** OpenAI or Anthropic get the code the AI reads, under your account and their terms.
- **A pull request's workflow file runs as that pull request has it,** as GitHub does for every `pull_request` workflow. So a person who can push a branch can change how the review runs on their own pull request, or turn it off there.
- **The dashboard server takes a run's word for its own repository.** Someone who can push a branch can send made-up review numbers or decisions for their own repository, and no other. The dashboard shows each decision with its pull request, so you can find a made-up one and forget it.
- **On a self-hosted runner, keep other secrets and other repositories' code off the machine that runs reviews.** The AI reads code on that machine, and a review is only as private as the machine it runs on.
- **The code that connects a ChatGPT login shows on the pull request,** so anyone who can read the repository can enter it, and so choose whose plan pays for reviews. Mergelight posts part of that account's email on the pull request, so you can check it.

## Report a security problem

Write to hello@mergelight.dev with what you found and how to see it happen. Please write there first, not in a public issue, so a fix can ship before the problem is public.
