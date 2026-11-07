import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The source of an action a changed workflow uses. Reviewers have no network, so it has to reach them in the prompt. */
export interface ActionSource {
  uses: string;
  files: { path: string; text: string }[];
}

const WORKFLOW_FILE = /(^|\/)\.github\/(workflows|actions)\/[^/]+|(^|\/)\.github\/actions\/.+\/action\.ya?ml$/;
const USES = /^[ \t]*(?:-[ \t]+)?uses:[ \t]*["']?([^"'\s#]+)/gm;
const REMOTE = /^([\w.-]+)\/([\w.-]+)((?:\/[\w.-]+)*)@([\w./-]+)$/;
/** Scripts a composite action runs from its own folder. */
const OWN_SCRIPT = /(?:GITHUB_ACTION_PATH|github\.action_path)(?:\s*\}\})?["']?\/([\w./-]+\.\w+)/g;
/** GitHub's own actions are widely read, and reading them would crowd out the rest. */
const WELL_KNOWN = new Set(["actions", "github"]);

const MAX_ACTIONS = 6;
const MAX_SCRIPTS = 6;
const MAX_FILE = 30_000;

/** The other people's actions and reusable workflows these changed files use, in the order they appear. */
export function actionsUsedBy(dir: string, changedPaths: string[]): string[] {
  const used = new Set<string>();
  for (const path of changedPaths.filter((p) => WORKFLOW_FILE.test(p))) {
    let text: string;
    try {
      text = readFileSync(join(dir, path), "utf8");
    } catch {
      continue;
    }
    for (const [, uses] of text.matchAll(USES)) {
      const remote = REMOTE.exec(uses!);
      if (remote && !WELL_KNOWN.has(remote[1]!.toLowerCase()) && !uses!.includes("..")) used.add(uses!);
    }
  }
  return [...used];
}

/**
 * Reads without a token, so public code is all this can reach. A pull request chooses these names,
 * and must not be able to pull someone's private repository into a prompt with the reader's access.
 */
async function readFile(owner: string, repo: string, ref: string, path: string, fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const text = await res.text();
    return text.length > MAX_FILE ? `${text.slice(0, MAX_FILE)}\n(cut off here, the file is longer)` : text;
  } catch {
    return null;
  }
}

/**
 * Fetches each action's definition and the scripts it runs from its own folder. Anything that can't be
 * read comes back with no files, so a review never fails over it and reviewers know what they didn't see.
 */
export async function fetchActionSources(uses: string[], fetchImpl: typeof fetch = fetch): Promise<ActionSource[]> {
  return Promise.all(
    uses.slice(0, MAX_ACTIONS).map(async (use): Promise<ActionSource> => {
      const [, owner, repo, sub, ref] = REMOTE.exec(use)!;
      const folder = sub!.replace(/^\//, "");
      const reusable = /\.ya?ml$/.test(folder);
      let main: { path: string; text: string } | null = null;
      for (const path of reusable ? [folder] : [`${folder ? `${folder}/` : ""}action.yml`, `${folder ? `${folder}/` : ""}action.yaml`]) {
        const text = await readFile(owner!, repo!, ref!, path, fetchImpl);
        if (text !== null) {
          main = { path, text };
          break;
        }
      }
      if (!main) return { uses: use, files: [] };
      const scripts = [...new Set([...main.text.matchAll(OWN_SCRIPT)].map((m) => m[1]!))].filter((p) => !p.includes("..")).slice(0, MAX_SCRIPTS);
      const read = await Promise.all(
        scripts.map(async (script) => {
          const path = `${folder ? `${folder}/` : ""}${script}`;
          const text = await readFile(owner!, repo!, ref!, path, fetchImpl);
          return text === null ? null : { path, text };
        }),
      );
      return { uses: use, files: [main, ...read.filter((f) => f !== null)] };
    }),
  );
}
