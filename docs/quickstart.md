# Get started

Turn on Mergelight for one GitHub repository and see its first review on a real pull request. It all happens in your browser, on the setup page at [mergelight.dev/setup](https://mergelight.dev/setup/).

## What you need

- **A GitHub repository** where you can open pull requests and install GitHub apps. In an organization, an owner may have to approve the apps: GitHub emails them a request, and you finish once they have.
- **One AI login**, from this list:

| Login | How you connect it | Who bills you |
|---|---|---|
| ChatGPT plan | Enter a code at OpenAI | Your ChatGPT plan |
| Claude plan | Confirm on Claude's page, then paste a code into the setup page | Your Claude plan |
| OpenAI API key | Save it as a repository secret | OpenAI, per use |
| Anthropic API key | Save it as a repository secret | Anthropic, per use |

- **ChatGPT plan:** first turn on "Enable device code sign-in" in your [ChatGPT security settings](https://chatgpt.com/settings/security). It's in beta, and on a workspace an admin turns it on.
- **Claude plan:** reviews run on Opus, which uses a lot of a Claude plan. On a small plan, a few reviews can use up the week.

You install nothing on your computer.

## Set it up

Open [mergelight.dev/setup](https://mergelight.dev/setup/) and choose **Continue with GitHub**. Then:

1. **Pick a repo.** The first time, the page sends you to GitHub to choose which repositories Mergelight can see, which installs the **Mergelight Setup** app. To add one later, choose **Don't see your repo? Add it on GitHub**.
2. **Install Mergelight AI,** if the page asks for "One more install". Your repository is already selected, so approve it on GitHub and come back.
3. **Add Mergelight.** If the repository has more than one long-lived branch, such as `main` and `staging`, choose what it reviews: **New work** (pull requests into one branch) or **Every PR**. Then choose the **Add to** button with your repository's name. The page opens a pull request called "Add Mergelight code review", with your own sign-in. It adds small files to `.github/workflows/`: the review, a job that turns a 🟡 check green when someone approves, and, for a ChatGPT plan, a job that keeps the login fresh. **View file** shows them first. If GitHub refuses, the page offers GitHub's editor with the file filled in.
4. **Connect your AI,** if the repository has no login yet. Choose **Your plan** or **API key**, then the AI:
   - **ChatGPT:** the page shows a code, which is also on the pull request. Choose **Open OpenAI** and enter it. The code lasts 15 minutes: if it runs out, push a new commit to the pull request to get a new one.
   - **Claude:** choose **Open Claude** and confirm there. Then paste the code Claude shows you into the page and choose **Connect**.
   - **API key:** choose **Open GitHub secrets** and add the key as `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. Then push any commit to the pull request.
5. **Watch the first review.** It runs on that same pull request, so you see what a review looks like. It usually takes 2 to 15 minutes. You can close the page: the review keeps running, and the result shows up on the pull request.
6. **Merge the pull request.** From then on, new pull requests are reviewed by themselves.

Reviews use the plan of whoever connects it. After a ChatGPT login, Mergelight posts a comment that names the account, so you can check that it's the right one.

### The two GitHub apps

Mergelight uses two apps, so that a leak of the key on Mergelight's server can't change your code or your workflows:

- **Mergelight Setup** lets the setup page list your repositories and open the pull request, with your own sign-in. No private key for it exists, so it can't act unless you're signed in.
- **Mergelight AI** posts the comments and the check, and saves a refreshed ChatGPT login as a repository secret. It can read code, but it can't commit and can't read a secret's value.

## What you see on the first review

- **A check called Mergelight** in the pull request's merge box. It says "Reviewing" while it works, then shows a light: 🟢 Safe to merge, 🟡 Needs a human or 🔴 Blocked. [What is Mergelight](introduction.md#what-a-review-looks-like) says what each one means.
- **One summary comment.** Until an AI is connected, it asks you to connect one. Then it says "Mergelight: Reviewing" and names the AI that reviews. When the review is done, the same comment shows the light, what the pull request does, what to fix, what's your call and what was left alone.
- **Up to 3 inline comments,** on the lines of the findings most worth holding the merge for.
- **An approval,** when the review is 🟢. Mergelight AI approves the pull request like a reviewer would. Its approval doesn't count toward a branch rule's required approvals, so a person still gives that.

## After you merge

- Each new pull request gets a review, and each new push reviews it again. With **New work**, that's pull requests into the branch you chose.
- Draft pull requests wait until they're marked ready for review.
- Pull requests from forks and from Dependabot aren't reviewed, because GitHub gives their runs no secrets.
- The workflows are pinned to a release: the one `@v0` points to, which has passed a real test review. When a newer one is out, the review says so, and **Update now** on the setup page opens a pull request that updates it.
- To add a second AI, open the setup page again and pick the repository. The **Your AI** box offers **Add Claude** or **Add ChatGPT**. Then one AI reviews and the other checks its findings.

## Set it up from a terminal

If you'd rather use a terminal, this sets up a repository with a ChatGPT plan:

```bash
npx @mergelight/cli setup owner/repo
```

You need Node 20 or newer, the [GitHub CLI](https://cli.github.com) logged in (`gh auth login`), and the [Codex CLI](https://github.com/openai/codex). The command works in 3 steps:

1. It opens GitHub's page to install Mergelight AI, and waits for you to press Enter.
2. It runs `codex login` with a login just for CI, and saves it as the repository secret `CODEX_AUTH_JSON`. Your own Codex stays signed in.
3. It opens a pull request that adds the workflows to your default branch. The pull request reviews itself, and you merge it to turn on reviews.

It uses your own `gh` login, so it doesn't need Mergelight Setup. For its options, such as `--base`, see [Set it up](github-action.md#set-it-up).

## Next steps

- **Fix findings in your coding agent.** Run `npx @mergelight/cli init` once to add Mergelight to Claude Code, Codex and Cursor. Then ask your agent: "Handle the Mergelight findings on this PR." See [Your coding agent](agents.md).
- **Teach it your team's rules.** See [Your team's rules](customize.md).
- **Learn what a review does.** See [How a review works](how-it-works.md).
- **Check what data goes where.** See [Security and data](security.md).
- **See every option.** The [GitHub Action](github-action.md#inputs) reference lists them all.
