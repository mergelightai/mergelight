import { matchesPath } from "./prompt.js";
import { frontMatterBlock, listValue, scalarValue, withoutComments } from "./repo-rules.js";
import { isSkillPath, withoutHidden } from "./skills.js";

/**
 * Jobs: tasks a team writes once in its repository. On each pull request that needs one, the AI does the
 * task and Mergelight pushes the result as one commit to the pull request's branch. This file reads and
 * checks the job files. They are read from the base branch, like rules, so a pull request can't add a
 * job, or widen one, for itself.
 *
 *   ---
 *   name: translations
 *   on: locales/en.json
 *   may-change: locales/*.json
 *   ---
 *   When en.json gets new keys, add each one to every other file in locales/, translated.
 *
 * - `on`: the files whose change starts the job.
 * - `may-change`: the only files the job may change, add or delete.
 * - `skill` (optional): a skill folder in the repository that the job uses.
 * - `name` (optional): the file's name without .md when left out.
 */
export const JOB_FILE = /^\.mergelight\/jobs\/[^/]+\.md$/;

/** Limits: each job is an AI run of its own, on the team's plan. */
export const MAX_JOBS = 5;
export const MAX_JOB_TASK_CHARS = 8000;
/** How many job files are read at most. */
export const MAX_JOB_FILES = 20;

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/**
 * Paths a job can never change, whatever its file says, wherever they sit: workflows and Mergelight's own
 * files decide what runs and what a job may do, CODEOWNERS decides who must approve, the files and
 * folders AI agents take instructions from would carry a planted text into every later agent and
 * review, and git's own files change how it reads the rest.
 */
export const REFUSED_PATHS = [
  ".github",
  ".mergelight",
  "CODEOWNERS",
  // What AI agents and the review take instructions from. CONTRIBUTING.md is one of the review's conventions.
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "CONTRIBUTING.md",
  "SKILL.md",
  "CLAUDE.local.md",
  "AGENTS.override.md",
  ".mcp.json",
  ".claude",
  ".agents",
  ".codex",
  ".cursor",
  ".gemini",
  ".windsurf",
  ".vscode",
  ".junie",
  ".roo",
  ".kiro",
  ".amazonq",
  ".cursorrules",
  ".windsurfrules",
  ".clinerules",
  "CONVENTIONS.md",
  "AGENT.md",
  "QWEN.md",
  "CRUSH.md",
  ".augment-guidelines",
  ".augment",
  ".kilocode",
  ".trae",
  ".openhands",
  ".continue",
  ".rules",
  ".goosehints",
  ".aider.conf.yml",
  ".gitmodules",
  ".gitattributes",
  ".lfsconfig",
  ".git",
];

export interface Job {
  name: string;
  /** The files whose change starts the job. */
  on: string[];
  /** The only files the job may change. */
  mayChange: string[];
  /** A skill folder in the repository that the job uses. */
  skill?: string;
  /** What to do, in the team's words. */
  task: string;
  /** The job file it came from. */
  source: string;
}

/** A job file that was left out, and why, in words for the summary. */
export interface JobProblem {
  source: string;
  problem: string;
}

/** A pattern that leaves the repository, or names no file: read the way matchesPath reads it. */
function badPattern(pattern: string): boolean {
  const plain = pattern.trim().replace(/\/{2,}/g, "/").replace(/^(\.\/|\/)+/, "").replace(/\/+$/, "");
  return !plain || plain.split("/").some((part) => part === "." || part === "..");
}

/** One job file: its job, or why it can't be one. Hidden characters are taken out first. */
export function parseJobFile(path: string, text: string): { job: Job } | { problem: string } {
  const block = frontMatterBlock(withoutHidden(text));
  if (!block) return { problem: "starts with no front matter, so it names no on and may-change paths" };
  // A key written twice: readers disagree on which one counts, and these decide what a job may write.
  const twice = ["name", "on", "may-change", "skill"].find((key) => (block.fm.match(new RegExp(`^${key}[ \\t]*:`, "gm")) ?? []).length > 1);
  if (twice) return { problem: `its front matter has ${twice} more than once` };
  const named = scalarValue(block.fm, "name");
  const name = named || path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
  if (!NAME.test(name)) return { problem: `its name "${name.slice(0, 60)}" must be lowercase letters, digits and dashes, start and end with a letter or digit, and be 40 long at most` };
  // A list that goes on past a trailing comma on the next line: only the key's own line is read.
  const cut = ["on", "may-change"].find((key) => scalarValue(block.fm, key)?.endsWith(","));
  if (cut) return { problem: `its ${cut} line ends with a comma: write the whole list on one line, or as a YAML list` };
  const on = listValue(block.fm, "on");
  if (!on?.length) return { problem: "names no on paths, the files whose change starts the job" };
  const mayChange = listValue(block.fm, "may-change");
  if (!mayChange?.length) return { problem: "names no may-change paths, the only files the job may change" };
  // "!" excludes files in GitHub's path filters, but here it would be part of a name and exclude nothing.
  const negated = [...on, ...mayChange].find((p) => p.startsWith("!"));
  if (negated !== undefined) return { problem: `the path "${negated.slice(0, 100)}" starts with !, but a job can't leave files out that way. List only the files it may change` };
  // A [list] split over lines reads as "[a," and "b]": only the key's own line is read.
  // Brackets that open and close, like Next.js's app/[locale], are part of a name.
  const count = (p: string, ch: string) => p.split(ch).length - 1;
  const split = [...on, ...mayChange].find((p) => count(p, "[") !== count(p, "]") || p.indexOf("]") < p.indexOf("["));
  if (split !== undefined) return { problem: `the path "${split.slice(0, 100)}" looks like part of a [list]: write the whole list on one line, or as a YAML list` };
  const bad = [...on, ...mayChange].find(badPattern);
  if (bad !== undefined) return { problem: `the path "${bad.slice(0, 100)}" leaves the repository or names no file. For every file, write **` };
  // A YAML block or empty value ("|", ">-", "~") would be read as a path: only lists and one-line values are read.
  const yamlBlock = [...on, ...mayChange].find((p) => /^(?:[|>](?:[1-9][+-]?|[+-][1-9]?)?|~|null)$/i.test(p));
  if (yamlBlock !== undefined) return { problem: `the path "${yamlBlock}" is a YAML block or an empty value: write the paths as a list, or on the key's own line` };
  if (mayChange.every(refusedPath)) {
    return { problem: "its may-change paths only name files a job can never change, like .github and .mergelight" };
  }
  const written = scalarValue(block.fm, "skill") ?? undefined;
  // Written the way the paths above may be: "./.claude/skills/x/" and "/.claude/skills/x" are ".claude/skills/x".
  const skill = written?.replace(/^(\.\/|\/)+/, "").replace(/\/+$/, "");
  if (written === "") return { problem: "its skill line names no folder: write one folder on the same line, like skill: .claude/skills/write-docs" };
  if (written !== undefined && !isSkillPath(skill)) return { problem: `its skill "${written.slice(0, 100)}" isn't a folder in the repository, like .claude/skills/write-docs` };
  // No job may change a skill folder, its own included, so one that may only change its own skill can do nothing.
  // A pattern in no man's land: only files a job can never change, or only its own skill folder, which no job may change.
  if (skill && mayChange.every((p) => refusedPath(p) || matchesPath(`/${skill}`.toLowerCase(), p.replace(/^(\.\/|\/)+/, "").toLowerCase()))) {
    return { problem: `its may-change paths only name files a job can never change, or its own skill folder, ${skill}` };
  }
  // HTML comments are what a team turned off, as in rule files.
  const task = withoutComments(block.body).trim();
  if (!task) return { problem: "has no task under its front matter" };
  if (task.length > MAX_JOB_TASK_CHARS) return { problem: `its task is longer than ${MAX_JOB_TASK_CHARS.toLocaleString("en-US")} characters` };
  return { job: { name, on, mayChange, ...(skill ? { skill } : {}), task, source: path } };
}

/**
 * The repository's jobs, within the limits, and every job file that was left out with the reason. Files
 * are taken by path, so which ones count past a limit doesn't change from run to run.
 */
export function readJobs(files: { path: string; text: string }[], hasSkill?: (folder: string) => boolean): { jobs: Job[]; problems: JobProblem[] } {
  const jobs: Job[] = [];
  const problems: JobProblem[] = [];
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const parsed = parseJobFile(f.path, f.text);
    if ("problem" in parsed) problems.push({ source: f.path, problem: parsed.problem });
    // Before the limits: a job that is left out mustn't take the place or the name of one that isn't.
    else if (parsed.job.skill && hasSkill && !hasSkill(parsed.job.skill)) problems.push({ source: f.path, problem: `its skill ${parsed.job.skill} has no SKILL.md on the base branch` });
    else if (jobs.some((j) => j.name === parsed.job.name)) problems.push({ source: f.path, problem: `${jobs.find((j) => j.name === parsed.job.name)!.source} already has a job named ${parsed.job.name}` });
    else if (jobs.length >= MAX_JOBS) problems.push({ source: f.path, problem: `only ${MAX_JOBS} jobs run in a repository` });
    else jobs.push(parsed.job);
  }
  return { jobs, problems };
}

/** The jobs that one of the changed files starts. */
export function jobsToRun(jobs: Job[], changedPaths: string[]): Job[] {
  return jobs.filter((job) => changedPaths.some((file) => job.on.some((pattern) => matchesPath(pattern, file))));
}

/** A path no job may change, whatever its file says. In any letter case: on macOS and Windows, .GitAttributes is .gitattributes. */
export function refusedPath(path: string): boolean {
  const lower = path.toLowerCase();
  return REFUSED_PATHS.some((refused) => matchesPath(refused.toLowerCase(), lower));
}

/**
 * Whether this job may change, add or delete the file. Never one in a skill folder: the job's own, or one
 * in guarded, which holds every folder with a SKILL.md on the base branch (guardedFolders). A skill
 * guides a job or a review, and a job mustn't rewrite what tells it or a review what to do.
 */
export function mayChange(job: Job, path: string, guarded: string[] = []): boolean {
  // A path that steps out of a folder could reach past what a pattern names.
  if (path.split("/").some((part) => part === "." || part === ".." || part === "")) return false;
  if (refusedPath(path)) return false;
  const lower = path.toLowerCase();
  if ([...(job.skill ? [job.skill] : []), ...guarded].some((folder) => matchesPath(`/${folder}`.toLowerCase(), lower))) return false;
  // Strictly: "locales/*" is the files right in locales, not a subfolder and all inside it.
  return job.mayChange.some((pattern) => matchesPath(pattern, path, false));
}

/**
 * The folders no job may change anything in: every folder with a SKILL.md in the given list of the base
 * branch's paths, whether a job or a review uses it, and every job's skill folder.
 */
export function guardedFolders(paths: string[], jobs: Job[] = []): string[] {
  const folders = new Set<string>();
  for (const p of paths) if (/(^|\/)SKILL\.md$/i.test(p) && p.includes("/")) folders.add(p.slice(0, p.lastIndexOf("/")));
  for (const j of jobs) if (j.skill) folders.add(j.skill);
  return [...folders].sort();
}
