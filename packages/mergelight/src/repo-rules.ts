import { withoutHidden } from "./skills.js";
import type { TeamRule } from "./prompt.js";

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
const MAX_FILE_RULE_CHARS = 8000;
export const MAX_REPO_RULE_CHARS = 30_000;

/** The patterns a file's front matter names, and the text after it. */
export function frontMatter(text: string): { paths: string[]; body: string } {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { paths: [], body: text };
  const value = /^(?:applyTo|globs)[ \t]*:[ \t]*(.*)$/m.exec(m[1]!)?.[1]?.trim() ?? "";
  const paths = value
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((p) => p.trim().replace(/^["']|["']$/g, "").trim())
    .filter((p) => p && p !== "**" && p !== "*" && p !== "**/*");
  return { paths, body: text.slice(m[0].length) };
}

/** Every top-level bullet, with the indented lines under it joined on. */
function bullets(body: string): string[] {
  const out: string[] = [];
  let current: string | null = null;
  for (const line of body.split(/\r?\n/)) {
    const start = /^(?:[-*+]|\d+[.)])[ \t]+(.*)$/.exec(line);
    if (start) {
      if (current) out.push(current);
      current = start[1]!.trim();
    } else if (current !== null && /^[ \t]+\S/.test(line)) {
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
  const { paths, body } = frontMatter(withoutHidden(text));
  const only = paths.length ? { paths } : {};
  if (path.startsWith(".github/instructions/")) {
    const whole = body.trim();
    return whole ? [{ kind: "rule", text: whole.slice(0, MAX_FILE_RULE_CHARS), scope: "repo", source: path, ...only }] : [];
  }
  return bullets(body).map((b) => ({ kind: "rule" as const, text: b.slice(0, MAX_BULLET_CHARS), scope: "repo" as const, source: path, ...only }));
}

/** All the repository's rules, numbered F1, F2 and on, within the limits. */
export function repoRules(files: { path: string; text: string }[]): TeamRule[] {
  const rules: TeamRule[] = [];
  let total = 0;
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    for (const r of parseRuleFile(f.path, f.text)) {
      if (rules.length >= MAX_REPO_RULES || total + r.text.length > MAX_REPO_RULE_CHARS) return rules;
      total += r.text.length;
      rules.push({ id: `F${rules.length + 1}`, ...r });
    }
  }
  return rules;
}
