#!/usr/bin/env node
// Picks eval PRs from collect.mjs output and reviews each one with Mergelight
// at the commit the other bots reviewed, so the results line up.
//
//   node eval/run.mjs owner/repo [--count 20] [--concurrency 3] [--include 377] [--provider claude] [--model name] [--verify-with codex] [--verify-model name] [--effort level]

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    count: { type: "string", default: "20" },
    concurrency: { type: "string", default: "3" },
    include: { type: "string", default: "" },
    "max-additions": { type: "string", default: "4000" },
    tag: { type: "string", default: "" },
    "prs-file": { type: "string", default: "prs.json" },
    selection: { type: "string", default: "selection.json" },
    reuse: { type: "boolean", default: false },
    provider: { type: "string" },
    model: { type: "string" },
    "verify-with": { type: "string" },
    "verify-model": { type: "string" },
    effort: { type: "string" },
  },
});
const [repoArg] = positionals;
const [owner, name] = repoArg.split("/");
const dir = join(process.env.MERGELIGHT_CACHE ?? join(homedir(), ".cache", "mergelight"), "eval", `${owner}-${name}`);
const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const prs = JSON.parse(readFileSync(join(dir, values["prs-file"]), "utf8"));
const mlFile = (n) => join(dir, values.tag ? `ml-${values.tag}-${n}.json` : `ml-${n}.json`);

const isMergePr = (title) => /staging|^merge|release|back-merge|^development$|^sync /i.test(title);
const include = new Set(values.include.split(",").filter(Boolean).map(Number));

/** The commit that drew the most bot threads. Mergelight reviews that one. */
function targetCommit(pr) {
  const counts = new Map();
  for (const t of pr.threads) if (t.commit) counts.set(t.commit, (counts.get(t.commit) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

const reused = values.reuse ? JSON.parse(readFileSync(join(dir, values.selection), "utf8")) : null;
const candidates = reused
  ? reused.map((s) => ({ ...prs.find((p) => p.number === s.number), at: s.at }))
  : prs
  .filter((p) => include.has(p.number) || (!isMergePr(p.title) && p.additions <= Number(values["max-additions"])))
  .map((p) => ({ ...p, at: targetCommit(p) }))
  .filter((p) => p.at && (include.has(p.number) || p.threads.filter((t) => t.commit === p.at).length >= 2))
  .sort((a, b) => Number(include.has(b.number)) - Number(include.has(a.number)) ||
    b.threads.filter((t) => t.commit === b.at).length - a.threads.filter((t) => t.commit === a.at).length)
  .slice(0, Number(values.count));

if (!reused) writeFileSync(join(dir, values.selection), JSON.stringify(candidates.map((p) => ({ number: p.number, at: p.at })), null, 2));
console.error(`Reviewing ${candidates.length} PRs: ${candidates.map((p) => `#${p.number}`).join(" ")}`);

function review(pr) {
  const out = mlFile(pr.number);
  if (existsSync(out)) return Promise.resolve({ pr: pr.number, skipped: true });
  const started = Date.now();
  return new Promise((resolve) => {
    const args = [cli, "review", `${repoArg}#${pr.number}`, "--at", pr.at, "--json", "--out", out];
    if (values.provider) args.push("--provider", values.provider);
    if (values.model) args.push("--model", values.model);
    if (values["verify-with"]) args.push("--verify-with", values["verify-with"]);
    if (values["verify-model"]) args.push("--verify-model", values["verify-model"]);
    if (values.effort) args.push("--effort", values.effort);
    const child = spawn("node", args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      const secs = Math.round((Date.now() - started) / 1000);
      console.error(`#${pr.number} ${code === 0 || code === 2 ? "done" : `failed (${code})`} in ${secs}s${code === 0 || code === 2 ? "" : `\n${err.trim().split("\n").slice(-4).join("\n")}`}`);
      resolve({ pr: pr.number, code });
    });
  });
}

const queue = [...candidates];
await Promise.all(
  Array.from({ length: Number(values.concurrency) }, async () => {
    while (queue.length) await review(queue.shift());
  }),
);
console.error("All reviews finished.");
