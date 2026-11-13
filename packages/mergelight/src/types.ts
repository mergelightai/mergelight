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
  /** same_as: the earlier review's finding this one continues, if any. */
  findings: (ModelFinding & { same_as?: string | null })[];
  /** decision: the team's earlier decision that caused the rejection, when the verifier was given any. */
  rejected: { candidate: string; reason: string; decision?: string | null }[];
  /** Up to 3 findings (1-based) a senior reviewer would hold the merge for, most important first. */
  top: number[];
}

/**
 * Where a finding shows up. post: its own inline comment, only the verifier's
 * top picks. list: worth fixing, listed in the summary. decision: a line in the
 * summary for a human to decide. hardening: collapsed, left alone by default.
 */
export type Tier = "post" | "list" | "decision" | "hardening";

export interface Finding extends ModelFinding {
  /** Stays the same across review rounds: the earlier round's id, or a fingerprint of the file and code it points at. */
  id: string;
  tier: Tier;
  /** 1 to 3 when the verifier picked it as one of the few that matter most, else null. */
  rank: number | null;
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
  /** The branch the PR comes from, and its repository: owner/name, or null when that repository is gone. */
  headRef?: string;
  headRepo?: string | null;
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
  /** Who hunted for problems. */
  provider: { name: "codex" | "claude"; model: string | null; effort: string };
  /** Who checked and sorted them, when that differs from the hunters. */
  verifier?: { name: "codex" | "claude"; model: string | null; effort: string; cost_usd?: number | null };
  light: Light;
  summary: string;
  findings: Finding[];
  /** Changed files the team marked as always needing a human. They keep the light from going green by itself. */
  needs_human?: string[];
  /** The team's earlier decisions the verifier used to leave findings out, by id like "M12". */
  used_memories?: string[];
  /** The team's own checks, each asked as a question of its own. They are posted as checks next to the Mergelight check and don't change the light. */
  team_checks?: TeamCheckResult[];
  /** Actions a changed workflow uses whose code the reviewers couldn't see. */
  not_read?: { uses: string; why: "program" | "unreadable" }[];
  /** What the team's jobs did on this pull request just before the review, when any ran. */
  jobs?: JobsReport;
  stats: {
    duration_ms: number;
    diff_chars: number;
    files_changed: number;
    additions: number;
    deletions: number;
    /** Tokens every model call of the review used. input includes cached; older reviews don't have it. */
    tokens?: { input: number; cached: number; output: number };
  };
  /** What the hunters reported and what the verifier threw out, for tuning. */
  trace: {
    /** Every candidate the hunters and sweeps reported, in full, so the verifier can be replayed. */
    candidates: { focus: string; title: string; file: string; line: number; end_line?: number; scenario?: string; impact?: string; evidence?: string }[];
    rejected: { candidate: string; reason: string }[];
    failed_hunters: string[];
  };
  created_at: string;
}

/** The answer to one of the team's own checks on a pull request. */
export interface TeamCheckResult {
  /** The check's id on the team's server, like "K3". */
  id: string;
  name: string;
  /** The check as the team wrote it. */
  text: string;
  /**
   * pass and fail are the AI's answer. unsure: the AI couldn't see enough to tell. skipped: the pull
   * request changes none of the check's files, so nothing was asked. error: the AI run failed or
   * took too long, so there is no answer.
   */
  outcome: "pass" | "fail" | "unsure" | "skipped" | "error";
  summary: string;
  /** Where the pull request breaks the check. line is 0 when no one line stands for it. */
  problems: { file: string; line: number; note: string }[];
}

/** What the team's jobs did, for the summary. Built from the jobs step's file and the push step's answer. */
export interface JobsReport {
  /** The commit the jobs pushed, when they pushed one. */
  commit?: string;
  /** Why what the jobs changed wasn't pushed, when it wasn't. */
  notPushed?: string;
  outcomes: { name: string; status: "changed" | "nothing" | "refused" | "failed"; files: number; summary: string }[];
  /** Job files that were left out, and why. */
  problems: { source: string; problem: string }[];
}
