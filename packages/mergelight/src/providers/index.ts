import { runClaude } from "./claude.js";
export { claudeAvailable } from "./claude.js";
import { runCodex } from "./codex.js";

export type ProviderName = "codex" | "claude";

export interface ModelOptions {
  /** Working directory for the agent. Read-only, unless edit is set. */
  cwd: string;
  prompt: string;
  schema: object;
  model?: string;
  effort?: string;
  /** Where to keep the raw log for debugging. */
  logFile?: string;
  timeoutMs?: number;
  /**
   * True only when the agent may take instructions from files in the checkout, such as AGENTS.md or a
   * skill folder. Off by default: the checkout is the pull request's own, so its author could write
   * there what the reviewers skip, or what counts as a pass for one of the team's checks. The team's
   * conventions reach the prompt from the base branch instead.
   */
  projectDocs?: boolean;
  /**
   * True for a job: the agent may change files in cwd, and nowhere else. Off, it can only read. The
   * caller checks every change afterwards; this only keeps the agent's hands inside the folder.
   */
  edit?: boolean;
  /** When the run must end, as a time: worked out into a timeout right before the program starts. */
  deadline?: number;
  /** Folders outside cwd the agent may read, such as a job's skill (Claude only: Codex reads the whole disk). */
  readDirs?: string[];
  /** Called whenever the agent starts a shell command (Codex only). */
  onCommand?: (command: string) => void;
}

export interface ModelResult {
  output: unknown;
  model: string | null;
  commands: number;
  /** input_tokens counts every token read, cached ones included; cached_input_tokens is the part read from cache. */
  usage: { input_tokens: number; output_tokens: number; cached_input_tokens?: number } | null;
  /** List-price cost the CLI reports, if it does. On a subscription nothing is billed per run. */
  cost_usd?: number | null;
}

/** How each provider's agent reads the checkout, so prompts can name the right tools. */
export const TOOLING: Record<ProviderName, "shell" | "files"> = { codex: "shell", claude: "files" };

export function runModel(provider: ProviderName, opts: ModelOptions): Promise<ModelResult> {
  return provider === "claude" ? runClaude(opts) : runCodex(opts);
}
