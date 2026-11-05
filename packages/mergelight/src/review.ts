import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchPullRequest, type PrRef } from "./github.js";
import { buildHunterPrompt, buildVerifierPrompt, FOCUS, type Candidate, type Focus, type PromptInput } from "./prompt.js";
import { runCodex } from "./providers/codex.js";
import { candidateSchema, reviewSchema } from "./schema.js";
import type { Finding, Light, ModelFinding, ModelReview, Review, Tier } from "./types.js";
import { cacheDir, prepareWorkspace } from "./workspace.js";

export interface ReviewOptions {
  /** Review this commit of the PR instead of its latest one. */
  at?: string;
  model?: string;
  effort?: string;
  /** Keep the temporary checkout for inspection. */
  keep?: boolean;
  onProgress?: (message: string) => void;
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
 * Only bugs and likely risks worth fixing get their own comment. Everything
 * else is either a one-line decision in the summary or collapsed. Tuned on
 * eval data: rare risks and "decide" risks were rarely fixed by real teams.
 */
export function tierOf(f: ModelFinding): Tier {
  if (f.class === "hardening") return "hardening";
  if (f.class === "bug") return "post";
  if (f.recommendation === "fix" && (f.likelihood === "common" || f.likelihood === "plausible")) return "post";
  return "decision";
}

/** Red if a bug must be fixed, yellow if anything is posted or needs a decision, green otherwise. */
export function mergeLight(findings: Finding[]): Light {
  if (findings.some((f) => f.class === "bug" && f.recommendation === "fix")) return "red";
  if (findings.some((f) => f.tier !== "hardening" && f.recommendation !== "leave")) return "yellow";
  return "green";
}

const ORDER = { bug: 0, risk: 1, hardening: 2 } as const;

export async function reviewPullRequest(ref: PrRef, opts: ReviewOptions = {}): Promise<Review> {
  const started = Date.now();
  const progress = opts.onProgress ?? (() => {});

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
        const result = await runCodex({
          cwd: ws.dir,
          prompt: buildHunterPrompt(input, focus),
          schema: candidateSchema,
          model: opts.model,
          effort: opts.effort,
          logFile: log(`hunt-${focus}`),
        });
        done++;
        progress(`Hunting for problems (${done} of ${focuses.length} areas done)`);
        return { focus, candidates: (result.output as { candidates: Candidate[] }).candidates, model: result.model };
      }),
    );
    const failed = focuses.filter((_, i) => hunts[i]!.status === "rejected");
    if (failed.length === focuses.length) {
      throw (hunts[0] as PromiseRejectedResult).reason;
    }
    const found = hunts.flatMap((h) =>
      h.status === "fulfilled" ? h.value.candidates.map((c) => ({ ...c, focus: h.value.focus })) : [],
    );

    // Step 2: the verifier tries to disprove each candidate and sorts the rest.
    progress(`Checking ${found.length} candidate${found.length === 1 ? "" : "s"}`);
    const verdict = await runCodex({
      cwd: ws.dir,
      prompt: buildVerifierPrompt(input, found),
      schema: reviewSchema,
      model: opts.model,
      effort: opts.effort,
      logFile: log("verify"),
      onCommand: (cmd) => progress(`Checking ${found.length} candidates: ${cmd.replace(/\s+/g, " ").slice(0, 80)}`),
    });

    const model = verdict.output as ModelReview;
    const findings: Finding[] = model.findings
      .map((f) => ({ id: fingerprint(ws.dir, f), tier: tierOf(f), ...f }))
      .sort((a, b) => ORDER[a.class] - ORDER[b.class] || a.file.localeCompare(b.file) || a.line - b.line);

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
      provider: { name: "codex", model: verdict.model },
      light: mergeLight(findings),
      summary: model.summary,
      findings,
      stats: {
        duration_ms: Date.now() - started,
        diff_chars: ws.diff.length,
        files_changed: pr.changedFiles,
        additions: pr.additions,
        deletions: pr.deletions,
      },
      trace: {
        candidates: found.map((c) => ({ focus: c.focus, title: c.title, file: c.file, line: c.line })),
        rejected: model.rejected,
        failed_hunters: failed,
      },
      created_at: new Date().toISOString(),
    };
  } finally {
    if (opts.keep) progress(`Kept the checkout at ${ws.dir}`);
    else await ws.cleanup();
  }
}
