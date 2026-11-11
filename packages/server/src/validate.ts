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
