#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { currentRepo, fetchPullRequest, parsePrRef } from "./github.js";
import { serve } from "./mcp/server.js";
import { declinesOf, fetchContext, MAX_REASON, reportReview } from "./cloud.js";
import { GitHub } from "./publish/api.js";
import { writeAccess } from "./publish/handled.js";
import { publishTeamChecks } from "./publish/team-checks.js";
import { answerRemembered, confirmReasons, approveCheck, checkLimitTitle, checkLoginTitle, failCheck, failSummary, previousFindings, publishReview, startCheck, startSummary, syncApproval, UNREVIEWED, APPROVALS_OFF, updatePendingSummary } from "./publish/publish.js";
import { configuredModel, LimitError, LoginError, loginFailureMessage } from "./providers/codex.js";
import { limitNotice, loginNotice } from "./publish/markdown.js";
import { renderRejected, renderTerminal } from "./render.js";
import { reviewPullRequest } from "./review.js";
import { jobsCommand } from "./jobs-command.js";
import { pushJobs } from "./push-jobs.js";
import { askForApp, connect, githubConnect } from "./connect.js";
import { init, realInitDeps } from "./init.js";
import { realDeps, setup } from "./setup.js";
import type { Review, TeamCheckResult } from "./types.js";

const HELP = `Mergelight: AI code review on the plan you already pay for.

Usage
  mergelight review <pr> [options]       Review a pull request
  mergelight post <review.json>          Post a saved review to its pull request
  mergelight approve <pr> --by <login>   Turn a "needs a human" check green after approval
  mergelight init                        Add Mergelight to your coding agents: Claude Code, Codex and Cursor
  mergelight mcp                         Run the MCP server, so your coding agent can read findings
  mergelight setup <owner/repo>          Set up the GitHub Action on a repository
  mergelight connect <pr>                In the Action: connect ChatGPT from the pull request
  mergelight jobs <pr> [--out <file>]    Run the team's jobs from .mergelight/jobs on a pull request, and
                                         write what they changed to a file. Nothing is pushed or posted
  mergelight push-jobs <pr> --from <file>
                                         Check a jobs file again against the base branch, and push it as
                                         one commit to the pull request's branch. Runs no AI

  <pr> is a pull request URL, owner/repo#123, or a number inside a clone.

Options
  --repo <owner/name>   Repository for a bare PR number
  --at <sha>            Review this commit of the PR instead of the latest
  --post                Post the review to the PR: summary comment, inline findings, check
                        (the check needs a GitHub App, a personal gh login skips it)
  --dry-run             With --post, post or approve: print what would be posted, change nothing
  --yellow-blocks       With --post or post: a "needs a human" check waits for an approval and a "blocked" one fails
  --no-approve          With --post or post: never approve the pull request, and take back an approval Mergelight gave
  --json                Print the review as JSON
  --out <file>          Also write the JSON review to a file
  --provider <name>     Who hunts for problems: codex or claude (default: codex)
  --model <name>        Model for the hunters (default: your Codex config, or opus on Claude)
  --effort <level>      Reasoning effort: low, medium, high (default: high)
  --verify-with <name>  Who checks the findings: claude or codex
                        (default: claude when Claude Code is installed)
  --verify-missed <name>
                        The AI that was meant to check but had no login: the summary says so
  --verify-model <name> Model for the checker (default for claude: opus)
  --keep                Keep the temporary checkout
  --by <login>          Who approved, for approve
                        With approve, --at is the commit they approved: an older one doesn't count
  --base <branch>       For setup: add the workflows to this branch (default: the default branch)
  --skip-branches <a,b> For setup: don't review pull requests from these branches
  --relogin             For setup: log in to Codex again
  --no-pin              For setup: follow @v0 and get each release by itself, instead of pinning to the latest
  --yes                 For setup: don't stop to ask whether the app is installed
  --no-save             For connect: there's nowhere to save a login, so ask for the app instead
  --for check --ai <name> --reviewer <name>
                        For connect: connect the AI that checks another AI's review. Nobody
                        connecting it holds nothing up: the reviewer checks instead
  -h, --help            Show this help

Reviews run on your own logged-in Codex CLI, and Claude Code if you check with it.
Your code and your AI login are never sent to Mergelight.
`;

function progressPrinter() {
  const tty = Boolean(process.stderr.isTTY);
  const started = Date.now();
  let last = "";
  const draw = () => {
    if (!tty || !last) return;
    const s = Math.round((Date.now() - started) / 1000);
    const line = `${last} (${s}s)`;
    process.stderr.write(`\r\x1b[2K${line.slice(0, (process.stderr.columns ?? 100) - 1)}`);
  };
  const ticker = tty ? setInterval(draw, 1000) : undefined;
  return {
    onProgress(message: string, transient?: boolean) {
      if (tty) {
        last = message;
        draw();
      } else if (!transient) {
        process.stderr.write(`${message}\n`);
      }
    },
    stop() {
      if (ticker) clearInterval(ticker);
      if (tty) process.stderr.write("\r\x1b[2K");
    },
  };
}

const log = (line: string) => process.stderr.write(`${line}\n`);

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      at: { type: "string" },
      post: { type: "boolean" },
      "dry-run": { type: "boolean" },
      "yellow-blocks": { type: "boolean" },
      "no-approve": { type: "boolean" },
      json: { type: "boolean" },
      out: { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      "verify-with": { type: "string" },
      provider: { type: "string" },
      "verify-model": { type: "string" },
      keep: { type: "boolean" },
      by: { type: "string" },
      base: { type: "string" },
      "skip-branches": { type: "string" },
      relogin: { type: "boolean" },
      pin: { type: "boolean" },
      "no-pin": { type: "boolean" },
      yes: { type: "boolean" },
      "no-save": { type: "boolean" },
      for: { type: "string" },
      ai: { type: "string" },
      reviewer: { type: "string" },
      "verify-missed": { type: "string" },
      "verify-missed-why": { type: "string" },
      from: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  const [command, target] = positionals;
  if (values.help || !command) {
    process.stdout.write(HELP);
    return values.help ? 0 : 1;
  }
  if (command === "setup") {
    if (!target || !/^[\w.-]+\/[\w.-]+$/.test(target)) {
      log("mergelight: name the repository, like: mergelight setup owner/repo");
      return 1;
    }
    try {
      return await setup(
        {
          repo: target,
          base: values.base,
          skipBranches: values["skip-branches"]?.split(",").map((b) => b.trim()).filter(Boolean),
          relogin: values.relogin,
          pin: !values["no-pin"],
          yes: values.yes,
        },
        realDeps(),
      );
    } catch (err) {
      log(`mergelight: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  if (command === "init") {
    try {
      return await init(realInitDeps());
    } catch (err) {
      log(`mergelight: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  if (command === "mcp") {
    await serve();
    return 0;
  }
  if (!["review", "post", "approve", "connect", "jobs", "push-jobs"].includes(command) || !target) {
    process.stderr.write(HELP);
    return 1;
  }
  const dryRun = Boolean(values["dry-run"]);

  const provider = values.provider;
  if (provider !== undefined && provider !== "codex" && provider !== "claude") {
    log(`mergelight: --provider must be codex or claude, not "${provider}"`);
    return 1;
  }
  const verifyWith = values["verify-with"];
  if (verifyWith !== undefined && verifyWith !== "codex" && verifyWith !== "claude") {
    log(`mergelight: --verify-with must be codex or claude, not "${verifyWith}"`);
    return 1;
  }
  // The AI the team asked to check, which had no login, so the reviewer's own AI checked instead.
  const verifyMissed = values["verify-missed"];
  if (verifyMissed !== undefined && verifyMissed !== "codex" && verifyMissed !== "claude") {
    log(`mergelight: --verify-missed must be codex or claude, not "${verifyMissed}"`);
    return 1;
  }

  if (command === "post") {
    const review = JSON.parse(readFileSync(target, "utf8")) as Review;
    const result = await publishReview(review, { dryRun, log, yellowBlocks: values["yellow-blocks"], approve: !values["no-approve"] });
    log(`Posted: ${result.inline} inline, ${result.outside} in the summary only, ${result.resolved} resolved. ${result.summaryUrl ?? ""}`);
    return 0;
  }

  const ref = parsePrRef(target, values.repo ?? (await currentRepo()));

  if (command === "jobs") {
    const progress = progressPrinter();
    try {
      // A log line clears the progress line first, so the two never run together in a terminal.
      const clearing = (line: string) => log(process.stderr.isTTY ? `\r\x1b[2K${line}` : line);
      return await jobsCommand(ref, { provider, model: values.model, effort: values.effort, out: values.out, at: values.at, keep: values.keep, log: clearing, onProgress: progress.onProgress });
    } catch (err) {
      progress.stop();
      log(`mergelight: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    } finally {
      progress.stop();
    }
  }

  if (command === "push-jobs") {
    if (!values.from) {
      log("push-jobs needs --from <file>, the file mergelight jobs wrote");
      return 1;
    }
    try {
      return await pushJobs(ref, { from: values.from, dryRun, log });
    } catch (err) {
      log(`mergelight: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  if (command === "connect") {
    // --for check: connect the AI that checks another AI's review. It never stops the review: when nobody
    // connects it, or it can't be saved, the reviewer's own AI checks, and the review's summary says so.
    const check = values.for === "check";
    const ai = values.ai;
    const reviewer = values.reviewer;
    if (values.for !== undefined && values.for !== "check" && values.for !== "review") {
      log(`mergelight: --for must be review or check, not "${values.for}"`);
      return 1;
    }
    if (check && ((ai !== "codex" && ai !== "claude") || (reviewer !== "codex" && reviewer !== "claude") || ai === reviewer)) {
      log("mergelight: connect --for check needs --ai and --reviewer, each codex or claude, and not the same.");
      return 1;
    }
    // For a review, --ai claude offers only Claude's link: the workflow says Claude reviews, and it has no login yet.
    if (!check && ai !== undefined && ai !== "claude") {
      log(`mergelight: for a review, --ai can only be claude, not "${ai}"`);
      return 1;
    }
    try {
      const api = new GitHub(ref.owner, ref.repo, { log });
      const { headSha } = await fetchPullRequest(ref);
      if (check) {
        if (values["no-save"]) {
          log(`There's nowhere to save a ${ai === "codex" ? "ChatGPT" : "Claude"} login without the Mergelight AI app, so the reviewer's own AI checks this time.`);
          return 0;
        }
        await connect(githubConnect(api, ref.number, headSha, log, process.env, { purpose: "check", ai: ai as "codex" | "claude", reviewer: reviewer as "codex" | "claude" }));
        return 0;
      }
      const login = ai === "claude" ? "Claude" : "ChatGPT";
      if (values["no-save"]) {
        await askForApp(api, ref.number, headSha, login);
        log(`Install the Mergelight AI app: without it there's nowhere to save the ${login} login.`);
        return 1;
      }
      return await connect(githubConnect(api, ref.number, headSha, log, process.env, ai === "claude" ? { purpose: "review", ai: "claude" } : { purpose: "review" }));
    } catch (err) {
      log(`mergelight: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  if (command === "approve") {
    if (!values.by) {
      log("approve needs --by <login>");
      return 1;
    }
    log(await approveCheck(new GitHub(ref.owner, ref.repo, { dryRun, log }), ref.number, values.by, values.at || undefined));
    return 0;
  }

  // review
  const api = new GitHub(ref.owner, ref.repo, { dryRun, log });
  let checkRunId: number | null = null;
  let summaryComment: Awaited<ReturnType<typeof startSummary>> = null;
  /** The edit that names the models, so a result or a failure notice is always written after it. */
  let naming: Promise<void> = Promise.resolve();
  let headSha = values.at ?? null;
  if (values.post) {
    headSha ??= (await fetchPullRequest(ref)).headSha;
    // A connect earlier in this run left its check going: the review carries it on, so no check stands
    // finished in between, which a branch rule could take for a review that passed.
    checkRunId = await startCheck(api, headSha, provider ?? "codex", Number(process.env.MERGELIGHT_CHECK_RUN) || undefined);
    // From here the review finishes the check, or a newer one, whatever happens: the run's last step leaves it.
    if (process.env.MERGELIGHT_CHECK_RUN && process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, "MERGELIGHT_CHECK_RUN=\n");
    // Says which AI reviews from the start. The models' exact names follow once the first reviewer answers.
    // Without --provider the review runs on Codex, as reviewPullRequest decides.
    const firstGuess = values.model ?? (provider === "claude" ? "opus" : configuredModel());
    summaryComment = await startSummary(api, ref.number, { reviewer: { name: provider ?? "codex", model: firstGuess ?? null } }).catch((e) => {
      log(`Couldn't post the summary yet: ${(e as Error).message}`);
      return null;
    });
  }

  // Teams that use the dashboard: ask the server first, so nothing is sent for anyone else.
  const cloud = values.post && !dryRun ? await fetchContext({ log }) : { connected: false, memories: [], rules: [], skills: [], checks: [], writtenSkills: [] };

  const progress = progressPrinter();
  /** The team's checks that have an answer which isn't on GitHub yet. */
  let answered: TeamCheckResult[] | undefined;
  let checksPosted = false;
  try {
    // The login step already found this login can't be refreshed, so don't send every reviewer to find out.
    // Only when Codex is in this review: a Claude review whose Codex checker lost its login is checked by Claude.
    const usesCodex = (provider ?? "codex") === "codex" || verifyWith === "codex";
    if (usesCodex && process.env.MERGELIGHT_LOGIN_LOST === "1") throw new LoginError(loginFailureMessage(process.env.SECRET_NAME || undefined));
    // Before the threads are read: a reply written after this counts as newer than this review.
    const startedAt = new Date();
    let previous = values.post ? await previousFindings(api, ref.number, headSha ?? undefined) : undefined;
    const review = await reviewPullRequest(ref, {
      previous,
      memories: cloud.memories,
      rules: cloud.rules,
      rulesUnread: cloud.failed === true,
      skills: cloud.skills,
      writtenSkills: cloud.writtenSkills,
      checks: cloud.checks,
      onTeamChecks: (results) => (answered = results),
      onModels: (models) => {
        naming = updatePendingSummary(api, summaryComment, models).catch((e) => {
          log(`Couldn't name the models yet: ${(e as Error).message}`);
        });
      },
      // The commit the check and the earlier findings were read for, so a push in between doesn't mix two.
      at: values.at ?? headSha ?? undefined,
      provider,
      model: values.model,
      effort: values.effort,
      verifyWith,
      verifyModel: values["verify-model"],
      keep: values.keep,
      onProgress: progress.onProgress,
    });
    progress.stop();
    if (verifyMissed && verifyMissed !== review.verifier?.name && !review.checker_missed) {
      review.checker_missed = verifyMissed;
      const why = values["verify-missed-why"];
      if (why === "not-installed" || why === "login-failed") review.checker_missed_why = why;
    }

    const json = JSON.stringify(review, null, 2);
    if (values.out) writeFileSync(values.out, `${json}\n`);
    process.stdout.write(values.json ? `${json}\n` : `${renderTerminal(review)}\n`);
    // GitHub sets RUNNER_DEBUG when someone re-runs a job with debug logging on.
    if (process.env.RUNNER_DEBUG === "1" || process.env.MERGELIGHT_DEBUG === "1") for (const line of renderRejected(review)) log(line);

    if (values.post) {
      previous = confirmReasons(previous, review.trace.rejected);
      // Reasons given in threads that this review sends to keep: the state holds them until the server confirms.
      // Also when the server couldn't be asked this time, so a waiting reason isn't dropped from the state.
      const remember = cloud.connected || cloud.failed ? (previous ?? []).filter((p) => p.handled?.from === "reply" && p.handled.remember && p.handled.at).map((p) => ({ id: p.id, at: p.handled!.at!, tries: (p.handled!.tries ?? 0) + (cloud.connected ? 1 : 0) })) : [];
      await naming;
      const result = await publishReview(review, { dryRun, log, checkRunId, yellowBlocks: values["yellow-blocks"], approve: !values["no-approve"], teamUnread: cloud.failed === true, startedAt, remember });
      log(`Posted: ${result.inline} inline, ${result.outside} in the summary only, ${result.resolved} resolved. ${result.summaryUrl ?? ""}`);
      if (review.team_checks?.length) {
        checksPosted = true;
        const posted = await publishTeamChecks(api, review.pr.head_sha, review.team_checks, log, Boolean(values["yellow-blocks"])).catch((e) => (log(`Couldn't post your team's checks: ${(e as Error).message}`), 0));
        if (posted) log(`Posted ${posted} of your team's check${posted === 1 ? "" : "s"}.`);
      }
      if (cloud.connected) {
        // A decision is only remembered when GitHub says its author can push to this repository. Being a
        // member of the org is not enough: this outlives the pull request it was made on.
        const canWrite = writeAccess(api);
        const declines = [];
        for (const d of declinesOf(previous)) if (await canWrite(d.by)) declines.push(d);
        const { remembered } = await reportReview(review, { log }, declines);
        // A reason given in a thread gets an answer there, once the server says it kept it. A mark was
        // written through the agent tools, which say so themselves.
        const fromThreads = (previous ?? []).filter((p) => p.handled?.from === "reply" && p.handled.remember);
        const cut = new Set(fromThreads.filter((p) => p.handled?.cut || (p.handled?.note?.length ?? 0) > MAX_REASON).map((p) => p.id));
        const answer = (remembered ?? []).filter((id) => fromThreads.some((p) => p.id === id));
        const answered = await answerRemembered(api, ref.number, answer, cut, log);
        if (answered) log(`Remembered ${answered} reason${answered === 1 ? "" : "s"} given in a thread, and said so there.`);
      }
      // The check carries the verdict; the job itself only fails on errors.
      return 0;
    }
    return review.light === "red" ? 2 : 0;
  } catch (err) {
    progress.stop();
    const message = err instanceof Error ? err.message : String(err);
    log(`mergelight: ${message}`);
    if (values.post && headSha) {
      const login = err instanceof LoginError ? err : null;
      const limit = err instanceof LimitError ? err : null;
      const title = limit ? checkLimitTitle(limit.plan) : login ? checkLoginTitle(login.plan) : undefined;
      const notice = limit ? limitNotice(limit.plan, limit.resets) : login ? loginNotice(login.plan, message) : undefined;
      await failCheck(api, checkRunId, headSha, message, log, title).catch((e) => log(`Couldn't update the check: ${(e as Error).message}`));
      await naming;
      await failSummary(api, ref.number, notice).catch((e) => log(`Couldn't update the summary: ${(e as Error).message}`));
      // The newest commit wasn't reviewed. An approval Mergelight gave to an earlier commit must not count for this one.
      // With approvals turned off, none of Mergelight's approvals stands, this commit's included.
      await syncApproval(api, ref.number, "yellow", headSha, log, values["no-approve"] ? { why: APPROVALS_OFF } : { why: UNREVIEWED, otherCommitsOnly: true });
      // Each of the team's checks still gets an answer on GitHub, so a required one says why it holds the merge:
      // the answer it already has, or that it wasn't asked.
      const unasked = cloud.checks.map((c) => ({ id: c.id, name: c.name, text: c.text, outcome: "error" as const, summary: "The review couldn't run, so this check wasn't asked.", problems: [] }));
      const owed = checksPosted ? [] : (answered ?? unasked);
      if (owed.length) await publishTeamChecks(api, headSha, owed, log, Boolean(values["yellow-blocks"])).catch((e) => log(`Couldn't post your team's checks: ${(e as Error).message}`));
    }
    return 1;
  }
}

main().then((code) => process.exit(code));
