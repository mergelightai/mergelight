// The shapes of text the server keeps and later shows to a reviewing model or a page.

/**
 * One line of plain text of a bounded length. No line breaks and no control characters: this text is
 * later shown to the reviewing model, where a line break is what a heading or a new instruction starts with.
 */
export function isLineOfText(v: unknown, max: number): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/.test(v) && v.trim().length > 0;
}

/** A pattern for file paths: plain path characters and the wildcards * and ?. Nothing that could be read as anything else. */
export function isPathPattern(v: unknown): v is string {
  return typeof v === "string" && /^[\w.@+\-/*?]{1,100}$/.test(v);
}

/** A folder in a repository, written plainly: no wildcards, no "..", no slash at either end. */
export function isSkillPath(v: unknown): v is string {
  return typeof v === "string" && v.length <= 200 && /^[\w.@+\-]+(\/[\w.@+\-]+)*$/.test(v) && !v.split("/").some((part) => part === ".." || part === ".");
}

/** The name of a team's check, as GitHub shows it: letters, digits and single spaces, with . _ - inside. */
export function isCheckName(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9._-]| (?! ))*$/.test(v) && v.length <= 40 && !v.endsWith(" ");
}

/**
 * Whether a text holds characters a person can't see: zero-width and joining characters, marks that
 * reorder text, Unicode "tag" characters and the like. Someone who pastes a rule or a skill from
 * somewhere else sees clean text on the dashboard, while the reviewing AI would read what is hidden
 * in it. So text a team writes for the AI is refused when it holds any.
 */
export function hasHiddenCharacters(v: string): boolean {
  return /\p{Default_Ignorable_Code_Point}/u.test(v);
}

/**
 * Takes out the one invisible character people type without knowing: the selector that makes a
 * symbol show as an emoji. The symbol stays, in its plain form.
 */
export function plainEmoji(v: string): string {
  return v.replace(/\ufe0f/g, "");
}

/** The most a skill written on the dashboard can hold. Every review of the repository may read it. */
export const SKILL_TEXT_MAX = 8000;

/**
 * The text of a skill written on the dashboard: plain text over several lines. Line breaks and tabs
 * are fine, because it reaches a reviewer as a file of its own and never as part of a prompt. Other
 * control characters, and characters that hide or reorder text, are not.
 */
export function isSkillText(v: unknown): v is string {
  return typeof v === "string" && v.length <= SKILL_TEXT_MAX && v.trim().length > 0 && !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/.test(v) && !hasHiddenCharacters(v);
}
