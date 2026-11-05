/**
 * JSON Schema for the model's final answer. It is passed to the provider as a
 * structured output schema, so it follows the strict rules: every object lists
 * all its properties as required and allows nothing else.
 */
export const candidateSchema = {
  type: "object",
  additionalProperties: false,
  required: ["candidates"],
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "file", "line", "end_line", "scenario", "impact", "evidence"],
        properties: {
          title: { type: "string" },
          file: { type: "string" },
          line: { type: "integer" },
          end_line: { type: "integer" },
          scenario: { type: "string" },
          impact: { type: "string" },
          evidence: { type: "string" },
        },
      },
    },
  },
} as const;

export const reviewSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "findings", "rejected"],
  properties: {
    rejected: {
      type: "array",
      description: "Candidates you rejected, with the reason.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["candidate", "reason"],
        properties: {
          candidate: { type: "string", description: "The candidate id, like C3." },
          reason: { type: "string" },
        },
      },
    },
    summary: {
      type: "string",
      description:
        "Two plain sentences for someone who does not read code: what the pull request does, and whether it looks safe to merge.",
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "class",
          "title",
          "file",
          "line",
          "end_line",
          "how_it_happens",
          "likelihood",
          "severity",
          "what_breaks",
          "fix",
          "fix_cost",
          "recommendation",
          "verdict",
          "confidence",
        ],
        properties: {
          class: { type: "string", enum: ["bug", "risk", "hardening"] },
          title: { type: "string", description: "Under 80 characters, plain words." },
          file: { type: "string", description: "Path relative to the repository root." },
          line: { type: "integer", description: "First line of the problem in the head version of the file." },
          end_line: { type: "integer", description: "Last line of the problem in the head version of the file." },
          how_it_happens: { type: "string", description: "The concrete trigger, in one or two plain sentences." },
          likelihood: { type: "string", enum: ["common", "plausible", "rare", "theoretical"] },
          severity: {
            type: "string",
            enum: ["major", "minor"],
            description: "major: breaks something, loses data or money, or exposes data. minor: a small but real visible problem.",
          },
          what_breaks: { type: "string", description: "The user-visible or data consequence." },
          fix: { type: "string", description: "The smallest fix that solves it, in one or two sentences." },
          fix_cost: { type: "string", enum: ["trivial", "small", "medium", "large"] },
          recommendation: { type: "string", enum: ["fix", "decide", "leave"] },
          verdict: { type: "string", description: "One short plain sentence a non-engineer understands." },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
        },
      },
    },
  },
} as const;
