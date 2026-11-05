#!/usr/bin/env node
// Scores each reviewer from judge.mjs output.
//
// An "issue" is a group of comments the judge said describe the same problem.
// An issue counts as fixed if the team fixed it (fully or partly) before merging.
//
// Keep the bias in mind: the team saw CodeRabbit's and Copilot's comments and
// often fixed them because they were posted. Nobody saw Mergelight's. So a
// Mergelight comment that got fixed anyway was found by the team on its own,
// and an unfixed Mergelight comment may still be right.
//
//   node eval/score.mjs owner/repo

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { parseArgs } from "node:util";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const { tierOf } = await import(join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "review.js"));
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { tag: { type: "string", default: "" }, selection: { type: "string", default: "selection.json" } },
});
const [repoArg] = positionals;
const [owner, name] = repoArg.split("/");
const dir = join(process.env.MERGELIGHT_CACHE ?? join(homedir(), ".cache", "mergelight"), "eval", `${owner}-${name}`);
const selection = JSON.parse(readFileSync(join(dir, values.selection), "utf8"));

// MP is Mergelight counting only what it posts as its own comment (bugs and likely risks).
const REVIEWERS = { CR: "CodeRabbit", CP: "Copilot", ML: "Mergelight, everything", MP: "Mergelight, posted only" };
const stats = Object.fromEntries(
  Object.keys(REVIEWERS).map((k) => [k, { comments: 0, fixed: 0, issues_found: 0, fixed_issues_found: 0, only_one: 0 }]),
);
let fixedIssues = 0;
let allIssues = 0;
let prsJudged = 0;
const mlOnlyFixed = [];
const botFixedMlMissed = [];

for (const { number } of selection) {
  const file = join(dir, values.tag ? `judge-${values.tag}-${number}.json` : `judge-${number}.json`);
  if (!existsSync(file)) continue;
  prsJudged++;
  const { items, verdicts } = JSON.parse(readFileSync(file, "utf8"));
  const byId = new Map(verdicts.map((v) => [v.id, v]));
  const mlFile = join(dir, values.tag ? `ml-${values.tag}-${number}.json` : `ml-${number}.json`);
  const findings = existsSync(mlFile) ? JSON.parse(readFileSync(mlFile, "utf8")).findings : [];
  const mlIds = items.filter((i) => i.id.startsWith("ML")).map((i) => i.id);
  const posted = new Set(mlIds.filter((id, k) => findings[k] && (findings[k].tier ?? tierOf(findings[k])) === "post"));
  const whoOf = (id) => (id.startsWith("ML") ? (posted.has(id) ? ["ML", "MP"] : ["ML"]) : [id.slice(0, 2)]);

  // Union-find over same_as links.
  const parent = new Map(items.map((i) => [i.id, i.id]));
  const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
  for (const v of verdicts) for (const o of v.same_as ?? []) if (parent.has(o) && parent.has(v.id)) parent.set(find(o), find(v.id));

  const groups = new Map();
  for (const i of items) {
    const g = find(i.id);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(i);
  }

  for (const i of items) {
    for (const who of whoOf(i.id)) {
      stats[who].comments++;
      if (["fixed", "partly"].includes(byId.get(i.id)?.outcome)) stats[who].fixed++;
    }
  }

  for (const members of groups.values()) {
    allIssues++;
    const fixed = members.some((m) => ["fixed", "partly"].includes(byId.get(m.id)?.outcome));
    const who = new Set(members.flatMap((m) => whoOf(m.id)));
    const reviewers = new Set([...who].map((w) => (w === "MP" ? "ML" : w)));
    for (const w of who) {
      stats[w].issues_found++;
      if (fixed) stats[w].fixed_issues_found++;
      if (fixed && reviewers.size === 1) stats[w].only_one++;
    }
    if (!fixed) continue;
    fixedIssues++;
    const first = members[0];
    if (reviewers.size === 1 && reviewers.has("ML")) mlOnlyFixed.push({ number, m: first, v: byId.get(first.id) });
    if (!who.has("ML")) botFixedMlMissed.push({ number, members, v: byId.get(first.id) });
  }
}

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "n/a");
const rows = Object.entries(REVIEWERS).map(([k, label]) => {
  const s = stats[k];
  return `| ${label} | ${s.comments} | ${s.fixed} (${pct(s.fixed, s.comments)}) | ${s.fixed_issues_found} of ${fixedIssues} (${pct(s.fixed_issues_found, fixedIssues)}) | ${s.only_one} |`;
});

const report = `# Who found what the team fixed: ${repoArg}

${prsJudged} PRs. For every comment, Codex compared the commit that was reviewed with the merged code and judged whether the team fixed it. Comments describing the same problem were grouped into one issue.

${fixedIssues} of ${allIssues} issues raised by any reviewer were fixed before merging.

| Reviewer | Comments | Comments the team fixed | Fixed issues it found | Fixed issues only it found |
|---|---|---|---|---|
${rows.join("\n")}

The team saw CodeRabbit's and Copilot's comments, not Mergelight's. Every Mergelight comment the team fixed, it fixed without being told.

## Fixed, and only Mergelight raised it (${mlOnlyFixed.length})

${mlOnlyFixed.map(({ number, m, v }) => `- #${number} ${m.file}:${m.line}: ${m.text.slice(0, 160)}\n  - ${v.evidence}`).join("\n") || "None"}

## Fixed, raised by a bot, missed by Mergelight (${botFixedMlMissed.length})

${botFixedMlMissed.map(({ number, members, v }) => `- #${number} ${members.map((m) => m.id).join(", ")} ${members[0].file}:${members[0].line}: ${members[0].text.slice(0, 160)}\n  - ${v.evidence}`).join("\n") || "None"}
`;

writeFileSync(join(dir, values.tag ? `score-${values.tag}.md` : "score.md"), report);
process.stdout.write(report);
