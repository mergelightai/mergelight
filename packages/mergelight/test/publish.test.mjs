// Run with: npm test (builds first)
import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePatch, place } from "../dist/publish/diff-lines.js";
import { clean, inlineBody, summaryBody } from "../dist/publish/markdown.js";
import { decodeState, encodeState, nextState } from "../dist/publish/state.js";

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
  const body = summaryBody({ review, state, urls: new Map(), outside: [] });
  const order = ["Major one", "Risky one", "Minor one"].map((t) => body.indexOf(t));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(body.includes("No longer found since the last review: 1"));
  assert.ok(decodeState(body));
});
