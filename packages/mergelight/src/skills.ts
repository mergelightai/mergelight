import { lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { run, type RunResult } from "./run.js";

/**
 * A skill the team picked for reviews: a how-to for one area that already lives in their
 * repository, written for Claude Code or Codex. The reviewer reads its file when the pull request
 * touches that area.
 */
export interface TeamSkill {
  name: string;
  description: string;
  /** Where its SKILL.md is in the checkout, for the reviewer to read. */
  read: string;
}

const MAX_SKILLS = 10;
const MAX_FILES = 30;
const MAX_FILE_BYTES = 60_000;
const MAX_SKILL_BYTES = 200_000;
/** The copy is a help, not a need: a git call that hangs, or a copy that takes too long, is given up. */
const GIT_TIMEOUT_MS = 20_000;
const IMPORT_TIMEOUT_MS = 60_000;

/** Runs git in the mirror and resolves with its output, whatever the exit code. */
export type GitInMirror = (args: string[]) => Promise<RunResult>;
export { GIT_TIMEOUT_MS as SKILL_GIT_TIMEOUT_MS, IMPORT_TIMEOUT_MS as SKILL_IMPORT_TIMEOUT_MS };

/** A folder in the repository, written plainly: no wildcards, no "..", no leading slash. */
export function isSkillPath(v: unknown): v is string {
  return typeof v === "string" && /^[\w.@+\-]+(\/[\w.@+\-]+)*$/.test(v) && v.length <= 200 && !v.split("/").some((part) => part === ".." || part === ".");
}

/** One line of plain text from a skill's own words, cut to size. */
function line(text: string, max: number): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, max).trim();
}

/** The name and description from the top of a SKILL.md, the way Claude Code and Codex write them. */
export function describeSkill(markdown: string, folder: string): { name: string; description: string } {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)?.[1] ?? "";
  const lines = front.split(/\r?\n/);
  const field = (key: string) => {
    const at = lines.findIndex((l) => l.startsWith(`${key}:`));
    if (at < 0) return "";
    const first = lines[at]!.slice(key.length + 1).trim();
    // The text can go on over the lines below, indented: after a block marker like > or |, or as a long line that wraps.
    const more: string[] = [];
    for (const l of lines.slice(at + 1)) {
      if (l.trim() && !/^[ \t]/.test(l)) break;
      more.push(l.trim());
    }
    const value = [/^[>|][+-]?\d?$/.test(first) ? "" : first, ...more].filter(Boolean).join(" ");
    return value.replace(/^(["'])(.*)\1$/, "$2");
  };
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---/, "");
  const firstLine = body.split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find(Boolean) ?? "";
  return {
    name: line(field("name"), 80) || line(folder.split("/").pop() ?? "skill", 80),
    description: line(field("description"), 400) || line(firstLine, 400),
  };
}

/**
 * An empty folder in the checkout for the copies. The checkout holds the pull request's own files,
 * so it could carry a link or a file at this very place: to send the copies somewhere else on the
 * machine, to put files of its own next to a skill, or to stop the copy and so switch the team's
 * skills off. Whatever the pull request put there is removed first, and a link is never written through.
 */
function emptySkillsFolder(checkout: string): string | null {
  const root = join(checkout, ".mergelight");
  const there = lstatSync(root, { throwIfNoEntry: false });
  // Removing a link or a file removes that entry alone, never what a link points at.
  if (there && !there.isDirectory()) rmSync(root, { force: true });
  const dir = join(root, "skills");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir) === join(realpathSync(checkout), ".mergelight", "skills") ? dir : null;
}

/**
 * Copies the team's picked skill folders into the checkout, from the base branch (the commit in `base`) and
 * never from the pull request. A pull request can change a skill's file, and its author must not be able to
 * tell the reviewer what to do that way: the copy the reviewer reads is the one the team already merged.
 *
 * Only ordinary files are copied. A link in the folder could point anywhere, so it is left out.
 */
export async function importSkills(
  mirror: string,
  base: string,
  checkout: string,
  folders: string[],
  git: GitInMirror = (args) => run("git", ["-C", mirror, ...args], { timeoutMs: GIT_TIMEOUT_MS }),
  now: () => number = Date.now,
): Promise<TeamSkill[]> {
  const skills: TeamSkill[] = [];
  const into = emptySkillsFolder(checkout);
  if (!into) return skills;
  const deadline = now() + IMPORT_TIMEOUT_MS;
  for (const [index, folder] of folders.filter(isSkillPath).slice(0, MAX_SKILLS).entries()) {
    if (now() > deadline) break;
    const listed = await git(["ls-tree", "-r", "-z", base, "--", `${folder}/`]);
    if (listed.code !== 0) continue;
    const files = listed.stdout
      .split("\0")
      .filter(Boolean)
      .map((entry) => /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(entry))
      .filter((m): m is RegExpExecArray => Boolean(m) && m![2] === "blob" && (m![1] === "100644" || m![1] === "100755"))
      .map((m) => ({ sha: m[3]!, path: m[4]! }))
      .filter((f) => f.path.startsWith(`${folder}/`) && isSkillPath(f.path));
    const main = files.find((f) => f.path === `${folder}/SKILL.md`);
    // No SKILL.md on the base branch: there is no skill there yet, whatever the pull request adds.
    // A folder that is a link to another folder has none either: git lists the link, not what is behind it.
    if (!main) continue;

    const target = join(".mergelight", "skills", String(index + 1));
    let total = 0;
    let markdown = "";
    for (const file of [main, ...files.filter((f) => f !== main)].slice(0, MAX_FILES)) {
      if (now() > deadline) break;
      const sized = await git(["cat-file", "-s", file.sha]);
      const size = sized.code === 0 ? Number(sized.stdout.trim()) : NaN;
      const read = Number.isFinite(size) && size <= MAX_FILE_BYTES && total + size <= MAX_SKILL_BYTES ? await git(["cat-file", "blob", file.sha]) : null;
      if (!read || read.code !== 0) {
        if (file === main) break;
        continue;
      }
      const content = read.stdout;
      // Not text: a picture, or a file in another encoding. It was read as text, so a copy would be a broken one.
      if (content.includes("\uFFFD") && file !== main) continue;
      total += size;
      if (file === main) markdown = content;
      // Without its SKILL.md there is no skill, so its other files aren't read or copied either.
      if (!markdown) break;
      const dest = join(into, String(index + 1), file.path.slice(folder.length + 1));
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, content);
    }
    if (!markdown) continue;
    skills.push({ ...describeSkill(markdown, folder), read: `${target}/SKILL.md` });
  }
  return skills;
}
