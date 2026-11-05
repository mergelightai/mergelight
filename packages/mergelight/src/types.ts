/** The three kinds of finding Mergelight posts. Style and nitpicks are never posted. */
export type FindingClass = "bug" | "risk" | "hardening";

/** How likely the trigger is in real use. */
export type Likelihood = "common" | "plausible" | "rare" | "theoretical";

/** Size of the smallest correct fix. */
export type FixCost = "trivial" | "small" | "medium" | "large";

/** What the team should do: fix it, decide as a human, or leave it alone. */
export type Recommendation = "fix" | "decide" | "leave";

export type Confidence = "high" | "medium" | "low";

/** How much damage it does when it happens. Separate from how likely it is. */
export type Severity = "major" | "minor";

/** One finding exactly as the model returns it (see schema.ts). */
export interface ModelFinding {
  class: FindingClass;
  title: string;
  file: string;
  line: number;
  end_line: number;
  how_it_happens: string;
  likelihood: Likelihood;
  severity: Severity;
  what_breaks: string;
  fix: string;
  fix_cost: FixCost;
  recommendation: Recommendation;
  verdict: string;
  confidence: Confidence;
}

export interface ModelReview {
  summary: string;
  findings: ModelFinding[];
  rejected: { candidate: string; reason: string }[];
}

/**
 * Where a finding shows up. post: its own inline comment. decision: a line in
 * the summary for a human to decide. hardening: collapsed, left alone by default.
 */
export type Tier = "post" | "decision" | "hardening";

export interface Finding extends ModelFinding {
  /** Stable id from the file and the code the finding points at, not the line number. */
  id: string;
  tier: Tier;
}

/** The merge light: green is safe, yellow needs a human, red is blocked. */
export type Light = "green" | "yellow" | "red";

export interface PullRequest {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  url: string;
  author: string;
  baseRef: string;
  /** Base commit GitHub records for the PR. The diff starts at its merge base with headSha. */
  baseSha: string;
  /** Latest commit on the PR. */
  headSha: string;
  additions: number;
  deletions: number;
  changedFiles: number;
}

export interface Review {
  schema_version: 1;
  pr: {
    owner: string;
    repo: string;
    number: number;
    title: string;
    url: string;
    base_sha: string;
    head_sha: string;
  };
  provider: { name: "codex"; model: string | null };
  light: Light;
  summary: string;
  findings: Finding[];
  stats: {
    duration_ms: number;
    diff_chars: number;
    files_changed: number;
    additions: number;
    deletions: number;
  };
  /** What the hunters reported and what the verifier threw out, for tuning. */
  trace: {
    candidates: { focus: string; title: string; file: string; line: number }[];
    rejected: { candidate: string; reason: string }[];
    failed_hunters: string[];
  };
  created_at: string;
}
