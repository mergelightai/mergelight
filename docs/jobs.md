# Jobs

A job is a task your team writes once in its repository. On each pull request that needs it, the AI does the task, and Mergelight pushes the result as one commit to the pull request's branch. Nobody types a command, and nobody asks an agent.

For example: a pull request adds 20 keys to `locales/en.json`. Your translations job adds the 20 keys, translated, to every other locale file. The review then reads that commit like the rest of the pull request.

Jobs run in your own GitHub Actions, on your own Codex or Claude login, like the [review](github-action.md).

## Write a job

Put a Markdown file in `.mergelight/jobs/`, one file for each job:

```md
---
name: translations
on: locales/en.json
may-change: locales/*.json
---
locales/en.json is the source of truth. When it has keys that another file in locales/ is missing,
add each missing key to that file, translated into that file's language. Keep the key order of
en.json. Never change a key that already has a translation.
```

- **`on`:** the files whose change starts the job. A pull request that changes none of them runs no job.
- **`may-change`:** the only files the job may change, add or delete. A job that changes any other file is dropped whole.
- **`skill`** (optional): a skill folder in your repository that the job reads first, like `.claude/skills/write-docs`. It needs a `SKILL.md`.
- **`name`** (optional): lowercase letters, digits and dashes. Without it, the file's name is the job's name.
- **The text below the front matter** is the task, in plain words.

Paths are written as in [rule files](github-action.md): a comma list, a `[list]`, a YAML list, or braces like `**/*.{ts,tsx}`. A path with no folder in it, like `*.json`, matches that name in any folder. `**` is every file. A path can't start with `!`: list only what the job may change.

`on` and `may-change` match strictly. `locales/*.json` and `locales/*` are the files right in `locales`, never a subfolder of it. A plain folder name like `docs`, or `docs/**`, covers everything inside. `./CHANGELOG.md` and `/CHANGELOG.md` are the file at the root, while `CHANGELOG.md` is that name in any folder.

A docs job looks the same with other paths: `on: src` and `may-change: docs`.

**Jobs are read from your base branch,** like rules. A pull request can't add a job, or change one, for itself: a new or changed job counts from the pull request after it is merged.

## Turn jobs on

Run `npx @mergelight/cli setup owner/repo --with-jobs`, or use [`examples/mergelight-jobs.yml`](../examples/mergelight-jobs.yml) in place of `mergelight.yml`. A repository with Mergelight's plain workflow runs no jobs, and holds no token that can push.

The workflow has 3 parts, each a job of its own in GitHub Actions:

1. **run-jobs** runs your jobs with the AI. Its token can only read. It writes what the jobs changed to a file.
2. **push-jobs** checks that file again and pushes one commit. Its token can push, and it runs no AI and gets no AI login.
3. **review** reviews the pull request, as before. After jobs, it reviews the commit they pushed, and the summary gets a **Jobs** part: what each job did, and anything that kept a change off the branch.

## What you see on a pull request

- One commit from Mergelight on your branch, named after the jobs, like "Run the job translations". **Pull before you push again.**
- The Jobs part in the review's summary.
- A banner in the pull request: **"Approve workflows to run"**. GitHub starts your other workflows, such as tests, for a commit that a workflow pushed only after a person with write access approves them. Mergelight's own review doesn't wait for that: it already ran in the same workflow. The approved run reviews that commit once more, on your plan, as any run does; if you don't need your other workflows on the jobs' commit, you don't have to approve it. Workflows that run only on `push` don't start for that commit at all, so a check they give never comes: to have them run, give the push step a GitHub App's token or a personal one (`github-token` on `push-jobs`).

A job that has nothing to do changes nothing, and no commit appears. A commit that jobs made never starts the jobs again.

## Safety

The review's token still can't push. Jobs add one place that can, and keep the AI away from it:

- **The AI never holds a token that can push.** It runs in one job in GitHub Actions, a machine of its own, with a token that can only read. A second job, with no AI and no AI login, checks the change and pushes it. The two never share a machine.
- **A job pushes only to the pull request's own branch,** which its author can push to already. So a job gives nobody power they didn't have. Pull requests from forks and from Dependabot run no jobs.
- **A job may change only its `may-change` files.** The program, not the AI, checks every file after each job, and the push step checks them all again against the jobs on your base branch. It trusts nothing in the file the first job wrote.
- **Some files are never changed, whatever a job says:** anything under `.github` or `.mergelight`, `CODEOWNERS`, other files that decide what runs (`.gitlab-ci.yml`, `.circleci`, `Jenkinsfile`, `.husky`, `.devcontainer` and the like), the files AI agents and the review take instructions from (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `CONTRIBUTING.md`, `.mcp.json`, `.cursorrules` and the like, and folders such as `.claude`, `.agents`, `.codex`, `.cursor` and `.vscode`), and whatever any of these links to or imports with `@`, like `@docs/ai-guide.md` in `CLAUDE.md`, any skill (a file named `SKILL.md`, and every folder that has one on your base branch, whether a job or a review uses it), `.gitmodules`, `.gitattributes`, links, submodules, files that can run, and binary files. A job file that is a link to a file a job could change isn't read.
- **The AI works in a copy with no git inside,** and runs no commands of the project: Claude gets only file tools, and Codex's commands can write in the copy and nowhere else, with no network.
- **The push never overwrites anyone's work.** It makes one commit, which GitHub refuses if the branch moved on while the jobs ran. Then nothing is pushed, and your new push runs the jobs again. It never force-pushes, and GitHub signs the commit.
- **Everything from the pull request is data to the AI,** never instructions: the title, the description, the diff and the files. Only the job's own text, from your base branch, tells it what to do.
- **Every commit a job makes is reviewed,** and you merge it like any other.

## Limits

5 jobs for each repository, 8,000 characters for each task, and 20 job files read. Each job gets 10 minutes, and all jobs together 20. All jobs together may change 100 files and write 1 MB. A job that goes over a limit is dropped, and the summary says so.
