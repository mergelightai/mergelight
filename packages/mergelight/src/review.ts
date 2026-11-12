import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { actionsUsedBy, fetchActionSources, notRead, type NotRead } from "./action-source.js";
import { fetchPullRequest, type PrRef } from "./github.js";
import {
  buildCheckPrompt,
  buildHunterPrompt,
  buildSweepPrompt,
  buildVerifierPrompt,
  focusesFor,
  type Candidate,
  type PriorFinding,
  type PromptInput,
  ruleApplies,
  type TeamCheck,
  type TeamMemory,
  type TeamRule,
  usedMemories,
} from "./prompt.js";
import { LimitError, LoginError } from "./providers/codex.js";
import { MAX_REPO_RULES } from "./repo-rules.js";
import { claudeAvailable, runModel as runOneModel, TOOLING, type ModelOptions, type ModelResult, type ProviderName } from "./providers/index.js";
import { candidateSchema, checkSchema, reviewSchema, reviewSchemaWithDecisions } from "./schema.js";
import { CHECK_TIMEOUT_MS, startTeamChecks, type ChecksRun } from "./checks.js";
import { run } from "./run.js";
import type { Finding, Light, ModelFinding, ModelReview, Review, TeamCheckResult, Tier } from "./types.js";
import { cacheDir, prepareWorkspace } from "./workspace.js";
import type { WrittenSkill } from "./skills.js";

export interface ReviewOptions {
  /** Review this commit of the PR instead of its latest one. */
  at?: string;
  /** Who hunts for problems: codex, the default, or claude. */
  provider?: ProviderName;
  model?: string;
  /** Reasoning effort for every Codex run. Defaults to high, whatever the user's Codex config says. */
  effort?: string;
  /** Who checks and sorts the candidates. Defaults to Claude when the hunters are Claude or Claude Code is installed, else Codex. */
  verifyWith?: ProviderName;
  /** Model for the verifier. Defaults to the latest Opus on Claude, and to the hunters' model on Codex. */
  verifyModel?: string;
  /** What earlier review rounds of this pull request found. The verifier checks each one again. */
  previous?: PriorFinding[];
  /** Findings the team declined in earlier pull requests. Only those in files this one changes reach the verifier. */
  memories?: TeamMemory[];
  /** The team's rules. Only those about files this pull request changes are used. */
  rules?: TeamRule[];
  /** True when the team's server couldn't be asked for its rules and decisions. The summary then says so. */
  rulesUnread?: boolean;
  /** Skill folders in the repository that the team picked for reviews. They are read from the base branch. */
  skills?: string[];
  /** Skills the team wrote on its dashboard. Their text comes from the team's server, not from the repository. */
  writtenSkills?: WrittenSkill[];
  /** The team's own checks. Each one that is about a changed file is asked in an AI run of its own. */
  checks?: TeamCheck[];
  /**
   * Called with the checks' answers when the review ends, also when it ends in an error. The answers
   * a failed review already has are then still worth posting.
   */
  onTeamChecks?: (results: TeamCheckResult[]) => void;
  /** Keep the temporary checkout for inspection. */
  keep?: boolean;
  /** Progress messages. transient ones (the command the agent is running) are only worth showing live. */
  onProgress?: (message: string, transient?: boolean) => void;
  /** Called once the models are known: after the first reviewer answers, and before the checker starts. */
  onModels?: (models: { reviewer: { name: ProviderName; model: string | null }; checker: { name: ProviderName; model: string | null } }) => void;
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
 * Gives each finding its id. One the verifier matched to an earlier round keeps
 * that round's id and title, so it stays one comment however the model words or
 * locates it this time: a fingerprint alone changes whenever the model cites
 * slightly different lines.
 */
export function assignIds(
  findings: ModelReview["findings"],
  previous: PriorFinding[],
  fingerprintOf: (f: ModelFinding) => string,
): (ModelFinding & { id: string })[] {
  const known = new Map(previous.map((p) => [p.id, p]));
  const used = new Set<string>();
  const matched = findings.map((f) => {
    const prior = f.same_as && !used.has(f.same_as) ? known.get(f.same_as) : undefined;
    if (prior) used.add(prior.id);
    return prior;
  });
  return findings.map(({ same_as: _, ...f }, i) => {
    const prior = matched[i];
    if (prior) return { ...f, id: prior.id, title: prior.title };
    let id = fingerprintOf(f);
    // Two findings on the same code still need their own ids.
    for (let n = 1; used.has(id); n++) id = createHash("sha1").update(`${id}${n}`).digest("hex").slice(0, 10);
    used.add(id);
    return { ...f, id };
  });
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
  // Teams fixed few of these: 19% of minor risks and 10% of rare findings, against 45% of minor bugs. They stay
  // readable in the collapsed section, and a major bug is never hidden, because it decides the red light.
  const majorBug = f.class === "bug" && f.severity !== "minor";
  if (!majorBug && ((f.class === "risk" && f.severity === "minor") || f.likelihood === "rare")) return "hardening";
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

/** Every token a review's model calls used: hunters, sweeps, the team's checks and the verifier. */
export interface TokenTally {
  input: number;
  cached: number;
  output: number;
}

function counting(tally: TokenTally) {
  return (provider: ProviderName, opts: ModelOptions): Promise<ModelResult> =>
    runOneModel(provider, opts).then((r) => {
      tally.input += r.usage?.input_tokens ?? 0;
      tally.cached += r.usage?.cached_input_tokens ?? 0;
      tally.output += r.usage?.output_tokens ?? 0;
      return r;
    });
}

export interface Verified {
  usage: ModelResult["usage"];
  summary: string;
  findings: Finding[];
  rejected: ModelReview["rejected"];
  model: string | null;
  cost_usd: number | null;
}

/** Tells the prompts which tools the agent has. Without a shell it can't run git diff, so a big diff goes into the checkout. */
function forProvider(dir: string, input: PromptInput, provider: ProviderName): PromptInput {
  const tooling = TOOLING[provider];
  if (tooling !== "files" || !input.diffTruncated) return { ...input, tooling };
  const diffFile = ".mergelight/pr.diff";
  mkdirSync(join(dir, ".mergelight"), { recursive: true });
  writeFileSync(join(dir, diffFile), input.diff);
  return { ...input, tooling, diffFile };
}

/** The diff one of the team's checks reads: at most this much of it goes into the question. */
const MAX_CHECK_DIFF = 150_000;

/**
 * The whole change to the files a check is about. Unlike the reviewers' diff it leaves nothing out:
 * a check that names a lockfile or a generated file must see what changed in it, removed lines included.
 */
async function checkDiff(dir: string, base: string, head: string, files: string[]): Promise<{ text: string; cut: boolean; missing?: boolean }> {
  // The names come from git itself and go back to it as they are: never as options, never as patterns.
  const r = await run("git", ["--literal-pathspecs", "-C", dir, "diff", "-U5", "--no-color", "--no-ext-diff", "--no-renames", `${base}...${head}`, "--", ...files.slice(0, 50)], { timeoutMs: 60_000 });
  if (r.code !== 0) return { text: "", cut: true, missing: true };
  return r.stdout.length > MAX_CHECK_DIFF ? { text: r.stdout.slice(0, MAX_CHECK_DIFF), cut: true } : { text: r.stdout, cut: files.length > 50 };
}

/**
 * The verifier: tries to disprove every candidate, merges duplicates, rates the
 * rest and picks the few that matter most. Exported so the eval can replay the
 * same candidates through another model.
 */
export async function verifyCandidates(dir: string, input: PromptInput, found: Candidate[], opts: VerifyOptions): Promise<Verified> {
  const result = await runOneModel(opts.provider, {
    cwd: dir,
    prompt: buildVerifierPrompt(forProvider(dir, input, opts.provider), found),
    // Only a verifier that was given the team's earlier decisions is asked which one it used.
    schema: input.memories?.length ? reviewSchemaWithDecisions : reviewSchema,
    model: opts.model,
    effort: opts.effort,
    logFile: opts.logFile,
    onCommand: opts.onCommand,
  });
  const review = result.output as ModelReview;
  const top = [...new Set((review.top ?? []).filter((n) => Number.isInteger(n) && n >= 1 && n <= review.findings.length))].slice(0, 3);
  const findings: Finding[] = assignIds(review.findings, input.previous ?? [], (f) => fingerprint(dir, f))
    .map((f, i) => {
      const rank = top.includes(i + 1) ? top.indexOf(i + 1) + 1 : null;
      return { ...f, tier: tierOf({ ...f, rank }), rank };
    })
    .sort((a, b) => ORDER[a.class] - ORDER[b.class] || a.file.localeCompare(b.file) || a.line - b.line);
  return { summary: review.summary, findings, rejected: review.rejected, model: result.model, cost_usd: result.cost_usd ?? null, usage: result.usage };
}

/** Every rule a team can have for one repository: 50 for the org and 50 of its own on the dashboard, and those in its rule files. None is dropped. */
const MAX_RULES = 100 + MAX_REPO_RULES;

/** The summary, with what the reader must know about the team's rules: a guarded file was changed, or the rules couldn't be read. */
export function summaryWith(summary: string, needsHuman: string[], rulesUnread: boolean): string {
  // As code, so a name like __init__.py shows as it is and not as bold text.
  const code = (path: string) => `\`${path.replace(/`/g, "'").replace(/[\u0000-\u001f\u007f]/g, "?")}\``;
  const guarded = needsHuman.length
    ? ` It changes ${needsHuman.slice(0, 3).map(code).join(", ")}${needsHuman.length > 3 ? ` and ${needsHuman.length - 3} more` : ""}, which your team marked as always needing a human.`
    : "";
  // A team may have rules that would have changed this review. Running without them must never be silent.
  const unread = rulesUnread ? " Mergelight couldn't get your team's rules, skills, checks and earlier decisions from its server, so this review ran without them." : "";
  return `${summary}${guarded}${unread}`;
}

/**
 * The light, with the team's "always needs a human" files taken into account. Such a file keeps a
 * pull request from going green by itself. It never makes a light better: red stays red.
 */
export function lightWith(findings: Finding[], needsHuman: string[]): Light {
  const light = mergeLight(findings);
  return light === "green" && needsHuman.length ? "yellow" : light;
}

/** The changed files that match a "needs a human" rule of the team. */
export function filesNeedingHuman(rules: TeamRule[] | undefined, changedFiles: string[]): string[] {
  const guards = (rules ?? []).filter((r) => r.kind === "needs_human" && r.paths?.length);
  return changedFiles.filter((file) => guards.some((r) => ruleApplies(r, [file])));
}

/** Most recent first, as the server sends them. Enough for the files of one pull request, and not a wall of old decisions. */
const MAX_MEMORIES = 30;

/**
 * A decision is about one problem in one file, so only those in files this pull request changes are
 * passed on. One made on this very pull request is left out: the verifier already gets it with the
 * earlier rounds, and reviewing its own pull request again must not count as a use that keeps it alive.
 */
export function memoriesFor(memories: TeamMemory[] | undefined, changedFiles: string[], pullRequest?: number): TeamMemory[] {
  // The same file, however its path was written down: src/a.ts, ./src/a.ts or /src/a.ts.
  const plain = (path: string) => path.replace(/^(\.\/|\/)+/, "");
  const changed = new Set(changedFiles.map(plain));
  return (memories ?? []).filter((m) => changed.has(plain(m.file)) && m.pr !== pullRequest).slice(0, MAX_MEMORIES);
}

export async function reviewPullRequest(ref: PrRef, opts: ReviewOptions = {}): Promise<Review> {
  const started = Date.now();
  const progress = opts.onProgress ?? (() => {});
  const tokens: TokenTally = { input: 0, cached: 0, output: 0 };
  const runModel = counting(tokens);
  const effort = opts.effort ?? DEFAULT_EFFORT;
  const provider = opts.provider ?? "codex";
  const hunterModel = provider === "claude" ? (opts.model ?? "opus") : opts.model;

  progress(`Reading ${ref.owner}/${ref.repo}#${ref.number}`);
  const pr = await fetchPullRequest(ref);

  progress("Checking out the code");
  const ws = await prepareWorkspace(pr, opts.at, opts.skills, opts.writtenSkills);
  const skillsMissing = (opts.skills?.length ?? 0) - ws.skills.length;
  if (skillsMissing > 0) progress(`${skillsMissing} of the skill folders your team picked ${skillsMissing === 1 ? "has" : "have"} no SKILL.md on the base branch, or couldn't be read: left out. Name the real folder, not a link to it`);
  const teamSkills = [...ws.skills, ...ws.writtenSkills];
  if (teamSkills.length) progress(`Using your team's skill${teamSkills.length === 1 ? "" : "s"}: ${teamSkills.map((s) => s.name).join(", ")}`);
  if (ws.conventions.length) progress(`Using ${ws.conventions.map((c) => c.path).join(", ")} from ${pr.baseRef}`);
  const ruleFiles = [...new Set(ws.rules.filter((r) => ruleApplies(r, ws.touchedPaths)).map((r) => r.source))];
  if (ruleFiles.length) progress(`Using the rules in ${ruleFiles.join(", ")} from ${pr.baseRef}`);
  if (ws.droppedRules) progress(`Left out ${ws.droppedRules} of the repository's rules for this change: over the limit of ${MAX_REPO_RULES} rules or 30,000 characters`);
  if (ws.unreadRules.length) progress(`Found no rules to use in ${ws.unreadRules.slice(0, 10).join(", ")}${ws.unreadRules.length > 10 ? ` and ${ws.unreadRules.length - 10} more` : ""}: empty, too large, a link out of the repository, a Copilot file without applyTo or kept out of code review, past the limit of 100 rule files, or unreadable`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const log = (step: string) => join(cacheDir(), "logs", `${pr.owner}-${pr.repo}-${pr.number}-${stamp}-${step}.log`);
  let checksRun: ChecksRun | null = null;

  try {
    const input: PromptInput = {
      pr,
      mergeBase: ws.mergeBase,
      headSha: ws.headSha,
      diffStat: ws.diffStat,
      diff: ws.diff,
      diffTruncated: ws.diffTruncated,
      previous: opts.previous,
      memories: memoriesFor(opts.memories, ws.changedFiles.map((f) => f.path), pr.number),
      // Matched against every path the pull request touches, exactly as git has it.
      skills: teamSkills,
      conventions: ws.conventions,
      // The dashboard's rules, then the ones written in the repository.
      rules: [...(opts.rules ?? []), ...ws.rules].filter((r) => r.kind === "rule" && ruleApplies(r, ws.touchedPaths)).slice(0, MAX_RULES),
    };

    // Step 1: hunters, one per area, in parallel. One failing doesn't sink the review.
    const addedTo = ws.changedFiles.filter((f) => f.added > 0).map((f) => f.path);
    const focuses = focusesFor(addedTo);
    let unread: NotRead[] = [];
    if (focuses.includes("supply")) {
      const uses = actionsUsedBy(ws.dir, addedTo);
      if (uses.length) progress("Reading the source of the actions these workflows use");
      input.actionSources = await fetchActionSources(uses);
      unread = notRead(input.actionSources);
    }
    // Who checks is known before the hunt, so the first reviewer that answers can name both models.
    const verifyWith = opts.verifyWith ?? (provider === "claude" || (await claudeAvailable()) ? "claude" : "codex");
    const verifyModel = verifyWith === "codex" ? (opts.verifyModel ?? opts.model) : (opts.verifyModel ?? "opus");
    let named = false;
    const nameModels = (reviewerModel: string | null) => {
      if (named) return;
      named = true;
      // The same tool with no model of its own, or an alias of the one that answered ("opus" for
      // "claude-opus-5-5"), is the same model: the comment mustn't say a second one checks.
      const sameModel =
        verifyWith === provider && (!verifyModel || verifyModel === reviewerModel || (!/\d/.test(verifyModel) && (reviewerModel ?? "").includes(verifyModel)));
      opts.onModels?.({
        reviewer: { name: provider, model: reviewerModel },
        checker: { name: verifyWith, model: sameModel ? reviewerModel : (verifyModel ?? null) },
      });
    };
    let done = 0;
    progress(`Hunting for problems (0 of ${focuses.length} areas done)`);
    const hunts = await Promise.allSettled(
      focuses.map(async (focus) => {
        const result = await runModel(provider, {
          cwd: ws.dir,
          prompt: buildHunterPrompt(forProvider(ws.dir, input, provider), focus),
          schema: candidateSchema,
          model: hunterModel,
          effort,
          logFile: log(`hunt-${focus}`),
        });
        done++;
        nameModels(result.model ?? hunterModel ?? null);
        progress(`Hunting for problems (${done} of ${focuses.length} areas done)`);
        return { focus, candidates: (result.output as { candidates: Candidate[] }).candidates, model: result.model };
      }),
    );
    const failed: string[] = focuses.filter((_, i) => hunts[i]!.status === "rejected");
    if (failed.length === focuses.length) {
      const reasons = hunts.map((h) => (h as PromiseRejectedResult).reason);
      throw reasons.find((r) => r instanceof LoginError) ?? reasons.find((r) => r instanceof LimitError) ?? reasons[0];
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
          runModel(provider, {
            cwd: ws.dir,
            prompt: buildSweepPrompt(forProvider(ws.dir, input, provider), files),
            schema: candidateSchema,
            model: hunterModel,
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

    // The team's own checks run next to the verifier. They never fail the review and never hold it up
    // for long: each ends as an answer or as an error of its own.
    const teamChecks = opts.checks?.length
      ? startTeamChecks(
          opts.checks,
          ws.touchedPaths,
          async (check, files) =>
            (
              await runModel(provider, {
                cwd: ws.dir,
                prompt: buildCheckPrompt({ ...input, tooling: TOOLING[provider] }, check, files, await checkDiff(ws.dir, ws.mergeBase, ws.headSha, files)),
                schema: checkSchema,
                model: hunterModel,
                effort,
                logFile: log(`check-${check.id}`),
                timeoutMs: CHECK_TIMEOUT_MS,
                projectDocs: false,
              })
            ).output,
          progress,
        )
      : null;
    checksRun = teamChecks;

    // Step 2: the verifier tries to disprove each candidate and sorts the rest.
    // Opus checks better than Codex: in the eval it posted a third less and kept the same finds.
    if (!opts.verifyWith && verifyWith === "codex") progress("Claude Code isn't installed, so Codex checks the findings");
    progress(`Checking ${found.length} candidate${found.length === 1 ? "" : "s"}${verifyWith === "codex" ? "" : ` with ${verifyWith}`}`);
    const verified = await verifyCandidates(ws.dir, input, found, {
      provider: verifyWith,
      model: verifyModel,
      effort,
      logFile: log("verify"),
      onCommand: (cmd) => progress(`Checking ${found.length} candidates: ${cmd.replace(/\s+/g, " ").slice(0, 80)}`, true),
    });
    // Every path the pull request touches counts here, the lockfiles and generated files the reviewers skip included.
    const needsHuman = filesNeedingHuman(opts.rules, ws.touchedPaths);
    const team_checks = teamChecks ? await teamChecks.done : null;
    tokens.input += verified.usage?.input_tokens ?? 0;
    tokens.cached += verified.usage?.cached_input_tokens ?? 0;
    tokens.output += verified.usage?.output_tokens ?? 0;
    const firstHunt = hunts.find((h) => h.status === "fulfilled");
    const servedModel = firstHunt?.status === "fulfilled" ? firstHunt.value.model : null;

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
      provider: { name: provider, model: servedModel, effort },
      verifier: { name: verifyWith, model: verified.model, effort, cost_usd: verified.cost_usd },
      light: lightWith(verified.findings, needsHuman),
      summary: summaryWith(verified.summary, needsHuman, opts.rulesUnread === true),
      ...(needsHuman.length ? { needs_human: needsHuman } : {}),
      findings: verified.findings,
      ...(input.memories?.length ? { used_memories: usedMemories(input.memories, verified.rejected, found) } : {}),
      ...(team_checks?.length ? { team_checks } : {}),
      ...(unread.length ? { not_read: unread } : {}),
      stats: {
        duration_ms: Date.now() - started,
        diff_chars: ws.diff.length,
        files_changed: pr.changedFiles,
        additions: pr.additions,
        deletions: pr.deletions,
        tokens: { ...tokens },
      },
      trace: {
        candidates: found,
        rejected: verified.rejected,
        failed_hunters: failed,
      },
      created_at: new Date().toISOString(),
    };
  } finally {
    // The checkout is about to go. A check that is still waiting for its turn must not start in it.
    // What the checks answered so far goes to the caller, whether the review worked or not.
    if (checksRun) {
      (checksRun as ChecksRun).stop();
      opts.onTeamChecks?.(await (checksRun as ChecksRun).done);
    }
    if (opts.keep) progress(`Kept the checkout at ${ws.dir}`);
    else await ws.cleanup();
  }
}
