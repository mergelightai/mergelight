#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { currentRepo, fetchPullRequest, parsePrRef } from "./github.js";
import { serve } from "./mcp/server.js";
import { GitHub } from "./publish/api.js";
import { approveCheck, CHECK_LOGIN_TITLE, failCheck, failSummary, previousFindings, publishReview, startCheck, startSummary } from "./publish/publish.js";
import { LoginError, loginFailureMessage } from "./providers/codex.js";
import { renderTerminal } from "./render.js";
import { reviewPullRequest } from "./review.js";
import { askForApp, connect, githubConnect } from "./connect.js";
import { realDeps, setup } from "./setup.js";
import type { Review } from "./types.js";

const HELP = `Mergelight: AI code review on the plan you already pay for.

Usage
  mergelight review <pr> [options]       Review a pull request
  mergelight post <review.json>          Post a saved review to its pull request
  mergelight approve <pr> --by <login>   Turn a "needs a human" check green after approval
  mergelight mcp                         Run the MCP server, so your coding agent can read findings
  mergelight setup <owner/repo>          Set up the GitHub Action on a repository
  mergelight connect <pr>                In the Action: connect ChatGPT from the pull request

  <pr> is a pull request URL, owner/repo#123, or a number inside a clone.

Options
  --repo <owner/name>   Repository for a bare PR number
  --at <sha>            Review this commit of the PR instead of the latest
  --post                Post the review to the PR: summary comment, inline findings, check
                        (the check needs a GitHub App, a personal gh login skips it)
  --dry-run             With --post, post or approve: print what would be posted, change nothing
  --yellow-blocks       With --post or post: a "needs a human" check waits for an approval
  --json                Print the review as JSON
  --out <file>          Also write the JSON review to a file
  --provider <name>     Who hunts for problems: codex or claude (default: codex)
  --model <name>        Model for the hunters (default: your Codex config, or opus on Claude)
  --effort <level>      Reasoning effort: low, medium, high (default: high)
  --verify-with <name>  Who checks the findings: claude or codex
                        (default: claude when Claude Code is installed)
  --verify-model <name> Model for the checker (default for claude: opus)
  --keep                Keep the temporary checkout
  --by <login>          Who approved, for approve
  --base <branch>       For setup: add the workflows to this branch (default: the default branch)
  --skip-branches <a,b> For setup: don't review pull requests from these branches
  --relogin             For setup: log in to Codex again
  --no-pin              For setup: follow @v0 and get each release by itself, instead of pinning to the latest
  --yes                 For setup: don't stop to ask whether the app is installed
  --no-save             For connect: there's nowhere to save a login, so ask for the app instead
  -h, --help            Show this help

Reviews run on your own logged-in Codex CLI, and Claude Code if you check with it.
Nothing is sent to Mergelight.
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

  if (command === "mcp") {
    await serve();
    return 0;
  }
  if (!["review", "post", "approve", "connect"].includes(command) || !target) {
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

  if (command === "post") {
    const review = JSON.parse(readFileSync(target, "utf8")) as Review;
    const result = await publishReview(review, { dryRun, log, yellowBlocks: values["yellow-blocks"] });
    log(`Posted: ${result.inline} inline, ${result.outside} in the summary only, ${result.resolved} resolved. ${result.summaryUrl ?? ""}`);
    return 0;
  }

  const ref = parsePrRef(target, values.repo ?? (await currentRepo()));

  if (command === "connect") {
    try {
      const api = new GitHub(ref.owner, ref.repo, { log });
      const { headSha } = await fetchPullRequest(ref);
      if (values["no-save"]) {
        await askForApp(api, ref.number, headSha);
        log("Install the Mergelight AI app: without it there's nowhere to save the ChatGPT login.");
        return 1;
      }
      return await connect(githubConnect(api, ref.number, headSha, log));
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
    log(await approveCheck(new GitHub(ref.owner, ref.repo, { dryRun, log }), ref.number, values.by));
    return 0;
  }

  // review
  const api = new GitHub(ref.owner, ref.repo, { dryRun, log });
  let checkRunId: number | null = null;
  let headSha = values.at ?? null;
  if (values.post) {
    headSha ??= (await fetchPullRequest(ref)).headSha;
    checkRunId = await startCheck(api, headSha);
    await startSummary(api, ref.number).catch((e) => log(`Couldn't post the summary yet: ${(e as Error).message}`));
  }

  const progress = progressPrinter();
  try {
    // The login step already found this login can't be refreshed, so don't send every reviewer to find out.
    if (process.env.MERGELIGHT_LOGIN_LOST === "1") throw new LoginError(loginFailureMessage(process.env.SECRET_NAME || undefined));
    const review = await reviewPullRequest(ref, {
      previous: values.post ? await previousFindings(api, ref.number) : undefined,
      at: values.at,
      provider,
      model: values.model,
      effort: values.effort,
      verifyWith,
      verifyModel: values["verify-model"],
      keep: values.keep,
      onProgress: progress.onProgress,
    });
    progress.stop();

    const json = JSON.stringify(review, null, 2);
    if (values.out) writeFileSync(values.out, `${json}\n`);
    process.stdout.write(values.json ? `${json}\n` : `${renderTerminal(review)}\n`);

    if (values.post) {
      const result = await publishReview(review, { dryRun, log, checkRunId, yellowBlocks: values["yellow-blocks"] });
      log(`Posted: ${result.inline} inline, ${result.outside} in the summary only, ${result.resolved} resolved. ${result.summaryUrl ?? ""}`);
      // The check carries the verdict; the job itself only fails on errors.
      return 0;
    }
    return review.light === "red" ? 2 : 0;
  } catch (err) {
    progress.stop();
    const message = err instanceof Error ? err.message : String(err);
    log(`mergelight: ${message}`);
    if (values.post && headSha) {
      const login = err instanceof LoginError;
      await failCheck(api, checkRunId, headSha, message, log, login ? CHECK_LOGIN_TITLE : undefined).catch((e) => log(`Couldn't update the check: ${(e as Error).message}`));
      await failSummary(api, ref.number, login ? message : undefined).catch((e) => log(`Couldn't update the summary: ${(e as Error).message}`));
    }
    return 1;
  }
}

main().then((code) => process.exit(code));
