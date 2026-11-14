import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { run } from "../run.js";
import type { ModelOptions, ModelResult } from "./index.js";

export type CodexOptions = ModelOptions;
export type CodexResult = ModelResult;

/** Codex's Linux sandbox (bubblewrap) can't start, so every command fails. */
export class SandboxError extends Error {}

/** The ChatGPT login didn't work. Worth saying plainly, because re-running usually fixes it. */
export class LoginError extends Error {
  plan: Plan;
  constructor(message: string, plan: Plan = "ChatGPT") {
    super(message);
    this.plan = plan;
  }
}

export type Plan = "ChatGPT" | "Claude";

/** The plan has no usage left. Nothing is broken, so the person only needs to know that and when it comes back. */
export class LimitError extends Error {
  plan: Plan;
  resets: string | null;
  constructor(plan: Plan, resets: string | null) {
    super(`Your ${plan} plan hit its usage limit.${resets ? ` Resets: ${resets}.` : ""}`);
    this.plan = plan;
    this.resets = resets;
  }
}

/** Both programs start this sentence the same way. Only pass in their own errors: code under review can say anything. */
const LIMIT_HIT = /you['\u2019]ve hit your\b[^\n]{0,40}\blimit\b/i;
const WHEN = "[\\w :,()+-]{1,60}";

/** The limit in a program's error output, if that's what the error is. Claude says "resets 9am (UTC)", Codex "try again at 3:14 PM". */
export function limitFrom(text: string, plan: Plan): LimitError | null {
  const line = text.split("\n").find((l) => LIMIT_HIT.test(l));
  if (!line) return null;
  const resets = line.match(new RegExp(`\\bresets\\s+(${WHEN})`, "i"))?.[1]?.trim();
  if (resets) return new LimitError(plan, resets);
  const retry = line.match(new RegExp(`\\btry again at\\s+(${WHEN})`, "i"))?.[1]?.trim();
  // Codex prints the runner's clock with no zone, and a time with no zone reads as the person's own.
  const zone = retry && new Date().getTimezoneOffset() === 0 && !/UTC|GMT/.test(retry) ? " UTC" : "";
  return new LimitError(plan, retry ? `${retry}${zone}` : null);
}

/** What Codex says when a login is refused or can't be refreshed. */
const LOGIN_FAILURE = /access token could not be refreshed|401 Unauthorized/i;

export function loginFailureMessage(secretName = "CODEX_AUTH_JSON"): string {
  return `The ChatGPT login didn't work, most likely because another run already refreshed it. Re-run the Mergelight job from the Actions tab, or push again, to pick up the new one. If it fails again, the login has stopped working: delete the ${secretName} secret, then push, and this pull request shows a code to connect ChatGPT again.`;
}

const SANDBOX_FAILURE = /bwrap:|user namespace|new namespace|RTM_NEWADDR|uid map|sandbox.*(denied|not permitted)/i;

function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

function readUserConfig(): string {
  try {
    return readFileSync(join(codexHome(), "config.toml"), "utf8");
  } catch {
    return "";
  }
}

/** The model from the user's Codex config, for display only. */
export function configuredModel(config = readUserConfig()): string | null {
  const top = config.split(/^\[/m)[0] ?? "";
  return top.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1] ?? null;
}

/** Names of MCP servers in the user's Codex config, so they can be switched off for reviews. */
function mcpServers(config: string): string[] {
  const names = new Set<string>();
  for (const m of config.matchAll(/^\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\]\s*$/gm)) {
    const name = m[1] ?? m[2];
    if (name && !name.includes(".")) names.add(name);
  }
  return [...names];
}

/**
 * Where Codex is installed: its sandbox runs Codex's own program, and its bundled tools such as rg, from
 * there. On a runner that is Node's tool folder, which the Linux rules don't otherwise read. It holds
 * code, never a secret. Found from the codex on PATH; nothing when there is none.
 */
export function codexInstall(path = process.env.PATH ?? "", which: (manager: string) => string | null = managerWhich): string[] {
  for (const dir of path.split(":").filter(Boolean)) {
    let real: string;
    try {
      real = realpathSync(join(dir, "codex"));
    } catch {
      continue;
    }
    // A Node version manager puts a shim on PATH that starts the real codex: the manager says where that is.
    const manager = shimManager(real);
    if (manager) {
      const found = which(manager);
      if (!found) return [];
      try {
        real = realpathSync(found);
      } catch {
        return [];
      }
    }
    // The npm package: <root>/bin/codex.js, with the native program in <root>/node_modules. A program on
    // its own is read from its own folder. Never the home folder, or one that holds it.
    const folder = /\/bin\/codex\.js$/.test(real) ? dirname(dirname(real)) : dirname(real);
    const home = homedir();
    if (folder === "/" || folder === home || home.startsWith(`${folder}/`)) return [];
    return [folder];
  }
  return [];
}

/** The version manager whose shim this is: Volta's links to volta-shim, asdf's are scripts in its shims folder, mise's link to mise. */
export function shimManager(real: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (/\/volta-shim$/.test(real)) return "volta";
  if (/\/\.?asdf[^/]*\/shims\/codex$/.test(real)) return "asdf";
  // asdf can keep its shims anywhere ASDF_DATA_DIR says.
  if (env.ASDF_DATA_DIR) {
    let data = env.ASDF_DATA_DIR;
    try {
      data = realpathSync(data);
    } catch {
      // Compared as written.
    }
    if (real === join(data, "shims", "codex")) return "asdf";
  }
  if (/\/mise$/.test(real) || /\/mise\/shims\/codex$/.test(real)) return "mise";
  return null;
}

/** Where the version manager's real codex is, or null when it can't say. */
function managerWhich(manager: string): string | null {
  try {
    return execFileSync(manager, ["which", "codex"], { encoding: "utf8", timeout: 10_000 }).trim().split("\n")[0] || null;
  } catch {
    return null;
  }
}

/** On Linux, the top-level folders a job's commands may read: the system and nothing else. /proc is the sandbox's own. */
export const LINUX_KEEP = ["/usr", "/etc", "/dev", "/proc", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/nix"];

/** Every top-level folder on this disk that is a real folder, not a link such as /bin to /usr/bin. */
function topFolders(): string[] {
  try {
    return readdirSync("/", { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.isSymbolicLink())
      .map((d) => `/${d.name}`);
  } catch {
    return [];
  }
}

/**
 * The folders beside a path, at each level below the folder it is carved from (its top folder unless
 * said), to hide so that only the path itself stays readable: Linux's sandbox can't open a folder again
 * inside one it hid, so the rest around it is hidden instead.
 */
export function besides(path: string, list: (dir: string) => string[] = (dir) => readdirSync(dir), from?: string): string[] | null {
  const parts = path.split("/").filter(Boolean);
  const out: string[] = [];
  for (let i = from ? from.split("/").filter(Boolean).length : 1; i < parts.length; i++) {
    const parent = `/${parts.slice(0, i).join("/")}`;
    let names: string[];
    try {
      names = list(parent);
    } catch {
      // What's beside the path there is unknown, so it can't be hidden: the path isn't made readable.
      return null;
    }
    for (const name of names) if (name !== parts[i]) out.push(`${parent}/${name}`);
  }
  return out;
}

/**
 * Commands Codex runs can read the whole disk but not write or reach the network. Code under review can try to
 * steer them, so the folder with the login is taken out of what they can read. Codex itself still reads it.
 * For a job, they may also write in the one folder the job works in, and nowhere else.
 */
export function sandboxArgs(home = codexHome(), writable?: string, hidden: string[] = [], readable: string[] = [], platform: NodeJS.Platform = process.platform, top: string[] = platform === "linux" ? topFolders() : [], list?: (dir: string) => string[]): string[] {
  if (writable) {
    // A job's files get pushed, so its commands mustn't reach secrets or other code. On Linux, where
    // runners are, every top-level folder but the system's is hidden, whatever the runner's layout: home
    // folders, /root, /opt, /var, /run, /tmp and any runner folder. The links at the top, such as /bin,
    // stay and lead into /usr. On a Mac, whose system needs more, the disk stays readable but the places
    // secrets live are hidden. Either way the job's folder is the one place it can write, and the more
    // specific rule wins. A rule inside a hidden folder is left out, as Linux's sandbox can't make one.
    // The job's folder inside the hidden /tmp is fine: a write rule opens it there, tried on a GitHub-hosted
    // Ubuntu runner and in a Linux container. A read rule doesn't, so a readable folder is handled below.
    const linux = platform === "linux";
    const holds = (outer: string, p: string) => p.startsWith(`${outer}/`);
    const secret = [...hidden, home];
    const tops = (p: string) => `/${p.split("/").filter(Boolean)[0] ?? ""}`;
    // On Linux a folder that must stay readable, such as Codex's own in /opt, is carved from the highest
    // hidden folder that holds it: the folders beside its path are hidden instead, level by level. That is
    // its top folder, unless the top is the system's, or a place to hide above it, such as a self-hosted
    // runner installed under /usr with Codex in its tool folder. One whose surroundings can't be listed
    // isn't readable at all. Nor is one that is, or holds, a place to hide: it would open that place up.
    const carves = new Map<string, string[]>();
    for (const r of readable) {
      if (secret.some((h) => h === r || holds(r, h))) continue;
      if (!linux) {
        carves.set(r, []);
        continue;
      }
      const from = [...(LINUX_KEEP.includes(tops(r)) ? [] : [tops(r)]), ...secret.filter((h) => holds(h, r))].sort((x, y) => x.length - y.length)[0];
      const around = from ? besides(r, list, from) : [];
      if (around) carves.set(r, around);
    }
    const open = [...carves.keys()];
    const keepTops = new Set(open.map(tops));
    const off = linux ? top.filter((t) => !LINUX_KEEP.includes(t) && !keepTops.has(t)) : [];
    // Nothing that leads to a readable folder is hidden.
    const carved = [...carves.values()].flat().filter((c) => !open.some((r) => r === c || holds(c, r)));
    const inside = (p: string) => [...off, ...carved].some((t) => p === t || holds(t, p));
    const paths: [string, string][] = [
      [":root", "read"],
      ...off.map((t): [string, string] => [t, "none"]),
      ...carved.map((c): [string, string] => [c, "none"]),
      // On Linux a hidden folder can't hold a readable one, so one that does is opened up and carved instead.
      ...secret.filter((h) => !inside(h) && (!linux || !open.some((r) => holds(h, r)))).map((h): [string, string] => [h, "none"]),
      ...(linux ? [] : open.map((r): [string, string] => [r, "read"])),
      [writable, "write"],
    ];
    // One rule for each path: a table with the same key twice stops Codex. A later rule is the more
    // specific one (the job's own folder last), so it wins.
    const rules = new Map(paths);
    return ["-c", 'default_permissions="mergelight_job"', "-c", `permissions.mergelight_job.filesystem={${[...rules].map(([path, access]) => `${JSON.stringify(path)}="${access}"`).join(",")}}`];
  }
  return ["-c", 'default_permissions="mergelight_review"', "-c", `permissions.mergelight_review.filesystem={":root"="read",${JSON.stringify(home)}="none"}`];
}

/**
 * Folders a job's commands may not read: where secrets and other code live, such as other repositories'
 * checkouts in the temp folder. Each is hidden even when the job's folder sits inside it: the job's own
 * folder gets a more specific rule. Both the path and where it really is, as macOS links /tmp.
 */
export function jobHidden(env: NodeJS.ProcessEnv = process.env, install: string | null = runnerInstall()): string[] {
  // A self-hosted runner keeps its credentials in its install folder and other repositories' checkouts
  // next to this one in _work: RUNNER_WORKSPACE is <install>/_work/<repository>.
  const work = env.RUNNER_WORKSPACE ? dirname(env.RUNNER_WORKSPACE) : undefined;
  const workParent = work ? dirname(work) : undefined;
  // Anything but the disk's root itself: /runner and /_work are common install and work folders.
  const deepEnough = (p: string | undefined) => (p && p.split("/").filter(Boolean).length >= 1 ? p : undefined);
  // Credential files other tools are told about, wherever they are.
  const named = [env.KUBECONFIG, env.GOOGLE_APPLICATION_CREDENTIALS, env.AWS_SHARED_CREDENTIALS_FILE, env.AWS_CONFIG_FILE, env.GH_CONFIG_DIR, env.DOCKER_CONFIG, env.AZURE_CONFIG_DIR].flatMap((v) => v?.split(":") ?? []);
  // Never a folder the system's own tools are in, such as /usr for a runner installed right there: hiding
  // it would leave a job without bash. The runner's credentials sit elsewhere then, under its own name.
  const system = (p: string) => LINUX_KEEP.includes(p.replace(/\/+$/, ""));
  const places = [homedir(), dirname(homedir()), "/root", "/run/secrets", "/var/run/secrets", env.MERGELIGHT_CACHE, env.RUNNER_TEMP, env.GITHUB_WORKSPACE, deepEnough(work), deepEnough(workParent), deepEnough(install ?? undefined), ...named, tmpdir(), "/tmp"].filter((p): p is string => Boolean(p) && p !== "/" && !system(p));
  const real = places.map((p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  });
  return [...new Set([...places, ...real])];
}

/**
 * The folder the GitHub runner is installed in, found from the running processes: one above this one is
 * <install>/bin/Runner.Worker. Its credentials are there, wherever its work folder was set. Null outside
 * a runner, or when the processes can't be read.
 */
export function runnerInstall(ps: (pid: number) => string | null = psLine, start = process.ppid): string | null {
  let pid = start;
  for (let i = 0; i < 30 && pid > 1; i++) {
    const line = ps(pid) ?? "";
    const m = /^\s*(\d+)\s/.exec(line);
    if (!m) return null;
    // The program's path may hold spaces, so it is found by its ending, not as the first word.
    const exe = /^\s*\d+\s+(.*?\/bin\/Runner\.(?:Worker|Listener))(?:\s|$)/.exec(line)?.[1];
    if (exe) return dirname(dirname(exe));
    pid = Number(m[1]);
  }
  return null;
}

/** One process's parent and command line, as ps prints them. */
function psLine(pid: number): string | null {
  try {
    return execFileSync("ps", ["-o", "ppid=,command=", "-p", String(pid)], { encoding: "utf8", timeout: 5_000 }).trim();
  } catch {
    return null;
  }
}

/** Tokens the runner holds that a reviewing agent has no use for. It only needs its own login. */
const HIDDEN_ENV = new Set(["GH_TOKEN", "GITHUB_TOKEN", "SECRETS_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_RUNTIME_TOKEN", "ACTIONS_RESULTS_URL", "ACTIONS_CACHE_URL", "MERGELIGHT_CLAUDE_TOKEN"]);

export function agentEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !HIDDEN_ENV.has(name)));
}

/** Codex also has no use for a Claude login. */
export function codexEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { CLAUDE_CODE_OAUTH_TOKEN: _token, ANTHROPIC_API_KEY: _key, ...rest } = agentEnv(env);
  return rest;
}

const JWT = /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]+/g;
const ANTHROPIC_SECRET = /\bsk-ant-[\w-]{20,}/g;

/** Takes login tokens out of text that's about to be posted, in case one got past the sandbox. */
export function scrubSecrets(text: string, home = codexHome(), env: NodeJS.ProcessEnv = process.env): string {
  let secrets: string[] = [];
  try {
    const { tokens, OPENAI_API_KEY: key } = JSON.parse(readFileSync(join(home, "auth.json"), "utf8")) as { tokens?: Record<string, unknown>; OPENAI_API_KEY?: unknown };
    secrets = [...Object.values(tokens ?? {}), key].filter((v): v is string => typeof v === "string" && v.length >= 20);
  } catch {
    // No login file to compare with. The pattern below still applies.
  }
  secrets.push(...[env.CLAUDE_CODE_OAUTH_TOKEN, env.ANTHROPIC_API_KEY].filter((v): v is string => typeof v === "string" && v.length >= 20));
  return secrets.reduce((out, secret) => out.split(secret).join("[removed]"), text).replace(JWT, "[removed]").replace(ANTHROPIC_SECRET, "[removed]");
}

let features: Promise<Set<string>> | undefined;

/** The feature switches this Codex has. Codex stops at one it doesn't know, so a switch is only used where it exists. */
function codexFeatures(): Promise<Set<string>> {
  features ??= run("codex", ["features", "list"], { timeoutMs: 15_000 })
    .then((r) => {
      if (r.code !== 0) throw new Error("codex features list failed");
      return new Set(r.stdout.split("\n").map((line) => line.trim().split(/\s+/)[0] ?? "").filter(Boolean));
    })
    .catch(() => {
      // Not kept: the next run asks again.
      features = undefined;
      return new Set<string>();
    });
  return features;
}

/**
 * Switches for a run that must not take instructions from files in its working directory. Codex
 * reads AGENTS.md there by itself and follows it, and it tells the model about every skill it finds
 * under .codex/skills and .agents/skills, which the model then follows too. Tested with Codex
 * 0.167: a planted file of either kind was obeyed, and with these switches it wasn't.
 */
export async function withoutProjectDocs(has: Promise<Set<string>> = codexFeatures()): Promise<string[]> {
  return ["-c", "project_doc_max_bytes=0", ...((await has).has("omit_skill_descriptions") ? ["--enable", "omit_skill_descriptions"] : [])];
}

/**
 * Runs the user's own logged-in Codex CLI, headless, in a sandbox that can read but not write or reach the network.
 * Plugins, MCP servers, hooks and notifications are switched off for the run,
 * so code in a pull request can't steer the reviewer into the user's other tools.
 * Everything else (provider, model, login) is the user's own Codex setup.
 */
export async function runCodex(opts: CodexOptions): Promise<CodexResult> {
  // A run whose time is up never starts: its kill timer would only fire after the job was given up.
  if (opts.deadline && opts.deadline <= Date.now()) throw new Error("there was no time left to start the AI");
  const config = readUserConfig();
  const work = mkdtempSync(join(tmpdir(), "mergelight-codex-"));
  const schemaFile = join(work, "schema.json");
  const outFile = join(work, "output.json");
  writeFileSync(schemaFile, JSON.stringify(opts.schema));

  const args = [
    "exec",
    ...sandboxArgs(codexHome(), opts.edit ? opts.cwd : undefined, opts.edit ? jobHidden() : [], opts.edit ? [...(opts.readDirs ?? []), ...codexInstall()] : []),
    // A job's commands get only the core variables (PATH, HOME and the like), never the runner's own,
    // such as a database password: what they print can end up in a file that gets pushed.
    ...(opts.edit ? ["-c", 'shell_environment_policy.inherit="core"'] : []),
    "--ephemeral",
    "--skip-git-repo-check",
    "--json",
    "-C", opts.cwd,
    "--output-schema", schemaFile,
    "-o", outFile,
    ...["plugins", "apps", "hooks", "image_generation", "browser_use", "computer_use"].flatMap((f) => ["--disable", f]),
    "-c", "notify=[]",
    ...(opts.projectDocs === true ? [] : await withoutProjectDocs()),
    "-c", 'web_search="disabled"',
    ...mcpServers(config).flatMap((name) => ["-c", `mcp_servers.${name}.enabled=false`]),
  ];
  if (opts.model) args.push("-m", opts.model);
  if (opts.effort) args.push("-c", `model_reasoning_effort="${opts.effort}"`);
  args.push("-");

  let commands = 0;
  let completed = 0;
  let sandboxFailures = 0;
  let firstSandboxError = "";
  /** Codex's own errors, kept apart from its stdout, which also carries the code it reads. */
  const failures: string[] = [];
  let usage: CodexResult["usage"] = null;
  let buffer = "";
  const onStdout = (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("{")) continue;
      try {
        const event = JSON.parse(line) as {
          type?: string;
          item?: { type?: string; command?: string; exit_code?: number | null; aggregated_output?: string };
          usage?: { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number };
          message?: string;
          error?: { message?: string };
        };
        if (event.type === "error" || event.type === "turn.failed") failures.push(event.message ?? event.error?.message ?? "");
        if (event.type === "item.started" && event.item?.type === "command_execution") {
          commands++;
          opts.onCommand?.(event.item.command ?? "");
        }
        if (event.type === "item.completed" && event.item?.type === "command_execution") {
          completed++;
          const output = event.item.aggregated_output ?? "";
          if (event.item.exit_code !== 0 && SANDBOX_FAILURE.test(output)) {
            sandboxFailures++;
            firstSandboxError ||= output.split("\n").find((l) => SANDBOX_FAILURE.test(l))?.trim() ?? "";
          }
        }
        if (event.type === "turn.completed" && event.usage) {
          usage = {
            input_tokens: event.usage.input_tokens ?? 0,
            output_tokens: event.usage.output_tokens ?? 0,
            cached_input_tokens: event.usage.cached_input_tokens ?? 0,
          };
        }
      } catch {
        /* not an event line */
      }
    }
  };

  try {
    const result = await run("codex", args, {
      input: opts.prompt,
      timeoutMs: opts.deadline ? Math.max(1, opts.deadline - Date.now()) : (opts.timeoutMs ?? 25 * 60_000),
      onStdout,
      env: codexEnv(),
    });
    if (opts.logFile) {
      mkdirSync(join(opts.logFile, ".."), { recursive: true });
      writeFileSync(opts.logFile, `${result.stdout}\n--- stderr ---\n${result.stderr}`);
    }
    if (result.code !== 0) {
      const tail = scrubSecrets((result.stderr || result.stdout).trim().split("\n").slice(-6).join("\n"));
      const limit = limitFrom(`${result.stderr}\n${failures.join("\n")}`, "ChatGPT");
      if (limit) throw limit;
      // Only a ChatGPT login: a refused API key has a different fix.
      if (process.env.MERGELIGHT_CHATGPT === "1" && LOGIN_FAILURE.test(`${result.stderr}\n${failures.join("\n")}`)) {
        throw new LoginError(loginFailureMessage(process.env.SECRET_NAME || undefined));
      }
      throw new Error(`Codex exited with code ${result.code}.${opts.logFile ? ` Log: ${opts.logFile}` : ""}\n${tail}`);
    }
    // Without a working sandbox Codex can't read the code and reviews the diff blind.
    // Better to fail loudly than to post a review that only looks at the diff.
    if (completed > 0 && sandboxFailures === completed) {
      throw new SandboxError(
        `Codex couldn't run commands in its sandbox on this machine, so it can't read the code (${scrubSecrets(firstSandboxError) || "every command failed"}). On Linux this usually means unprivileged user namespaces are blocked; see docs/github-action.md.`,
      );
    }
    let raw: string;
    try {
      raw = readFileSync(outFile, "utf8");
    } catch {
      throw new Error(`Codex finished without a final answer.${opts.logFile ? ` Log: ${opts.logFile}` : ""}`);
    }
    return {
      output: JSON.parse(scrubSecrets(raw)),
      // Codex doesn't say which default model it used, and --ephemeral keeps it from saving a session
      // file that would: only a model someone named is known.
      model: opts.model ?? configuredModel(config),
      commands,
      usage,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
