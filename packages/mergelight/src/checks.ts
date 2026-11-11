import { matchesPath, type TeamCheck } from "./prompt.js";
import type { TeamCheckResult } from "./types.js";

/** A repository's checks that a review runs. Each one that applies is an AI run of its own. */
export const MAX_CHECKS = 5;
const MAX_PROBLEMS = 10;
/** How many of them ask the AI at the same time. */
const AT_ONCE = 2;
/** One check gets this long, and all of them together this long. A review never waits for its checks beyond that. */
export const CHECK_TIMEOUT_MS = 6 * 60_000;
export const ALL_CHECKS_TIMEOUT_MS = 12 * 60_000;

/** The changed files a check is about. None means the check has nothing to look at in this pull request. */
export function filesOf(check: TeamCheck, touched: string[]): string[] {
  return touched.filter((file) => check.paths.some((pattern) => matchesPath(pattern, file)));
}

/** One line of the model's words, cut to size. Whatever it is, it ends up as text on GitHub. */
function words(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max).trim() : "";
}

/**
 * Reads the model's answer to a check. An answer that isn't shaped right is no answer: the check
 * then ends as an error, never as a pass.
 */
export function readAnswer(output: unknown): Pick<TeamCheckResult, "outcome" | "summary" | "problems"> | null {
  const o = output as { verdict?: unknown; summary?: unknown; problems?: unknown } | null;
  if (!o || typeof o !== "object" || (o.verdict !== "pass" && o.verdict !== "fail" && o.verdict !== "unsure")) return null;
  const summary = words(o.summary, 600);
  if (!summary) return null;
  const problems: TeamCheckResult["problems"] = [];
  if (o.verdict === "fail" && Array.isArray(o.problems)) {
    for (const raw of o.problems.slice(0, MAX_PROBLEMS)) {
      const p = raw as { file?: unknown; line?: unknown; note?: unknown } | null;
      const file = words(p?.file, 300);
      const note = words(p?.note, 400);
      if (!file || !note) continue;
      const line = typeof p?.line === "number" && Number.isSafeInteger(p.line) && p.line > 0 ? p.line : 0;
      problems.push({ file, line, note });
    }
  }
  return { outcome: o.verdict, summary, problems };
}

export interface ChecksRun {
  /** Every check's result, in the order of the checks. It never rejects. */
  done: Promise<TeamCheckResult[]>;
  /** Ends the run now: no further check is started, and one that hasn't answered yet ends as an error. */
  stop: () => void;
}

/**
 * Runs the team's checks on a pull request. ask puts one check to the AI and resolves with its
 * answer. Nothing here throws, and nothing here outlasts its time: a check that can't be run, or
 * that takes too long, ends as an error of its own, and the review it belongs to goes on.
 */
export function startTeamChecks(
  checks: TeamCheck[],
  touched: string[],
  ask: (check: TeamCheck, files: string[]) => Promise<unknown>,
  onProgress: (message: string) => void = () => {},
  limits: { each: number; all: number } = { each: CHECK_TIMEOUT_MS, all: ALL_CHECKS_TIMEOUT_MS },
): ChecksRun {
  const list = checks.slice(0, MAX_CHECKS);
  const results: (TeamCheckResult | undefined)[] = new Array(list.length).fill(undefined);
  const base = (check: TeamCheck) => ({ id: check.id, name: check.name, text: check.text });
  let over: string | null = null;
  let finish: (all: TeamCheckResult[]) => void = () => {};
  const done = new Promise<TeamCheckResult[]>((resolve) => (finish = resolve));
  const timer = setTimeout(() => end("This check took too long and was stopped."), limits.all);
  timer.unref();

  /** Closes the run with what there is. Whatever hasn't answered by now has no answer. */
  function end(why: string): void {
    if (over !== null) return;
    over = why;
    clearTimeout(timer);
    finish(list.map((check, i) => results[i] ?? { ...base(check), outcome: "error", summary: why, problems: [] }));
  }

  let next = 0;
  const worker = async () => {
    for (;;) {
      if (over !== null) return;
      const index = next++;
      const check = list[index];
      if (!check) return;
      const files = filesOf(check, touched);
      if (!files.length) {
        results[index] = { ...base(check), outcome: "skipped", summary: "This pull request changes none of the files this check is about.", problems: [] };
        continue;
      }
      onProgress(`Running your team's check "${check.name}"`);
      let result: TeamCheckResult;
      let tooLong: NodeJS.Timeout | undefined;
      try {
        const late = new Promise<never>((_, reject) => {
          tooLong = setTimeout(() => reject(new Error("it took too long")), limits.each);
          tooLong.unref();
        });
        const answer = readAnswer(await Promise.race([ask(check, files), late]));
        result = answer ? { ...base(check), ...answer } : { ...base(check), outcome: "error", summary: "The AI's answer to this check couldn't be read.", problems: [] };
      } catch (err) {
        const reason = words(err instanceof Error ? err.message : String(err), 300);
        result = { ...base(check), outcome: "error", summary: `The AI run for this check failed${reason ? `: ${reason}` : "."}`, problems: [] };
      } finally {
        clearTimeout(tooLong);
      }
      // An answer that comes after the run was closed is not used: the review has moved on.
      if (over !== null) return;
      results[index] = result;
      onProgress(`Your team's check "${check.name}": ${{ pass: "passed", fail: "failed", unsure: "couldn't tell", skipped: "skipped", error: "couldn't run" }[result.outcome]}`);
    }
  };
  void Promise.all(Array.from({ length: Math.min(AT_ONCE, list.length) }, worker)).then(() => end("This check didn't finish."));
  return { done, stop: () => end("The review ended before this check answered.") };
}
