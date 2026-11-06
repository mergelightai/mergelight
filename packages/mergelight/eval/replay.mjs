#!/usr/bin/env node
// Replays the verifier on candidates an earlier run already found, so two
// verifiers can be compared on exactly the same input. Hunters don't run again.
//
// Candidates come from the earlier review's trace, or, for reviews made before
// the trace kept them in full, from that review's hunter and sweep logs.
//
//   node eval/replay.mjs owner/repo --from v2 --tag replay-opus --with claude --model claude-opus-5-5
//   node eval/replay.mjs owner/repo --from v2 --tag x --check   # only rebuild and compare the candidates

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const { fetchPullRequest } = await import(join(dist, "github.js"));
const { prepareWorkspace } = await import(join(dist, "workspace.js"));
const { verifyCandidates, mergeLight, DEFAULT_EFFORT } = await import(join(dist, "review.js"));

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    from: { type: "string" },
    tag: { type: "string" },
    with: { type: "string", default: "codex" },
    model: { type: "string" },
    effort: { type: "string" },
    concurrency: { type: "string", default: "3" },
    selection: { type: "string", default: "selection.json" },
    check: { type: "boolean", default: false },
  },
});
const [repoArg] = positionals;
if (!repoArg || !values.from || !values.tag) {
  console.error("Usage: node eval/replay.mjs owner/repo --from <tag> --tag <new tag> [--with codex|claude] [--model name]");
  process.exit(1);
}
const [owner, name] = repoArg.split("/");
const cache = process.env.MERGELIGHT_CACHE ?? join(homedir(), ".cache", "mergelight");
const dir = join(cache, "eval", `${owner}-${name}`);
const logs = join(cache, "logs");
const selection = JSON.parse(readFileSync(join(dir, values.selection), "utf8"));
const effort = values.effort ?? DEFAULT_EFFORT;

/** The final JSON answer in a Codex event log. */
function lastAnswer(file) {
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.includes('"agent_message"'));
  return JSON.parse(JSON.parse(lines.at(-1)).item.text);
}

/** Rebuilds the full candidate list of an old review from its logs, in the order the verifier saw it. */
function candidatesFromLogs(review) {
  const end = Date.parse(review.created_at);
  const prefix = `${owner}-${name}-${review.pr.number}-`;
  const verify = readdirSync(logs)
    .filter((f) => f.startsWith(prefix) && f.endsWith("-verify.log"))
    .map((f) => ({ stamp: f.slice(0, -"-verify.log".length), off: Math.abs(statSync(join(logs, f)).mtimeMs - end) }))
    .sort((a, b) => a.off - b.off)[0];
  if (!verify || verify.off > 20_000) throw new Error("no matching logs");
  const steps = readdirSync(logs).filter((f) => f.startsWith(`${verify.stamp}-`) && !f.endsWith("-verify.log"));
  const order = (f) => {
    const m = f.match(/-(hunt-(access|data|behavior)|sweep-(\d+))\.log$/);
    return m[2] ? ["access", "data", "behavior"].indexOf(m[2]) : 10 + Number(m[3]);
  };
  return steps
    .sort((a, b) => order(a) - order(b))
    .flatMap((f) => {
      const focus = f.match(/-hunt-(\w+)\.log$/)?.[1] ?? "sweep";
      return lastAnswer(join(logs, f)).candidates.map((c) => ({ ...c, focus }));
    });
}

async function replay({ number }) {
  const src = join(dir, `ml-${values.from}-${number}.json`);
  const out = join(dir, `ml-${values.tag}-${number}.json`);
  if (!existsSync(src) || existsSync(out)) return;
  const old = JSON.parse(readFileSync(src, "utf8"));
  const found = old.trace.candidates[0]?.scenario !== undefined ? old.trace.candidates : candidatesFromLogs(old);
  const titles = (list) => list.map((c) => c.title).join("\n");
  if (found.length !== old.trace.candidates.length || titles(found) !== titles(old.trace.candidates)) {
    throw new Error(`#${number}: rebuilt ${found.length} candidates, the review recorded ${old.trace.candidates.length}`);
  }
  if (values.check) return console.error(`#${number} ok: ${found.length} candidates`);

  const pr = await fetchPullRequest({ owner, repo: name, number });
  const ws = await prepareWorkspace(pr, old.pr.head_sha);
  const started = Date.now();
  try {
    const input = { pr, mergeBase: ws.mergeBase, headSha: ws.headSha, diffStat: ws.diffStat, diff: ws.diff, diffTruncated: ws.diffTruncated };
    const v = await verifyCandidates(ws.dir, input, found, {
      provider: values.with,
      model: values.model,
      effort,
      logFile: join(logs, `replay-${values.tag}-${owner}-${name}-${number}.log`),
    });
    const review = {
      ...old,
      verifier: { name: values.with, model: v.model, effort, cost_usd: v.cost_usd },
      light: mergeLight(v.findings),
      summary: v.summary,
      findings: v.findings,
      trace: { ...old.trace, candidates: found, rejected: v.rejected },
      replay: { from: values.from, verify_ms: Date.now() - started },
      created_at: new Date().toISOString(),
    };
    writeFileSync(out, JSON.stringify(review, null, 2));
    const ranked = v.findings.filter((f) => f.rank).length;
    console.error(`#${number} ${found.length} candidates -> ${v.findings.length} findings, ${ranked} top picks, in ${Math.round((Date.now() - started) / 1000)}s`);
  } finally {
    await ws.cleanup();
  }
}

const queue = [...selection];
await Promise.all(
  Array.from({ length: Number(values.concurrency) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await replay(item).catch((err) => console.error(`#${item.number} failed: ${err.message.split("\n")[0]}`));
    }
  }),
);
console.error("Replay finished.");
