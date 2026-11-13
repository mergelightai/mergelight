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
/** The keys a job file's front matter may have. */
const JOB_KEYS = ["name", "on", "may-change", "skill"];

/**
 * Folders a job can never change anything in, whatever its file says, wherever they sit: workflows and
 * CI settings decide what runs, Mergelight's own files what a job may do, the folders AI agents take
 * instructions from would carry a planted text into every later agent and review, and git's own folder
 * is git's.
 */
export const REFUSED_FOLDERS = [
  ".github",
  ".mergelight",
  ".git",
  // AI agents.
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
  ".continue",
  ".augment",
  ".kilocode",
  ".trae",
  ".openhands",
  ".opencode",
  ".aiassistant",
  ".qwen",
  ".factory",
  // CI services, git hooks and dev containers.
  ".gitlab",
  ".circleci",
  ".woodpecker",
  ".gitea",
  ".forgejo",
  ".buildkite",
  ".husky",
  ".devcontainer",
  ".semaphore",
  ".githooks",
  ".mergify",
  ".tekton",
  // Names that are a file for some tools and a folder for others: either way, nothing in or of them.
  ".clinerules",
  ".rules",
  ".tabnine",
];

/**
 * Files a job can never change, whatever its file says, in any folder. Only the file's own name counts,
 * so a folder that happens to be called owners is ordinary.
 */
export const REFUSED_FILES = [
  // Who must approve, and what merges by itself.
  "CODEOWNERS",
  "OWNERS",
  "OWNERS_ALIASES",
  ".policy.yml",
  ".pullapprove.yml",
  ".mergify.yml",
  "renovate.json",
  "renovate.json5",
  ".renovaterc",
  ".renovaterc.json",
  ".renovaterc.json5",
  ".kodiak.toml",
  "bors.toml",
  // What AI agents and the review take instructions from. CONTRIBUTING.md is one of the review's conventions.
  "AGENTS.md",
  "AGENTS.override.md",
  "AGENT.md",
  "CLAUDE.md",
  "CLAUDE.local.md",
  "GEMINI.md",
  "QWEN.md",
  "CRUSH.md",
  "WARP.md",
  "CONTRIBUTING.md",
  "CONVENTIONS.md",
  "SKILL.md",
  "airules.md",
  ".mcp.json",
  "opencode.json",
  "crush.json",
  ".crush.json",
  ".augment-guidelines",
  ".goosehints",
  ".roorules",
  ".roomodes",
  ".continuerules",
  ".aider.conf.yml",
  ".cursorrules",
  ".windsurfrules",
  "opencode.jsonc",
  // Other review bots' settings.
  ".coderabbit.yaml",
  ".coderabbit.yml",
  ".pr_agent.toml",
  // What runs: CI services and git hooks.
  ".gitlab-ci.yml",
  ".travis.yml",
  ".drone.yml",
  ".woodpecker.yml",
  ".pre-commit-config.yaml",
  "lefthook.yml",
  "lefthook.yaml",
  "lefthook.toml",
  "lefthook-local.yml",
  ".lefthook.yml",
  ".lefthook.yaml",
  ".woodpecker.yaml",
  ".cirrus.star",
  ".prow.yaml",
  ".gitpod.yml",
  ".devcontainer.json",
  ".cirrus.yml",
  "appveyor.yml",
  ".appveyor.yml",
  "cloudbuild.yaml",
  "cloudbuild.yml",
  "buildspec.yml",
  "bitrise.yml",
  "codemagic.yaml",
  "Jenkinsfile",
  "azure-pipelines.yml",
  "bitbucket-pipelines.yml",
  // How git reads the rest.
  ".gitmodules",
  ".gitattributes",
  ".lfsconfig",
];

/** Both lists, for anyone who wants the whole of what a job may never change. */
export const REFUSED_PATHS = [...REFUSED_FOLDERS, ...REFUSED_FILES];

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
  // A YAML list item that ends with a comma goes on past it the same way.
  const cut = ["on", "may-change"].find((key) => scalarValue(block.fm, key)?.endsWith(",")) ?? (/^[ \t]*-[^\n#]*,[ \t]*(?:#.*)?$/m.test(block.fm) ? "list" : undefined);
  if (cut === "list") return { problem: "a list item in its front matter ends with a comma: write each path as an item of its own" };
  if (cut) return { problem: `its ${cut} line ends with a comma: write the whole list on one line, or as a YAML list` };
  // "./name" means the root, as "/name" does: without that it would be "name" in any folder.
  const rooted = (paths: string[] | null) => paths?.map((p) => p.replace(/^\.\//, "/"));
  // A key with nothing on its line, then a path on an indented line that isn't a "- " item: the path isn't read.
  const indented = (key: string) => new RegExp(`^${key}[ \\t]*:[ \\t]*(?:#.*)?\\r?\\n(?:[ \\t]*(?:#.*)?\\r?\\n)*[ \\t]+[^\\s#-]`, "m").test(block.fm);
  const on = rooted(listValue(block.fm, "on"));
  if (!on?.length) return { problem: indented("on") ? "its on value goes on to an indented line, which isn't read: write the paths as a list" : "names no on paths, the files whose change starts the job" };
  const mayChange = rooted(listValue(block.fm, "may-change"));
  if (!mayChange?.length) return { problem: indented("may-change") ? "its may-change value goes on to an indented line, which isn't read: write the paths as a list" : "names no may-change paths, the only files the job may change" };
  // "!" excludes files in GitHub's path filters, but here it would be part of a name and exclude nothing.
  const negated = [...on, ...mayChange].find((p) => p.startsWith("!"));
  if (negated !== undefined) return { problem: `the path "${negated.slice(0, 100)}" starts with !, but a job can't leave files out that way. List only the files it may change` };
  // A [list] split over lines reads as "[a," and "b]": only the key's own line is read.
  // Brackets that open and close, like Next.js's app/[locale], are part of a name.
  const count = (p: string, ch: string) => p.split(ch).length - 1;
  const split = [...on, ...mayChange].find((p) => count(p, "[") !== count(p, "]") || p.indexOf("]") < p.indexOf("["));
  if (split !== undefined) return { problem: `the path "${split.slice(0, 100)}" looks like part of a [list]: write the whole list on one line, or as a YAML list` };
  // "locales/*/" reads as "locales/*", the files right in locales: the opposite of what it says.
  const slash = [...on, ...mayChange].find((p) => /[*?][^/]*\/+$/.test(p) && !/(?:^|\/)\*\*\/+$/.test(p));
  if (slash !== undefined) return { problem: `the path "${slash.slice(0, 100)}" ends in a slash after a wildcard: write locales/* for the files in a folder, or locales for all of it` };
  const bad = [...on, ...mayChange].find(badPattern);
  if (bad !== undefined) return { problem: `the path "${bad.slice(0, 100)}" leaves the repository or names no file. For every file, write **` };
  // A YAML block or empty value ("|", ">-", "~") would be read as a path: only lists and one-line values are read.
  const yamlBlock = [...on, ...mayChange].find((p) => /^(?:[|>](?:[1-9][+-]?|[+-][1-9]?)?|~|null)$/i.test(p));
  if (yamlBlock !== undefined) return { problem: `the path "${yamlBlock}" is a YAML block or an empty value: write the paths as a list, or on the key's own line` };
  // A path on an indented line under the key's own value is part of it in YAML, but only the key's line is read.
  const goesOn = ["on", "may-change", "skill"].find((key) => new RegExp(`^${key}[ \\t]*:[ \\t]*[^\\s#][^\\n]*\\n[ \\t]+[^\\s#-]`, "m").test(block.fm));
  if (goesOn) return { problem: `its ${goesOn} value goes on to an indented line, which isn't read: write the paths as a list` };
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
  // Every line of the front matter must be one that is read: a job's own key, a list item under on or
  // may-change, a blank line or a comment. Anything else (a typo in a key, a value that goes on to the next
  // line, an item under a key that already has a value) would be dropped without a word.
  let list: string | null = null;
  for (const line of block.fm.split(/\r?\n/)) {
    if (/^[ \t]*(?:#.*)?$/.test(line)) continue;
    // YAML allows the items at the key's own indent too, and an item can hold a colon.
    if (list && /^[ \t]*-[ \t]*\S/.test(line)) continue;
    const keyLine = /^([^\s:#-][^:]*?)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (keyLine) {
      const key = keyLine[1]!;
      if (!JOB_KEYS.includes(key)) return { problem: `its front matter has a key a job doesn't know: ${key.slice(0, 40)}. A job knows name, on, may-change and skill` };
      list = (key === "on" || key === "may-change") && /^(?:#.*)?$/.test(keyLine[2]!.trim()) ? key : null;
      continue;
    }
    return { problem: `its front matter has a line that isn't read: "${line.trim().slice(0, 60)}". Write each key on a line of its own, and list items under on or may-change with nothing after the colon` };
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
  // As strictly as may-change, so a job never starts for files it may not change.
  return jobs.filter((job) => changedPaths.some((file) => job.on.some((pattern) => matchesPath(pattern, file, false))));
}

/**
 * A name in the form macOS and Windows compare names in: any letter case, and look-alike letters that
 * fold to plain ones, like ſ to s and ı to i. Upper case first, so those fold too.
 */
export function folded(path: string): string {
  return path.toUpperCase().toLowerCase();
}

/** A path no job may change, whatever its file says. In any letter case: on macOS and Windows, .GitAttributes is .gitattributes. */
export function refusedPath(path: string): boolean {
  const lower = folded(path);
  const name = lower.replace(/\/+$/, "").split("/").pop() ?? "";
  // Roo reads .roorules-<mode> for each mode.
  return REFUSED_FOLDERS.some((refused) => matchesPath(folded(refused), lower)) || REFUSED_FILES.some((refused) => folded(refused) === name) || name.startsWith(".roorules-");
}

/**
 * Whether this job may change, add or delete the file. Never one in a skill folder: the job's own, or one
 * in guarded, which holds every folder with a SKILL.md on the base branch (guardedFolders). A skill
 * guides a job or a review, and a job mustn't rewrite what tells it or a review what to do. guarded only
 * knows the base branch: the step that writes passes isLink for the pull request's own links.
 */
export function mayChange(job: Job, path: string, guarded: string[] = [], isLink: (path: string) => boolean = () => false): boolean {
  // A path that steps out of a folder could reach past what a pattern names.
  const parts = path.split("/");
  if (parts.some((part) => part === "." || part === ".." || part === "")) return false;
  // isLink tells about the branch being written, which can have links the base branch doesn't: a write
  // at or through one would land wherever it leads.
  if (parts.some((_, i) => isLink(parts.slice(0, i + 1).join("/")))) return false;
  if (refusedPath(path)) return false;
  const lower = folded(path);
  if ([...(job.skill ? [job.skill] : []), ...guarded].some((folder) => matchesPath(folded(`/${folder}`), lower))) return false;
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
