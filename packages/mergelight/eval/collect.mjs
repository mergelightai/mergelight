#!/usr/bin/env node
// Collects merged PRs that other reviewers (CodeRabbit, Copilot) commented on,
// with each first-round thread and what happened to it afterwards.
// Output stays in ~/.cache/mergelight/eval, never in this repository.
//
//   node eval/collect.mjs owner/repo [--since 2026-10-05] [--limit 120]

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    since: { type: "string", default: "2026-10-05" },
    limit: { type: "string", default: "120" },
    until: { type: "string" },
    out: { type: "string", default: "prs.json" },
    prs: { type: "string" },
  },
});
const [repoArg] = positionals;
if (!repoArg) {
  console.error("usage: collect.mjs owner/repo [--since YYYY-MM-DD] [--limit N]");
  process.exit(1);
}
const [owner, name] = repoArg.split("/");
const outDir = join(process.env.MERGELIGHT_CACHE ?? join(homedir(), ".cache", "mergelight"), "eval", `${owner}-${name}`);
mkdirSync(outDir, { recursive: true });

const gh = (args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 << 20 });

const BOTS = { coderabbitai: "coderabbit", "copilot-pull-request-reviewer": "copilot" };

const QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(first: 100) { nodes { author { login } commit { oid } submittedAt } }
      reviewThreads(first: 100) {
        nodes {
          isResolved
          isOutdated
          path
          comments(first: 30) {
            nodes { author { login } body originalLine originalStartLine originalCommit { oid } createdAt }
          }
        }
      }
    }
  }
}`;

/** CodeRabbit puts category, severity and effort on the first line: **🐛 Bug** | **🟠 Major** | **⚡ Quick win** */
function severity(body) {
  const head = body.replace(/<[^>]+>/g, "").slice(0, 400);
  const m = head.match(/(?:🔴|🟠|🟡|🔵|⚪)?\s*\b(Critical|Major|Minor|Trivial|Nitpick)\b/);
  if (m) return m[1].toLowerCase();
  if (/_🧹 Nitpick_|Nitpick/.test(body.slice(0, 200))) return "nitpick";
  if (/Potential issue/.test(body.slice(0, 200))) return "issue";
  return "unknown";
}

function headline(body) {
  const bolds = [...body.matchAll(/\*\*([^*\n]{8,240})\*\*/g)].map((m) => m[1]);
  const title = bolds.find((b) => !/^(🔴|🟠|🟡|🔵|⚪|🐛|🗄|⚡|🛠|🧹|♻|🔒|📝|🧪|⚠)/u.test(b.trim()) && !/\|/.test(b));
  return (title ?? body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).trim().slice(0, 200);
}

const list = JSON.parse(
  gh([
    "pr", "list", "-R", repoArg, "--state", "merged", "--limit", values.limit,
    "--search", values.until ? `merged:${values.since}..${values.until}` : `merged:>=${values.since}`,
    "--json", "number,title,additions,deletions,changedFiles,mergedAt",
  ]),
);

// Extra PRs by number, e.g. --prs 377,380, even if they fall outside the date range.
for (const n of (values.prs ?? "").split(",").filter(Boolean).map(Number)) {
  if (list.some((p) => p.number === n)) continue;
  list.push(JSON.parse(gh(["pr", "view", String(n), "-R", repoArg, "--json", "number,title,additions,deletions,changedFiles,mergedAt"])));
}

const prs = [];
for (const pr of list) {
  const data = JSON.parse(
    gh(["api", "graphql", "-f", `query=${QUERY}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${pr.number}`]),
  ).data.repository.pullRequest;

  // The commit each bot first reviewed. Mergelight reviews the same commit.
  const firstReview = {};
  for (const r of [...data.reviews.nodes].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))) {
    const bot = BOTS[r.author?.login];
    if (bot && r.commit && !firstReview[bot]) firstReview[bot] = r.commit.oid;
  }

  const threads = [];
  for (const t of data.reviewThreads.nodes) {
    const [first, ...replies] = t.comments.nodes;
    const bot = first && BOTS[first.author?.login];
    if (!bot) continue;
    threads.push({
      bot,
      commit: first.originalCommit?.oid ?? null,
      round1: first.originalCommit?.oid === firstReview[bot],
      path: t.path,
      line: first.originalLine,
      start_line: first.originalStartLine ?? first.originalLine,
      severity: bot === "coderabbit" ? severity(first.body) : "unknown",
      title: headline(first.body),
      body: first.body.slice(0, 4000),
      // isOutdated: the commented lines changed after the comment, usually because someone acted on it.
      changed_after: t.isOutdated,
      resolved: t.isResolved,
      replies: replies.map((c) => ({ author: c.author?.login ?? "ghost", body: c.body.slice(0, 1500) })),
    });
  }

  const cr = threads.filter((t) => t.bot === "coderabbit" && t.round1);
  prs.push({ ...pr, first_review: firstReview, threads });
  console.error(`#${pr.number} +${pr.additions} coderabbit round1=${cr.length} copilot=${threads.filter((t) => t.bot === "copilot").length}`);
}

writeFileSync(join(outDir, values.out), JSON.stringify(prs, null, 2));
console.error(`Saved ${prs.length} PRs to ${join(outDir, values.out)}`);
