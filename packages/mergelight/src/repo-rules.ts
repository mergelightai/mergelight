import { withoutHidden } from "./skills.js";
import { ruleApplies, type TeamRule } from "./prompt.js";

/**
 * Rules a team writes in its repository, next to the ones on the dashboard. Read from the base branch,
 * like the instruction files: a pull request can't add or drop a rule for itself.
 *
 * - `.mergelight/rules.md` and `.mergelight/rules/*.md`: every top-level bullet is one rule.
 * - `.github/instructions/*.instructions.md`, GitHub Copilot's format: each file is one rule.
 *
 * A file can start with front matter that names the files it is about, as Copilot's `applyTo` or
 * Cursor's `globs`: comma-separated patterns like "src/billing/**,*.sql". Without it, or with "**", the
 * rules apply everywhere.
 */
export const RULE_FILE = /^(?:\.mergelight\/rules\.md|\.mergelight\/rules\/[^/]+\.md|\.github\/instructions\/[^/]+\.instructions\.md)$/;

/** Limits, so a long file can't fill every prompt. */
export const MAX_REPO_RULES = 40;
const MAX_BULLET_CHARS = 1000;
const MAX_FILE_RULE_CHARS = 12_000;
export const MAX_REPO_RULE_CHARS = 30_000;

/**
 * The patterns a file's front matter names, and the text after it. scoped: it names some (Copilot only
 * applies a file by itself when it does). forReview: false when Copilot's excludeAgent keeps the file
 * out of code review.
 */
export function frontMatter(text: string): { paths: string[]; body: string; scoped: boolean; forReview: boolean } {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { paths: [], body: text, scoped: false, forReview: true };
  const forReview = !/^excludeAgent[ \t]*:.*\bcode-review\b/m.test(m[1]!);
  const line = /^(?:applyTo|globs)[ \t]*:[ \t]*(.*)$/m.exec(m[1]!);
  const value = line?.[1]?.trim() ?? "";
  const patterns = splitOutsideBraces(value.trim().replace(/^\[([\s\S]*)\]$/, "$1").replace(/^["']|["']$/g, ""))
    .map((p) => p.trim().replace(/^["']|["']$/g, "").trim())
    .flatMap(expandBraces)
    .filter(Boolean);
  // "**" anywhere in the list means every file.
  const paths = patterns.some((p) => p === "**" || p === "*" || p === "**/*") ? [] : patterns;
  return { paths, body: text.slice(m[0].length), scoped: patterns.length > 0, forReview };
}

/** Splits on commas, but not on the ones inside braces, as in "**\/*.{ts,tsx},*.sql". */
function splitOutsideBraces(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "{") depth++;
    if (ch === "}") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
    } else current += ch;
  }
  out.push(current);
  return out;
}

/** "src/*.{ts,tsx}" is "src/*.ts" and "src/*.tsx": the path matcher has no braces of its own. */
export function expandBraces(pattern: string): string[] {
  const m = /\{([^{}]*)\}/.exec(pattern);
  if (!m) return [pattern];
  const options = m[1]!.split(",");
  return options.flatMap((o) => expandBraces(pattern.slice(0, m.index) + o + pattern.slice(m.index + m[0].length))).slice(0, 50);
}

/**
 * Every top-level bullet, with the lines under it joined on: indented ones, and plain text that wraps on
 * without a blank line. Code blocks are examples, never rules.
 */
function bullets(body: string): string[] {
  const out: string[] = [];
  let current: string | null = null;
  let fence: string | null = null;
  // HTML comments are what a team turned off: GitHub doesn't show them, so they don't count.
  const lines = body.replace(/<!--[\s\S]*?(?:-->|$)/g, "").split(/\r?\n/);
  for (const line of lines) {
    const marker = /^[ \t]*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    const start = /^(?:[-*+]|\d+[.)])[ \t]+(.*)$/.exec(line);
    if (start) {
      if (current) out.push(current);
      current = start[1]!.trim();
    } else if (current !== null && (/^[ \t]+\S/.test(line) || (/^\S/.test(line) && !/^(?:#|>|\||<)/.test(line)))) {
      current += ` ${line.trim()}`;
    } else {
      if (current) out.push(current);
      current = null;
    }
  }
  if (current) out.push(current);
  return out.filter(Boolean);
}

/** The rules in one file, as the reviewers get them. Hidden characters are taken out. */
export function parseRuleFile(path: string, text: string): Omit<TeamRule, "id">[] {
  const { paths, body, scoped, forReview } = frontMatter(withoutHidden(text));
  const only = paths.length ? { paths } : {};
  if (path.startsWith(".github/instructions/")) {
    // As Copilot does: a file without applyTo is attached by hand, and excludeAgent can keep it out of review.
    if (!scoped || !forReview) return [];
    const whole = body.replace(/<!--[\s\S]*?(?:-->|$)/g, "").trim();
    const cut = whole.length > MAX_FILE_RULE_CHARS;
    return whole ? [{ kind: "rule", text: cut ? `${whole.slice(0, MAX_FILE_RULE_CHARS)}\n(cut here: the file is longer)` : whole, scope: "repo", source: path, ...only }] : [];
  }
  return bullets(body).map((b) => ({ kind: "rule" as const, text: b.slice(0, MAX_BULLET_CHARS), scope: "repo" as const, source: path, ...only }));
}

/**
 * All the repository's rules that apply to the changed files, numbered F1, F2 and on, within the
 * limits. Mergelight's own rule files come first, so Copilot's files can't crowd them out.
 */
export function repoRules(files: { path: string; text: string }[], changedPaths?: string[]): TeamRule[] {
  const rules: TeamRule[] = [];
  let total = 0;
  const own = (p: string) => (p.startsWith(".mergelight/") ? 0 : 1);
  for (const f of [...files].sort((a, b) => own(a.path) - own(b.path) || a.path.localeCompare(b.path))) {
    for (const r of parseRuleFile(f.path, f.text)) {
      if (changedPaths && !ruleApplies({ ...r, id: "" }, changedPaths)) continue;
      if (rules.length >= MAX_REPO_RULES) return rules;
      // One long rule over the budget is left out; shorter ones after it can still fit.
      if (total + r.text.length > MAX_REPO_RULE_CHARS) continue;
      total += r.text.length;
      rules.push({ id: `F${rules.length + 1}`, ...r });
    }
  }
  return rules;
}
