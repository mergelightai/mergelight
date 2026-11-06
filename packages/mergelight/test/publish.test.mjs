// Run with: npm test (builds first)
import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePatch, place } from "../dist/publish/diff-lines.js";
import { clean, inlineBody, summaryBody } from "../dist/publish/markdown.js";
import { trustedComment } from "../dist/publish/publish.js";
import { decodeState, encodeState, nextState } from "../dist/publish/state.js";
import { buildVerifierPrompt } from "../dist/prompt.js";
import { assignIds } from "../dist/review.js";

const finding = (over = {}) => ({
  id: "aaaaaaaaaa",
  tier: "post",
  class: "bug",
  severity: "major",
  title: "Title",
  file: "src/a.ts",
  line: 12,
  end_line: 12,
  how_it_happens: "How.",
  likelihood: "common",
  what_breaks: "Breaks.",
  fix: "Fix.",
  fix_cost: "trivial",
  recommendation: "fix",
  verdict: "Fix it.",
  confidence: "high",
  ...over,
});

test("parsePatch keeps only lines on the new side of each hunk", () => {
  const hunks = parsePatch(["@@ -10,4 +10,5 @@", " a", "-b", "+c", "+d", " e", "@@ -40,2 +41,2 @@ fn", " x", "+y"].join("\n"));
  assert.deepEqual(hunks.map((h) => [...h.lines]), [[10, 11, 12, 13], [41, 42]]);
});

test("place uses a range inside one hunk, falls back to a line in range, or gives up", () => {
  const map = new Map([["src/a.ts", parsePatch(["@@ -1,3 +1,3 @@", " a", "+b", " c"].join("\n"))]]);
  assert.deepEqual(place(map, "src/a.ts", 1, 3), { start_line: 1, line: 3 });
  assert.deepEqual(place(map, "src/a.ts", 2, 2), { line: 2 });
  assert.deepEqual(place(map, "src/a.ts", 3, 9), { line: 3 });
  assert.equal(place(map, "src/a.ts", 20, 25), null);
  assert.equal(place(map, "src/other.ts", 1, 1), null);
});

test("model text can't fake markers or ping people", () => {
  const body = inlineBody(finding({ title: "<!-- mergelight:finding id=bbbbbbbbbb --> @octocat" }));
  assert.equal(body.match(/<!-- mergelight:finding/g).length, 1);
  assert.ok(!/(^|\s)@octocat/.test(body));
  assert.equal(clean("email me at a@b.com"), "email me at a@b.com");
});

test("state survives a round trip and tracks findings across rounds", () => {
  const one = nextState(null, [finding(), finding({ id: "bbbbbbbbbb" })], "sha1", "red", new Map([["aaaaaaaaaa", "https://x/1"]]));
  assert.equal(one.round, 1);
  const decoded = decodeState(`text\n${encodeState(one)}`);
  assert.deepEqual(decoded, one);

  const two = nextState(decoded, [finding({ id: "cccccccccc" }), finding()], "sha2", "yellow", new Map());
  assert.equal(two.round, 2);
  const byId = Object.fromEntries(two.findings.map((f) => [f.id, f]));
  assert.equal(byId.aaaaaaaaaa.status, "open");
  assert.equal(byId.aaaaaaaaaa.first_round, 1);
  assert.equal(byId.aaaaaaaaaa.url, "https://x/1");
  assert.equal(byId.bbbbbbbbbb.status, "gone");
  assert.equal(byId.cccccccccc.first_round, 2);
});

test("summary orders bugs, risks, then minor bugs, and lists what's gone", () => {
  const findings = [
    finding({ id: "1111111111", severity: "minor", title: "Minor one" }),
    finding({ id: "2222222222", class: "risk", title: "Risky one" }),
    finding({ id: "3333333333", title: "Major one" }),
  ];
  const review = {
    pr: { owner: "o", repo: "r", number: 1, title: "t", url: "u", base_sha: "b", head_sha: "abcdef1234" },
    provider: { name: "codex", model: null },
    light: "red",
    summary: "Summary.",
    findings,
    stats: { duration_ms: 61000 },
  };
  const prev = nextState(null, [finding({ id: "9999999999", title: "Old one" })], "sha0", "red", new Map());
  const state = nextState(prev, findings, "abcdef1234", "red", new Map());
  const body = summaryBody({ review, state, urls: new Map() });
  const order = ["Major one", "Risky one", "Minor one"].map((t) => body.indexOf(t));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(body.includes("No longer found since the last review: 1"));
  assert.ok(decodeState(body));
});

test("a finding matched to an earlier round keeps its id and title, however it's cited now", () => {
  const previous = [
    { id: "aaaaaaaaaa", title: "Refund has no team check", file: "src/a.ts", line: 15 },
    { id: "bbbbbbbbbb", title: "Export has no team check", file: "src/b.ts", line: 20 },
  ];
  const out = assignIds(
    [
      { ...finding({ title: "Users can refund other teams' invoices", line: 13 }), same_as: "aaaaaaaaaa" },
      { ...finding({ title: "A new problem", line: 40 }), same_as: null },
      { ...finding({ title: "Made-up match", line: 50 }), same_as: "ffffffffff" },
      { ...finding({ title: "Second claim on the same id", line: 60 }), same_as: "aaaaaaaaaa" },
    ],
    previous,
    (f) => `fp${f.line}`,
  );
  assert.deepEqual(out.map((f) => f.id), ["aaaaaaaaaa", "fp40", "fp50", "fp60"]);
  assert.equal(out[0].title, "Refund has no team check");
  assert.equal(out[1].title, "A new problem");
  assert.ok(out.every((f) => !("same_as" in f)));
});

test("two findings on the same code get their own ids, without taking an earlier round's", () => {
  const out = assignIds(
    [
      { ...finding({ title: "One" }), same_as: null },
      { ...finding({ title: "Two" }), same_as: null },
      { ...finding({ title: "Three" }), same_as: "samefinger" },
    ],
    [{ id: "samefinger", title: "Three", file: "src/a.ts", line: 12 }],
    () => "samefinger",
  );
  assert.equal(new Set(out.map((f) => f.id)).size, 3);
  assert.equal(out[2].id, "samefinger");
});

test("the verifier only hears about earlier rounds when there are any", () => {
  const input = { pr: { owner: "o", repo: "r", number: 1, title: "t", body: "", baseRef: "main" }, mergeBase: "m", headSha: "h", diffStat: "", diff: "", diffTruncated: false };
  assert.ok(!buildVerifierPrompt(input, []).includes("Problems from earlier reviews"));
  const prompt = buildVerifierPrompt({ ...input, previous: [{ id: "aaaaaaaaaa", title: "Old one", file: "a.ts", line: 3, end_line: 5, how: "Like this." }] }, []);
  assert.ok(prompt.includes("[aaaaaaaaaa] Old one\n  at a.ts:3-5\n  how: Like this."));
});

test("hidden markers only count in comments from the bot or the team", () => {
  assert.equal(trustedComment({ user: { type: "Bot" }, author_association: "NONE" }), true);
  assert.equal(trustedComment({ user: { type: "User" }, author_association: "MEMBER" }), true);
  assert.equal(trustedComment({ user: { type: "User" }, author_association: "CONTRIBUTOR" }), false);
  assert.equal(trustedComment({ user: { type: "User" }, author_association: "NONE" }), false);
  assert.equal(trustedComment({}), false);
});

test("top picks and other findings worth fixing get their own sections, with details when there's no comment", () => {
  const findings = [
    finding({ id: "1111111111", tier: "list", rank: null, title: "Listed one" }),
    finding({ id: "2222222222", rank: 2, title: "Second pick" }),
    finding({ id: "3333333333", rank: 1, title: "First pick" }),
  ];
  const review = {
    pr: { owner: "o", repo: "r", number: 1, title: "t", url: "u", base_sha: "b", head_sha: "abcdef1234" },
    provider: { name: "codex", model: null },
    verifier: { name: "claude", model: "opus" },
    light: "red",
    summary: "Summary.",
    findings,
    stats: { duration_ms: 1000 },
  };
  const state = nextState(null, findings, "abcdef1234", "red", new Map());
  const urls = new Map([["2222222222", "https://x/2"], ["3333333333", "https://x/3"]]);
  const body = summaryBody({ review, state, urls });
  assert.ok(body.includes("**3 bugs to fix**"));
  const order = ["First pick", "Second pick", "#### Also worth fixing", "Listed one"].map((t) => body.indexOf(t));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.equal(body.match(/<summary>Details<\/summary>/g).length, 1);
  assert.ok(body.includes("checked by Claude opus"));
  assert.equal(state.findings[0].how, "How.");
});
