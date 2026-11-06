#!/usr/bin/env node
// Compares Mergelight reviews with what CodeRabbit and Copilot said on the same
// commit, and with what the team did afterwards.
//
// "Acted on" means the commented lines changed after the comment (GitHub marks
// the thread outdated). It's a proxy: a change can be unrelated, and an ignored
// comment can still have been right. The detail lists are there to check by hand.
//
//   node eval/compare.mjs owner/repo

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [repoArg] = process.argv.slice(2);
const [owner, name] = repoArg.split("/");
const dir = join(process.env.MERGELIGHT_CACHE ?? join(homedir(), ".cache", "mergelight"), "eval", `${owner}-${name}`);
const prs = new Map(JSON.parse(readFileSync(join(dir, "prs.json"), "utf8")).map((p) => [p.number, p]));
const selection = JSON.parse(readFileSync(join(dir, "selection.json"), "utf8"));

const SLACK = 6;
const matches = (t, f) =>
  t.path === f.file && Math.max(t.start_line ?? t.line, 1) - SLACK <= f.end_line && (t.line ?? 0) + SLACK >= f.line;
const visible = (f) => f.class !== "hardening";

const totals = {
  prs: 0, threads: 0, acted: 0, coderabbit: 0, copilot: 0,
  ml_bug: 0, ml_risk: 0, ml_hardening: 0,
  acted_caught: 0, acted_hardening: 0, acted_missed: 0,
  ignored_flagged: 0, ignored_hardening: 0, ignored_silent: 0,
  ml_new_visible: 0, minutes: 0,
};
const rows = [];
const missed = [];
const disagreements = [];
const fresh = [];

for (const { number, at } of selection) {
  const file = join(dir, `ml-${number}.json`);
  if (!existsSync(file)) continue;
  const ml = JSON.parse(readFileSync(file, "utf8"));
  const pr = prs.get(number);
  const threads = pr.threads.filter((t) => t.commit === at);

  totals.prs++;
  totals.minutes += ml.stats.duration_ms / 60000;
  totals.threads += threads.length;
  totals.coderabbit += threads.filter((t) => t.bot === "coderabbit").length;
  totals.copilot += threads.filter((t) => t.bot === "copilot").length;
  for (const f of ml.findings) totals[`ml_${f.class}`]++;

  let actedCaught = 0;
  let ignoredFlagged = 0;
  for (const t of threads) {
    const hits = ml.findings.filter((f) => matches(t, f));
    const seen = hits.some(visible);
    const soft = !seen && hits.length > 0;
    if (t.changed_after) {
      totals.acted++;
      if (seen) { totals.acted_caught++; actedCaught++; }
      else if (soft) totals.acted_hardening++;
      else totals.acted_missed++;
      if (!seen) missed.push({ number, t, as: soft ? "hardening" : "not mentioned" });
    } else {
      if (seen) { totals.ignored_flagged++; ignoredFlagged++; disagreements.push({ number, t, f: hits.find(visible) }); }
      else if (soft) totals.ignored_hardening++;
      else totals.ignored_silent++;
    }
  }
  for (const f of ml.findings.filter(visible)) {
    if (!threads.some((t) => matches(t, f))) {
      totals.ml_new_visible++;
      fresh.push({ number, f });
    }
  }

  rows.push(
    `| #${number} | +${pr.additions} | ${threads.length} | ${threads.filter((t) => t.changed_after).length} | ` +
      `${ml.findings.filter((f) => f.class === "bug").length} / ${ml.findings.filter((f) => f.class === "risk").length} / ${ml.findings.filter((f) => f.class === "hardening").length} | ` +
      `${actedCaught} | ${ignoredFlagged} | ${{ red: "🔴", yellow: "🟡", green: "🟢" }[ml.light]} | ${Math.round(ml.stats.duration_ms / 1000)}s |`,
  );
}

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "n/a");
const shortT = (t) => `${t.bot} ${t.severity !== "unknown" ? `(${t.severity}) ` : ""}${t.path}:${t.line}: ${t.title.slice(0, 140)}`;
const shortF = (f) => `${f.class} ${f.file}:${f.line}: ${f.title} (${f.likelihood}, fix ${f.fix_cost}, ${f.confidence}). ${f.verdict}`;

const report = `# Mergelight eval: ${repoArg}

${totals.prs} PRs, reviewed at the same commit CodeRabbit and Copilot commented on. Total review time ${Math.round(totals.minutes)} min.

## Volume

- CodeRabbit + Copilot: **${totals.threads} comments** (${totals.coderabbit} CodeRabbit, ${totals.copilot} Copilot)
- The team changed the code after **${totals.acted}** of them (${pct(totals.acted, totals.threads)}). The rest were left as they were.
- Mergelight: **${totals.ml_bug + totals.ml_risk} posted** (${totals.ml_bug} bugs, ${totals.ml_risk} risks), plus ${totals.ml_hardening} collapsed as hardening

## Comments the team acted on (${totals.acted})

- Mergelight raised it as a bug or risk: ${totals.acted_caught} (${pct(totals.acted_caught, totals.acted)})
- Mergelight noted it as hardening: ${totals.acted_hardening}
- Mergelight didn't mention it: ${totals.acted_missed}

## Comments the team left alone (${totals.threads - totals.acted})

- Mergelight stayed quiet: ${totals.ignored_silent}
- Mergelight collapsed it as hardening: ${totals.ignored_hardening}
- Mergelight raised it as a bug or risk: ${totals.ignored_flagged}

## Mergelight findings no bot raised: ${totals.ml_new_visible}

## Per PR

| PR | Size | Bot comments | Acted on | ML bug / risk / hardening | Acted on, caught | Left alone, ML flagged | Light | Time |
|---|---|---|---|---|---|---|---|---|
${rows.join("\n")}

## Acted on, but Mergelight didn't raise it

${missed.map(({ number, t, as }) => `- #${number} [${as}] ${shortT(t)}`).join("\n") || "None"}

## Left alone by the team, raised by Mergelight

${disagreements.map(({ number, t, f }) => `- #${number} ${shortF(f)}\n  - bot said: ${shortT(t)}`).join("\n") || "None"}

## Raised only by Mergelight

${fresh.map(({ number, f }) => `- #${number} ${shortF(f)}\n  - how: ${f.how_it_happens}\n  - breaks: ${f.what_breaks}`).join("\n") || "None"}
`;

writeFileSync(join(dir, "report.md"), report);
process.stdout.write(report);
