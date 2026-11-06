#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { currentRepo, parsePrRef } from "./github.js";
import { renderTerminal } from "./render.js";
import { reviewPullRequest } from "./review.js";

const HELP = `Mergelight: AI code review on the plan you already pay for.

Usage
  mergelight review <pr> [options]

  <pr> is a pull request URL, owner/repo#123, or a number inside a clone.

Options
  --repo <owner/name>   Repository for a bare PR number
  --at <sha>            Review this commit of the PR instead of the latest
  --json                Print the review as JSON
  --out <file>          Also write the JSON review to a file
  --model <name>        Codex model (default: your Codex config)
  --effort <level>      Reasoning effort: low, medium, high (default: high)
  --keep                Keep the temporary checkout
  -h, --help            Show this help

Reviews run on your own logged-in Codex CLI. Nothing is sent to Mergelight.
`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      at: { type: "string" },
      json: { type: "boolean" },
      out: { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      keep: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  const [command, target] = positionals;
  if (values.help || !command) {
    process.stdout.write(HELP);
    return values.help ? 0 : 1;
  }
  if (command !== "review" || !target) {
    process.stderr.write(HELP);
    return 1;
  }

  const ref = parsePrRef(target, values.repo ?? (await currentRepo()));

  const tty = process.stderr.isTTY;
  const started = Date.now();
  let last = "";
  const draw = () => {
    if (!tty || !last) return;
    const s = Math.round((Date.now() - started) / 1000);
    const line = `${last} (${s}s)`;
    process.stderr.write(`\r\x1b[2K${line.slice(0, (process.stderr.columns ?? 100) - 1)}`);
  };
  const ticker = tty ? setInterval(draw, 1000) : undefined;
  const onProgress = (message: string, transient?: boolean) => {
    if (tty) {
      last = message;
      draw();
    } else if (!transient) {
      process.stderr.write(`${message}\n`);
    }
  };

  try {
    const review = await reviewPullRequest(ref, {
      at: values.at,
      model: values.model,
      effort: values.effort,
      keep: values.keep,
      onProgress,
    });
    if (ticker) clearInterval(ticker);
    if (tty) process.stderr.write("\r\x1b[2K");

    const json = JSON.stringify(review, null, 2);
    if (values.out) writeFileSync(values.out, `${json}\n`);
    process.stdout.write(values.json ? `${json}\n` : `${renderTerminal(review)}\n`);
    return review.light === "red" ? 2 : 0;
  } catch (err) {
    if (ticker) clearInterval(ticker);
    if (tty) process.stderr.write("\r\x1b[2K");
    process.stderr.write(`mergelight: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

main().then((code) => process.exit(code));
