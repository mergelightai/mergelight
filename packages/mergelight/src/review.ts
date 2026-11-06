import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchPullRequest, type PrRef } from "./github.js";
import {
  buildHunterPrompt,
  buildSweepPrompt,
  buildVerifierPrompt,
  FOCUS,
  type Candidate,
  type Focus,
  type PromptInput,
} from "./prompt.js";
import { claudeAvailable, runModel, TOOLING, type ProviderName } from "./providers/index.js";
import { candidateSchema, reviewSchema } from "./schema.js";
import type { Finding, Light, ModelFinding, ModelReview, Review, Tier } from "./types.js";
import { cacheDir, prepareWorkspace } from "./workspace.js";

export interface ReviewOptions {
  /** Review this commit of the PR instead of its latest one. */
  at?: string;
  model?: string;
  /** Reasoning effort for every Codex run. Defaults to high, whatever the user's Codex config says. */
  effort?: string;
  /** Who checks and sorts the candidates. Defaults to Claude when Claude Code is installed, else Codex. */
  verifyWith?: ProviderName;
  /** Model for the verifier. Defaults to the latest Opus on Claude, and to the hunters' model on Codex. */
  verifyModel?: string;
  /** Keep the temporary checkout for inspection. */
  keep?: boolean;
  /** Progress messages. transient ones (the command the agent is running) are only worth showing live. */
  onProgress?: (message: string, transient?: boolean) => void;
}

/**
 * Stable id for a finding: the file plus the code it points at, ignoring
 * whitespace. It survives line shifts, so later review rounds can tell an old
 * finding from a new one.
 */
function fingerprint(dir: string, f: ModelFinding): string {
  let code = "";
  try {
    const lines = readFileSync(join(dir, f.file), "utf8").split("\n");
    const start = Math.max(1, Math.min(f.line, f.end_line));
    const end = Math.min(lines.length, Math.max(f.line, f.end_line), start + 30);
    code = lines.slice(start - 1, end).join("\n").replace(/\s+/g, " ").trim();
  } catch {
    code = f.title.toLowerCase();
  }
  return createHash("sha1").update(`${f.file}\n${f.class}\n${code}`).digest("hex").slice(0, 10);
}

/**
 * Only the verifier's top picks (at most 3 per PR) get their own comment. Other
 * findings it says to fix are listed in the summary, decide becomes a "your
 * call" line and leave is collapsed. In the eval, among problems only Mergelight
 * raised, teams fixed 38% of Opus's top picks and 14% of its other findings.
 * Posting everything it would fix meant about 4.5 comments per PR, and all of
 * Codex's about 6.
 */
export function tierOf(f: ModelFinding & { rank?: number | null }): Tier {
  if (f.rank) return "post";
  if (f.recommendation === "fix") return "list";
  if (f.recommendation === "decide") return "decision";
  return "hardening";
}

/** Red if a major bug must be fixed, yellow if anything else is posted or needs a decision, green otherwise. */
export function mergeLight(findings: Finding[]): Light {
  if (findings.some((f) => f.class === "bug" && f.severity !== "minor" && f.recommendation === "fix")) return "red";
  if (findings.some((f) => f.tier !== "hardening")) return "yellow";
  return "green";
}

/** Tests and docs aren't swept: missing tests are never reported, and docs rarely hold real problems. */
const SKIP_SWEEP = /(^|\/)(test|tests|__tests__|e2e|docs?)\/|\.(spec|test)\.[cm]?[jt]sx?$|\.(md|mdx|txt)$/i;
const SWEEP_CHUNK = 12;
const SWEEP_MAX_RUNS = 3;

function normalizePath(p: string): string {
  return p.replace(/^\.\//, "").replace(/^\/+/, "");
}

const ORDER = { bug: 0, risk: 1, hardening: 2 } as const;

/**
 * High, not the Codex default. In the eval, gpt-6.1-sol (whose own default is
 * low) found 41 of 51 fixed problems at high, 32 at medium and 29 at low.
 */
export const DEFAULT_EFFORT = "high";

export interface VerifyOptions {
  provider: ProviderName;
  model?: string;
  effort: string;
  logFile?: string;
  onCommand?: (command: string) => void;
}

export interface Verified {
  summary: string;
  findings: Finding[];
  rejected: ModelReview["rejected"];
  model: string | null;
  cost_usd: number | null;
}

/**
 * The verifier: tries to disprove every candidate, merges duplicates, rates the
 * rest and picks the few that matter most. Exported so the eval can replay the
 * same candidates through another model.
 */
export async function verifyCandidates(dir: string, input: PromptInput, found: Candidate[], opts: VerifyOptions): Promise<Verified> {
  const tooling = TOOLING[opts.provider];
  let diffFile: string | undefined;
  if (tooling === "files" && input.diffTruncated) {
    // Without a shell the agent can't run git diff, so the full diff goes into the checkout.
    diffFile = ".mergelight/pr.diff";
    mkdirSync(join(dir, ".mergelight"), { recursive: true });
    writeFileSync(join(dir, diffFile), input.diff);
  }
  const result = await runModel(opts.provider, {
    cwd: dir,
    prompt: buildVerifierPrompt({ ...input, tooling, diffFile }, found),
    schema: reviewSchema,
    model: opts.model,
    effort: opts.effort,
    logFile: opts.logFile,
    onCommand: opts.onCommand,
  });
  const review = result.output as ModelReview;
  const top = [...new Set((review.top ?? []).filter((n) => Number.isInteger(n) && n >= 1 && n <= review.findings.length))].slice(0, 3);
  const findings: Finding[] = review.findings
    .map((f, i) => {
      const rank = top.includes(i + 1) ? top.indexOf(i + 1) + 1 : null;
      return { id: fingerprint(dir, f), tier: tierOf({ ...f, rank }), rank, ...f };
    })
    .sort((a, b) => ORDER[a.class] - ORDER[b.class] || a.file.localeCompare(b.file) || a.line - b.line);
  return { summary: review.summary, findings, rejected: review.rejected, model: result.model, cost_usd: result.cost_usd ?? null };
}

export async function reviewPullRequest(ref: PrRef, opts: ReviewOptions = {}): Promise<Review> {
  const started = Date.now();
  const progress = opts.onProgress ?? (() => {});
  const effort = opts.effort ?? DEFAULT_EFFORT;

  progress(`Reading ${ref.owner}/${ref.repo}#${ref.number}`);
  const pr = await fetchPullRequest(ref);

  progress("Checking out the code");
  const ws = await prepareWorkspace(pr, opts.at);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const log = (step: string) => join(cacheDir(), "logs", `${pr.owner}-${pr.repo}-${pr.number}-${stamp}-${step}.log`);

  try {
    const input: PromptInput = {
      pr,
      mergeBase: ws.mergeBase,
      headSha: ws.headSha,
      diffStat: ws.diffStat,
      diff: ws.diff,
      diffTruncated: ws.diffTruncated,
    };

    // Step 1: hunters, one per area, in parallel. One failing doesn't sink the review.
    const focuses = Object.keys(FOCUS) as Focus[];
    let done = 0;
    progress(`Hunting for problems (0 of ${focuses.length} areas done)`);
    const hunts = await Promise.allSettled(
      focuses.map(async (focus) => {
        const result = await runModel("codex", {
          cwd: ws.dir,
          prompt: buildHunterPrompt(input, focus),
          schema: candidateSchema,
          model: opts.model,
          effort,
          logFile: log(`hunt-${focus}`),
        });
        done++;
        progress(`Hunting for problems (${done} of ${focuses.length} areas done)`);
        return { focus, candidates: (result.output as { candidates: Candidate[] }).candidates, model: result.model };
      }),
    );
    const failed: string[] = focuses.filter((_, i) => hunts[i]!.status === "rejected");
    if (failed.length === focuses.length) {
      throw (hunts[0] as PromiseRejectedResult).reason;
    }
    const found: (Candidate & { focus: string })[] = hunts.flatMap((h) =>
      h.status === "fulfilled" ? h.value.candidates.map((c) => ({ ...c, focus: h.value.focus as string })) : [],
    );

    // Step 1b: sweep changed files no hunter reported anything in.
    const covered = new Set(found.map((c) => normalizePath(c.file)));
    const uncovered = ws.changedFiles
      .filter((f) => f.added > 0 && !covered.has(f.path) && !SKIP_SWEEP.test(f.path))
      .sort((a, b) => b.added - a.added)
      .slice(0, SWEEP_CHUNK * SWEEP_MAX_RUNS)
      .map((f) => f.path);
    if (uncovered.length) {
      const chunks: string[][] = [];
      for (let i = 0; i < uncovered.length; i += SWEEP_CHUNK) chunks.push(uncovered.slice(i, i + SWEEP_CHUNK));
      progress(`Sweeping ${uncovered.length} file${uncovered.length === 1 ? "" : "s"} the hunters didn't mention`);
      const sweeps = await Promise.allSettled(
        chunks.map((files, i) =>
          runModel("codex", {
            cwd: ws.dir,
            prompt: buildSweepPrompt(input, files),
            schema: candidateSchema,
            model: opts.model,
            effort,
            logFile: log(`sweep-${i + 1}`),
          }),
        ),
      );
      sweeps.forEach((s, i) => {
        if (s.status === "fulfilled") {
          for (const c of (s.value.output as { candidates: Candidate[] }).candidates) found.push({ ...c, focus: "sweep" });
        } else {
          failed.push(`sweep-${i + 1}`);
        }
      });
    }

    // Step 2: the verifier tries to disprove each candidate and sorts the rest.
    // Opus checks better than Codex: in the eval it posted a third less and kept the same finds.
    const verifyWith = opts.verifyWith ?? ((await claudeAvailable()) ? "claude" : "codex");
    if (!opts.verifyWith && verifyWith === "codex") progress("Claude Code isn't installed, so Codex checks the findings");
    progress(`Checking ${found.length} candidate${found.length === 1 ? "" : "s"}${verifyWith === "codex" ? "" : ` with ${verifyWith}`}`);
    const verified = await verifyCandidates(ws.dir, input, found, {
      provider: verifyWith,
      model: verifyWith === "codex" ? (opts.verifyModel ?? opts.model) : (opts.verifyModel ?? "opus"),
      effort,
      logFile: log("verify"),
      onCommand: (cmd) => progress(`Checking ${found.length} candidates: ${cmd.replace(/\s+/g, " ").slice(0, 80)}`, true),
    });
    const firstHunt = hunts.find((h) => h.status === "fulfilled");
    const hunterModel = firstHunt?.status === "fulfilled" ? firstHunt.value.model : null;

    return {
      schema_version: 1,
      pr: {
        owner: pr.owner,
        repo: pr.repo,
        number: pr.number,
        title: pr.title,
        url: pr.url,
        base_sha: ws.mergeBase,
        head_sha: ws.headSha,
      },
      provider: { name: "codex", model: hunterModel, effort },
      verifier: { name: verifyWith, model: verified.model, effort, cost_usd: verified.cost_usd },
      light: mergeLight(verified.findings),
      summary: verified.summary,
      findings: verified.findings,
      stats: {
        duration_ms: Date.now() - started,
        diff_chars: ws.diff.length,
        files_changed: pr.changedFiles,
        additions: pr.additions,
        deletions: pr.deletions,
      },
      trace: {
        candidates: found,
        rejected: verified.rejected,
        failed_hunters: failed,
      },
      created_at: new Date().toISOString(),
    };
  } finally {
    if (opts.keep) progress(`Kept the checkout at ${ws.dir}`);
    else await ws.cleanup();
  }
}
