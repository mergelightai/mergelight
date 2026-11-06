#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { currentRepo, fetchPullRequest, parsePrRef } from "./github.js";
import { serve } from "./mcp/server.js";
import { GitHub } from "./publish/api.js";
import { approveCheck, failCheck, previousFindings, publishReview, startCheck } from "./publish/publish.js";
import { renderTerminal } from "./render.js";
import { reviewPullRequest } from "./review.js";
import type { Review } from "./types.js";

const HELP = `Mergelight: AI code review on the plan you already pay for.

Usage
  mergelight review <pr> [options]       Review a pull request
  mergelight post <review.json>          Post a saved review to its pull request
  mergelight approve <pr> --by <login>   Turn a "needs a human" check green after approval
  mergelight mcp                         Run the MCP server, so your coding agent can read findings

  <pr> is a pull request URL, owner/repo#123, or a number inside a clone.

Options
  --repo <owner/name>   Repository for a bare PR number
  --at <sha>            Review this commit of the PR instead of the latest
  --post                Post the review to the PR: summary comment, inline findings, check
  --dry-run             With --post, post or approve: print what would be posted, change nothing
  --yellow-blocks       With --post or post: a "needs a human" check waits for an approval
  --json                Print the review as JSON
  --out <file>          Also write the JSON review to a file
  --model <name>        Codex model (default: your Codex config)
  --effort <level>      Reasoning effort: low, medium, high (default: high)
  --verify-with <name>  Who checks the findings: claude or codex
                        (default: claude when Claude Code is installed)
  --verify-model <name> Model for the checker (default for claude: opus)
  --keep                Keep the temporary checkout
  --by <login>          Who approved, for approve
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
      "verify-model": { type: "string" },
      keep: { type: "boolean" },
      by: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  const [command, target] = positionals;
  if (values.help || !command) {
    process.stdout.write(HELP);
    return values.help ? 0 : 1;
  }
  if (command === "mcp") {
    await serve();
    return 0;
  }
  if (!["review", "post", "approve"].includes(command) || !target) {
    process.stderr.write(HELP);
    return 1;
  }
  const dryRun = Boolean(values["dry-run"]);

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
  }

  const progress = progressPrinter();
  try {
    const review = await reviewPullRequest(ref, {
      previous: values.post ? await previousFindings(api, ref.number) : undefined,
      at: values.at,
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
      await failCheck(api, checkRunId, headSha, message).catch((e) => log(`Couldn't update the check: ${(e as Error).message}`));
    }
    return 1;
  }
}

main().then((code) => process.exit(code));
