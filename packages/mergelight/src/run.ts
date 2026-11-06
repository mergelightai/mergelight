import { spawn } from "node:child_process";

export interface RunOptions {
  cwd?: string;
  input?: string;
  env?: NodeJS.ProcessEnv;
  /** Kill the process after this many milliseconds. */
  timeoutMs?: number;
  /** Called with each chunk of stdout as it arrives. */
  onStdout?: (chunk: string) => void;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class CommandError extends Error {
  constructor(
    readonly command: string,
    readonly result: RunResult,
  ) {
    const detail = (result.stderr || result.stdout).trim().split("\n").slice(-8).join("\n");
    super(`${command} failed with exit code ${result.code}${detail ? `:\n${detail}` : ""}`);
  }
}

/** Run a command without a shell. Resolves with its output, whatever the exit code. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs);
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      opts.onStdout?.(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? (signal ? 128 : 1) });
    });
    child.stdin.on("error", () => {
      /* the process may exit before reading all input */
    });
    child.stdin.end(opts.input ?? "");
  });
}

/** Run a command and throw a CommandError if it exits non-zero. */
export async function runOk(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const result = await run(cmd, args, opts);
  if (result.code !== 0) throw new CommandError(`${cmd} ${args.slice(0, 3).join(" ")}`, result);
  return result;
}
