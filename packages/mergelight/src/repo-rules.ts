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
export const RULE_FILE = /^(?:\.mergelight\/rules\.md|\.mergelight\/rules\/[^/]+\.md|\.github\/instructions\/(?:[^/]+\/)*[^/]+\.instructions\.md)$/;

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
  const block = frontMatterBlock(text);
  if (!block) return { paths: [], body: text, scoped: false, forReview: true };
  const forReview = !/^excludeAgent[ \t]*:.*\bcode-review\b/m.test(block.fm);
  const patterns = listValue(block.fm, "applyTo|globs") ?? [];
  // "**" anywhere in the list means every file.
  const paths = patterns.some((p) => p === "**" || p === "*" || p === "**/*") ? [] : patterns;
  return { paths, body: block.body, scoped: patterns.length > 0, forReview };
}

/** The front matter of a Markdown file and the text after it, or null when it has none. */
export function frontMatterBlock(text: string): { fm: string; body: string } | null {
  // The block between the first two "---" lines, which may be empty: an empty one must not reach on to a
  // later "---" divider and take the rules before it.
  const m = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)??---[ \t]*(?:\r?\n|$)/.exec(text);
  return m ? { fm: m[1] ?? "", body: text.slice(m[0].length) } : null;
}

/**
 * Without a YAML comment after it: applyTo: "src/billing/**" # billing only. A # inside quotes is part of
 * the value, as in YAML.
 */
function withoutYamlComment(value: string): string {
  let quote: string | null = null;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      // A quote opens only where a value or an item starts, as in YAML: one inside a word, like don't, is a letter.
    } else if ((ch === '"' || ch === "'") && (i === 0 || /[\s,[]/.test(value[i - 1]!))) quote = ch;
    else if (ch === "#" && (i === 0 || value[i - 1] === " " || value[i - 1] === "\t")) return value.slice(0, i).trim();
  }
  return value.trim();
}

/** The value of a one-line key, without quotes or a comment, or null when the key isn't there. */
export function scalarValue(fm: string, key: string): string | null {
  const line = new RegExp(`^(?:${key})[ \\t]*:[ \\t]*(.*)$`, "m").exec(fm);
  return line ? withoutYamlComment(line[1] ?? "").replace(/^(["'])(.*)\1$/, "$2").trim() : null;
}

/**
 * The patterns a key names: a comma list, a [list], or a YAML list on the lines below it, with braces
 * expanded. Null when the key isn't there. keys is one name, or names joined with "|".
 */
export function listValue(fm: string, keys: string): string[] | null {
  const line = new RegExp(`^(?:${keys})[ \\t]*:[ \\t]*(.*)$`, "m").exec(fm);
  if (!line) return null;
  const unquote = (p: string) => p.trim().replace(/^["']|["']$/g, "").trim();
  const value = withoutYamlComment(line[1] ?? "");
  // An inline value, or a YAML list on the lines below the key: "applyTo:" then "  - src/billing/**".
  // Teams write comma lists inside one item too ("- **/*.ts,**/*.tsx"), so every item is split on its
  // commas, as Copilot reads it.
  const items = value ? [value.replace(/^\[([\s\S]*)\]$/, "$1").replace(/^["']|["']$/g, "")] : [];
  if (!value) {
    const after = fm.slice(line.index + line[0].length).split(/\r?\n/).slice(1);
    for (const l of after) {
      // A blank line or a comment between the items doesn't end the list.
      if (/^[ \t]*(?:#.*)?$/.test(l)) continue;
      const item = /^[ \t]*-[ \t]*(.+)$/.exec(l);
      if (!item) break;
      // An item can be a [list] of its own, as the inline value can. Brackets go before quotes, so a
      // quoted "[locale]" keeps its brackets, as it does inline.
      items.push(unquote(withoutYamlComment(item[1]!).replace(/^\[([\s\S]*)\]$/, "$1")));
    }
  }
  return items.flatMap(splitOutsideBraces).map(unquote).flatMap(expandBraces).filter(Boolean);
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
 * Takes out HTML comments, which are what a team turned off. A "<!--" or "-->" inside inline code or a
 * code block is an example, not a comment, so it can't take out the rules between two of them.
 */
export function withoutComments(text: string): string {
  const kept: string[] = [];
  const hold = (code: string) => `\u0000${kept.push(code) - 1}\u0000`;
  const shielded = text
    // A code block closes with the same character, at least as many times as it opened with.
    .replace(/^([ \t]*)((`){3,}|(~){3,})[^\n]*\n[\s\S]*?^[ \t]*\2(?:\3|\4)*[ \t]*$/gm, hold)
    .replace(/`[^`\n]+`/g, hold);
  return shielded.replace(/<!--[\s\S]*?-->/g, "").replace(/\u0000(\d+)\u0000/g, (_, i: string) => kept[Number(i)]!);
}

/**
 * Every top-level bullet, with the lines under it joined on: indented ones, and plain text that wraps on
 * without a blank line. Code blocks are examples, never rules.
 */
function bullets(body: string): string[] {
  const out: string[] = [];
  let current: string | null = null;
  // A blank line after a bullet: an indented paragraph after it still belongs to it (a loose list).
  let gap = false;
  let openIndent = 0;
  let fence: string | null = null;
  // HTML comments are what a team turned off: GitHub doesn't show them, so they don't count.
  // Only a closed one: an unclosed "<!--", say inside inline code, mustn't wipe out the rest of the file.
  const lines = withoutComments(body).split(/\r?\n/);
  for (const line of lines) {
    const marker = /^[ \t]*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      // After a code block, only indented text still belongs to the bullet above it.
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) {
        fence = null;
        gap = true;
      }
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    // A divider ("---", "* * *") ends a bullet and is never one itself.
    if (/^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line)) {
      if (current) out.push(current);
      current = null;
      gap = false;
      continue;
    }
    // A bullet may sit up to 3 spaces in and still be top level. With a bullet open, one 2 or more
    // spaces further in than it is a sub-bullet of it, which joins it.
    const start = /^( {0,3})(?:[-*+]|\d+[.)])[ \t]+(.*)$/.exec(line);
    const topLevel = start && (current === null || start[1]!.length < openIndent + 2);
    if (start && topLevel) {
      if (current) out.push(current);
      current = start[2]!.trim();
      openIndent = start[1]!.length;
      gap = false;
    } else if (current !== null && !line.trim()) {
      gap = true;
    } else if (current !== null && (/^[ \t]+\S/.test(line) || (!gap && /^\S/.test(line) && !/^(?:#|>|\||<)/.test(line)))) {
      current += ` ${line.trim().replace(/^(?:[-*+]|\d+[.)])[ \t]+/, "")}`;
      gap = false;
    } else {
      if (current) out.push(current);
      current = null;
      gap = false;
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
    const whole = withoutComments(body).trim();
    const cut = whole.length > MAX_FILE_RULE_CHARS;
    return whole ? [{ kind: "rule", text: cut ? `${whole.slice(0, MAX_FILE_RULE_CHARS)}\n(cut here: the file is longer)` : whole, scope: "repo", source: path, ...only }] : [];
  }
  return bullets(body).map((b) => ({ kind: "rule" as const, text: b.length > MAX_BULLET_CHARS ? `${b.slice(0, MAX_BULLET_CHARS)} (cut here: the rule is longer)` : b, scope: "repo" as const, source: path, ...only }));
}

/**
 * All the repository's rules that apply to the changed files, numbered F1, F2 and on, within the
 * limits. Mergelight's own rule files come first, so Copilot's files can't crowd them out.
 */
export function repoRules(files: { path: string; text: string }[], changedPaths?: string[], stats?: { dropped: number }): TeamRule[] {
  const rules: TeamRule[] = [];
  let total = 0;
  const own = (p: string) => (p.startsWith(".mergelight/") ? 0 : 1);
  for (const f of [...files].sort((a, b) => own(a.path) - own(b.path) || a.path.localeCompare(b.path))) {
    for (const r of parseRuleFile(f.path, f.text)) {
      if (changedPaths && !ruleApplies({ ...r, id: "" }, changedPaths)) continue;
      // Over the limits a rule is left out, and counted, so the log can say so. A long one over the
      // character budget doesn't stop shorter ones after it.
      if (rules.length >= MAX_REPO_RULES || total + r.text.length > MAX_REPO_RULE_CHARS) {
        if (stats) stats.dropped++;
        continue;
      }
      total += r.text.length;
      rules.push({ id: `F${rules.length + 1}`, ...r });
    }
  }
  return rules;
}
