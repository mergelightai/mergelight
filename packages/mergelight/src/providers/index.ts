import { runClaude } from "./claude.js";
export { claudeAvailable } from "./claude.js";
import { runCodex } from "./codex.js";

export type ProviderName = "codex" | "claude";

export interface ModelOptions {
  /** Read-only working directory for the agent. */
  cwd: string;
  prompt: string;
  schema: object;
  model?: string;
  effort?: string;
  /** Where to keep the raw log for debugging. */
  logFile?: string;
  timeoutMs?: number;
  /**
   * False when the agent must not take instructions from files in the checkout, such as AGENTS.md.
   * The checkout is the pull request's own, so for one of the team's checks its author could
   * otherwise write there what counts as a pass.
   */
  projectDocs?: boolean;
  /** Called whenever the agent starts a shell command (Codex only). */
  onCommand?: (command: string) => void;
}

export interface ModelResult {
  output: unknown;
  model: string | null;
  commands: number;
  usage: { input_tokens: number; output_tokens: number } | null;
  /** List-price cost the CLI reports, if it does. On a subscription nothing is billed per run. */
  cost_usd?: number | null;
}

/** How each provider's agent reads the checkout, so prompts can name the right tools. */
export const TOOLING: Record<ProviderName, "shell" | "files"> = { codex: "shell", claude: "files" };

export function runModel(provider: ProviderName, opts: ModelOptions): Promise<ModelResult> {
  return provider === "claude" ? runClaude(opts) : runCodex(opts);
}
