#!/usr/bin/env node
// Replays the loop breaker on a pull request's earlier review rounds. Each round saved its findings in
// the summary comment's hidden state, and GitHub keeps every edit of that comment, so every round can be
// read again without running a model. Shows, per round, what held the merge then and what would now, the
// round the pull request would have ended in, and every major finding the loop breaker would leave alone.
//
//   node eval/rounds.mjs owner/repo#123
//
// Saved states don't have the security field, which came with the loop breaker: a major risk there
// counts as not a security problem, so it is listed for a person to check.

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const { decodeState } = await import(join(dist, "publish", "state.js"));
const { placeFinding } = await import(join(dist, "review.js"));

const [, owner, repo, number] = (process.argv[2] ?? "").match(/^([^/]+)\/([^#]+)#(\d+)$/) ?? [];
if (!number) {
  console.error("Usage: node eval/rounds.mjs owner/repo#123");
  process.exit(1);
}

const gh = (args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const comments = JSON.parse(gh(["api", "--paginate", "--slurp", `repos/${owner}/${repo}/issues/${number}/comments?per_page=100`])).flat();
const summary = comments.find((c) => (c.body ?? "").includes("mergelight:summary"));
if (!summary) {
  console.error("No Mergelight summary on that pull request.");
  process.exit(1);
}
const query = `query($id: ID!) { node(id: $id) { ... on IssueComment { userContentEdits(first: 100) { nodes { diff } } } } }`;
const edits = JSON.parse(gh(["api", "graphql", "-f", `query=${query}`, "-f", `id=${summary.node_id}`])).data.node.userContentEdits.nodes;

// The latest edit of each round, newest first as GitHub lists them, and the comment as it is now.
const rounds = new Map();
for (const body of [summary.body, ...edits.map((e) => e.diff)]) {
  const state = body ? decodeState(body) : null;
  if (state && !rounds.has(state.round)) rounds.set(state.round, state);
}

// A saved finding keeps its tier, not the verifier's recommendation: the tier says it again.
const asModel = (f) => ({ ...f, rank: f.tier === "post" ? 1 : null, recommendation: f.tier === "decision" ? "decide" : "fix" });
const label = (f) => `${f.class}/${f.severity}/${f.likelihood ?? "?"}`;

let ended = null;
const leftMajor = [];
for (const [round, state] of [...rounds].sort((a, b) => a[0] - b[0])) {
  const held = state.findings.filter((f) => f.status === "open" && f.tier !== "hardening");
  const kept = held.filter((f) => placeFinding(asModel(f), round).tier !== "hardening");
  for (const f of held) if (f.severity === "major" && !kept.includes(f)) leftMajor.push({ round, f });
  if (ended === null && kept.length === 0) ended = round;
  console.log(`round ${String(round).padStart(2)}: ${held.length} held the merge, ${kept.length} would now${kept.length ? `: ${kept.map(label).join(", ")}` : ""}`);
}
const last = Math.max(...rounds.keys());
console.log(`\n${owner}/${repo}#${number}: ${ended === null ? `would still be going after round ${last}` : `would have ended in round ${ended} of ${last}`}.`);
const upToEnd = leftMajor.filter(({ round }) => ended === null || round <= ended);
console.log(`Major bugs left alone: ${leftMajor.filter(({ f }) => f.class === "bug").length}. Major risks left alone up to that round: ${upToEnd.length}.`);
for (const { round, f } of upToEnd) console.log(`  round ${round}: ${label(f)} ${f.title}`);
