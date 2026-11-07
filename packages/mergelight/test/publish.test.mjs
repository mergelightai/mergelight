// Run with: npm test (builds first)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parsePatch, place } from "../dist/publish/diff-lines.js";
import { closedBody, readClosed, reopenedBody, resolvedByPeople, threadAction } from "../dist/publish/closed.js";
import { clean, failedSummaryBody, FINDING_MARKER_RE, inlineBody, isPendingSummary, pendingSummaryBody, SUMMARY_MARKER, summaryBody } from "../dist/publish/markdown.js";
import { checkConclusion, isYellowCheck, trustedComment } from "../dist/publish/publish.js";
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

const FINDING = "<!-- mergelight:finding id=aaaaaaaaaa -->";
const ORIGINAL = `${FINDING}\n🔴 **Bug** · **Refunds <b>break</b>**\n\nHow it happens.\n\n**→ Fix it.**`;
const bot = { author: { __typename: "Bot" }, authorAssociation: "NONE" };
const thread = (over = {}, body = ORIGINAL, replies = []) => ({
  id: "T1",
  isResolved: false,
  isOutdated: true,
  resolvedBy: null,
  comments: { nodes: [{ databaseId: 7, body, ...bot }, ...replies] },
  ...over,
});
const none = new Set();
const stillFound = new Set(["aaaaaaaaaa"]);

test("a thread counts as fixed only when its code changed and its finding is gone", () => {
  assert.deepEqual(threadAction(thread(), none), { kind: "fixed", resolve: true });
  assert.equal(threadAction(thread(), stillFound), null, "still found");
  assert.equal(threadAction(thread({ isOutdated: false }), none), null, "code unchanged");
});

const writers = async (login) => login === "tommy";

test("a thread someone resolved is handled once the review drops it, never while it still reports it", async () => {
  const resolved = thread({ isResolved: true, isOutdated: false, resolvedBy: { login: "tommy" } });
  assert.deepEqual(threadAction(resolved, none), { kind: "resolved" });
  assert.equal(threadAction(resolved, stillFound), null, "a major bug the verifier keeps stays reported");
  assert.deepEqual([...(await resolvedByPeople([resolved], writers))], [["aaaaaaaaaa", "tommy"]]);
});

test("only people with write access can tell the verifier the team decided", async () => {
  const author = thread({ isResolved: true, resolvedBy: { login: "pr-author" } });
  assert.equal((await resolvedByPeople([author], writers)).size, 0);
  assert.equal((await resolvedByPeople([thread({ isResolved: true, resolvedBy: null })], writers)).size, 0, "no name, no trust");
});

test("only Mergelight's own comments count, not a stranger's copy of the marker", async () => {
  const stranger = { databaseId: 9, body: ORIGINAL, authorAssociation: "NONE", author: { __typename: "User" } };
  const t = { ...thread({ isResolved: true }), comments: { nodes: [stranger] } };
  assert.equal(threadAction(t, none), null);
  assert.equal((await resolvedByPeople([t], writers)).size, 0);
});

test("closing a comment keeps the original behind a dropdown, and reopening restores it", () => {
  const closed = closedBody(ORIGINAL, { how: "fixed", resolved: true, sha: "abc1234" });
  assert.ok(closed.includes("✅ **Handled.**"));
  assert.ok(closed.includes("`abc1234`"));
  assert.ok(closed.includes("<details><summary>🔴 Bug · Refunds &lt;b>break&lt;/b></summary>"), "the dropdown names the finding, safely");
  assert.equal(closed.match(FINDING_MARKER_RE)[1], "aaaaaaaaaa", "still recognised as this finding");
  assert.deepEqual(readClosed(closed), { how: "fixed", resolved: true, sha: "abc1234" });
  assert.equal(reopenedBody(closed, false), ORIGINAL);
  assert.ok(closedBody(ORIGINAL, { how: "resolved", resolved: true, by: "tommy" }).includes("Resolved by tommy."));
});

test("a closed thread stays closed until someone reopens it or the finding comes back", async () => {
  const fixed = closedBody(ORIGINAL, { how: "fixed", resolved: true, sha: "abc1234" });
  assert.equal(threadAction(thread({ isResolved: true }, fixed), none), null);
  assert.deepEqual(threadAction(thread({}, fixed), none), { kind: "reopened" });
  assert.deepEqual(threadAction(thread({ isResolved: true }, fixed), stillFound), { kind: "regressed", unresolve: true });
  assert.equal((await resolvedByPeople([thread({ isResolved: true, resolvedBy: { login: "tommy" } }, fixed)], writers)).size, 0, "a fix isn't a person's decision");

  const resolved = closedBody(ORIGINAL, { how: "resolved", resolved: true, by: "tommy" });
  assert.equal(threadAction(thread({ isResolved: true }, resolved), none), null);
  assert.deepEqual(threadAction(thread({ isResolved: true }, resolved), stillFound), { kind: "regressed", unresolve: false }, "reported again: not handled, but the person's resolve stays");
  assert.deepEqual(threadAction(thread({}, resolved), none), { kind: "reopened" });
});

test("a thread the workflow couldn't resolve isn't mistaken for one someone reopened", () => {
  const closed = closedBody(ORIGINAL, { how: "fixed", resolved: false, sha: "abc1234" });
  assert.equal(threadAction(thread({}, closed), none), null);
  assert.deepEqual(threadAction(thread({}, closed), stillFound), { kind: "regressed", unresolve: false });
});

test("Mergelight doesn't close a thread someone reopened", () => {
  const reopened = reopenedBody(closedBody(ORIGINAL, { how: "fixed", resolved: true }), true);
  assert.equal(reopened.match(FINDING_MARKER_RE)[1], "aaaaaaaaaa");
  assert.equal(threadAction(thread({}, reopened), none), null);
  assert.deepEqual(threadAction(thread({ isResolved: true }, reopened), none), { kind: "resolved" }, "a person can still resolve it");
  assert.ok(!closedBody(reopened, { how: "resolved", resolved: true }).includes("mergelight:reopened"));
});

test("threads an older version answered with a reply aren't answered again", async () => {
  const reply = { databaseId: 8, body: "<!-- mergelight:gone -->\nThe code here changed.", ...bot };
  assert.equal(threadAction(thread({}, ORIGINAL, [reply]), none), null, "someone reopened it");
  assert.deepEqual(threadAction(thread({ isResolved: true }, ORIGINAL, [reply]), none), { kind: "fixed", resolve: false });
  assert.equal((await resolvedByPeople([thread({ isResolved: true, resolvedBy: { login: "tommy" } }, ORIGINAL, [reply])], writers)).size, 0);
});

test("the summary starts as a placeholder, and that placeholder has no state to trip over", () => {
  const body = pendingSummaryBody();
  assert.ok(body.includes(SUMMARY_MARKER));
  assert.ok(isPendingSummary(body));
  assert.equal(decodeState(body), null);
  assert.ok(!isPendingSummary(failedSummaryBody()));
  assert.ok(failedSummaryBody().includes(SUMMARY_MARKER), "the next round still finds it");
});

test("handled findings get their own dropdown, and aren't also listed as no longer found", () => {
  const review = {
    pr: { head_sha: "abcdef1234" },
    provider: { name: "codex", model: "m" },
    light: "green",
    summary: "All good.",
    findings: [],
    stats: { duration_ms: 1000 },
  };
  const one = (id, title) => ({ id, title, file: "src/a.ts", line: 3, tier: "post", class: "bug", severity: "major", first_round: 1, status: "gone", url: `https://x/${id}` });
  const state = { v: 1, round: 2, rounds: [], findings: [one("aaaaaaaaaa", "Fixed one"), one("bbbbbbbbbb", "Resolved one"), one("cccccccccc", "Vanished one"), one("dddddddddd", "Left one")] };
  const handled = new Map([["aaaaaaaaaa", { how: "fixed", sha: "abc1234" }], ["bbbbbbbbbb", { how: "resolved", by: "tommy" }]]);
  const marks = new Map([["dddddddddd", { id: "dddddddddd", as: "wont_fix", note: "Only admins can do this.", sha: null, by: "teammate", at: "", url: "" }]]);
  const body = summaryBody({ review, state, urls: new Map(), handled, marks });
  assert.ok(body.includes("<details><summary>✅ Handled: 3</summary>"), "one list, including decisions not to fix");
  assert.ok(body.includes("- ✅ [Left one](https://x/dddddddddd) `src/a.ts:3`: not fixing. Only admins can do this. (teammate)"));
  assert.ok(body.includes("- ✅ [Fixed one](https://x/aaaaaaaaaa) `src/a.ts:3`: fixed in `abc1234`"));
  assert.ok(body.includes("- ✅ [Resolved one](https://x/bbbbbbbbbb) `src/a.ts:3`: resolved by tommy"));
  assert.ok(body.includes("No longer found since the last review: 1"));
  assert.ok(body.includes("**Nothing left to fix**"));
  assert.ok(!summaryBody({ review, state: { ...state, findings: [] }, urls: new Map() }).includes("Handled"));
});

test("yellow doesn't block unless a team asks, and red always does", () => {
  assert.equal(checkConclusion("green"), "success");
  assert.equal(checkConclusion("yellow"), "neutral");
  assert.equal(checkConclusion("red"), "failure");
  assert.equal(checkConclusion("yellow", true), "action_required");
  assert.equal(checkConclusion("red", true), "failure");
  assert.equal(checkConclusion("green", true), "success");
});

test("an approval turns only a yellow check green, not a review that couldn't run", () => {
  const check = (conclusion, title) => ({ conclusion, output: { title } });
  assert.equal(isYellowCheck(check("neutral", "🟡 Needs a human: 1 risk to fix")), true);
  assert.equal(isYellowCheck(check("action_required", "🟡 Needs a human: 1 risk to fix")), true);
  assert.equal(isYellowCheck(check("neutral", "Couldn't review this pull request")), false);
  assert.equal(isYellowCheck(check("failure", "🔴 Blocked: 1 bug to fix")), false);
  assert.equal(isYellowCheck(check("success", "🟢 Safe to merge: Nothing worth fixing")), false);
  assert.equal(isYellowCheck(check(null, "Reviewing")), false);
});

// Stands in for gh. Check writes fail with the error under test, and the PR itself can't be fetched, so a review stops right there.
const FAKE_GH = `#!/usr/bin/env node
const args = process.argv.slice(2);
require("node:fs").appendFileSync(process.env.FAKE_GH_CALLS, args.join(" ") + "\\n");
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
const answer = (value) => console.log(JSON.stringify(value));
if (args.some((a) => a.endsWith("/check-runs"))) fail(process.env.FAKE_GH_CHECK_ERROR);
if (args.some((a) => a.endsWith("/pulls/1"))) fail("gh: Not Found (HTTP 404)");
if (args.includes("--slurp")) answer([[]]);
else if (args.includes("graphql")) answer({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
else answer({ id: 1, html_url: "https://github.com/o/r/pull/1#issuecomment-1" });
`;

const APP_ONLY = "gh: You must authenticate via a GitHub App. (HTTP 403)";
const SKIPPED = "Skipped the Mergelight check";

function runCli(t, args, checkError) {
  const dir = mkdtempSync(join(tmpdir(), "mergelight-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "gh"), FAKE_GH);
  chmodSync(join(dir, "gh"), 0o755);
  const calls = join(dir, "calls");
  writeFileSync(calls, "");
  writeFileSync(
    join(dir, "review.json"),
    JSON.stringify({
      pr: { owner: "o", repo: "r", number: 1, title: "t", url: "u", base_sha: "b", head_sha: "abcdef1234" },
      provider: { name: "codex", model: null },
      light: "green",
      summary: "Summary.",
      findings: [],
      stats: { duration_ms: 1000 },
    }),
  );
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../dist/cli.js", import.meta.url)), ...args(dir)], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_GH_CALLS: calls, FAKE_GH_CHECK_ERROR: checkError },
  });
  return { ...result, calls: readFileSync(calls, "utf8") };
}

const count = (text, needle) => text.split(needle).length - 1;

test("post on a personal login leaves the comment, skips the check once and exits 0", (t) => {
  const { status, stderr, calls } = runCli(t, (dir) => ["post", join(dir, "review.json")], APP_ONLY);
  assert.equal(status, 0, stderr);
  assert.ok(calls.includes("-X POST repos/o/r/issues/1/comments"));
  assert.equal(count(stderr, SKIPPED), 1);
  assert.ok(stderr.includes("Posted:"));
});

test("review --post on a personal login gets past the check and still skips it only once", (t) => {
  const { status, stderr, calls } = runCli(t, () => ["review", "o/r#1", "--post", "--at", "abcdef1234"], APP_ONLY);
  assert.ok(calls.includes("api repos/o/r/pulls/1"), "the review started");
  assert.equal(status, 1, "the fake PR can't be fetched, so the review itself fails");
  assert.ok(stderr.includes("mergelight: gh api repos/o/r/pulls/1"));
  assert.equal(count(stderr, SKIPPED), 1);
});

test("any other check error still fails post", (t) => {
  const { status, stderr } = runCli(t, (dir) => ["post", join(dir, "review.json")], "gh: Resource not accessible by integration (HTTP 403)");
  assert.notEqual(status, 0);
  assert.ok(stderr.includes("Resource not accessible by integration"));
  assert.ok(!stderr.includes(SKIPPED));
});

test("any other check error still stops review --post before it reviews", (t) => {
  const { status, stderr, calls } = runCli(t, () => ["review", "o/r#1", "--post", "--at", "abcdef1234"], "gh: Resource not accessible by integration (HTTP 403)");
  assert.notEqual(status, 0);
  assert.ok(!calls.includes("api repos/o/r/pulls/1"));
  assert.ok(!stderr.includes(SKIPPED));
});

test("a login failure says what happened and what to do, instead of just failing", () => {
  const reason = "The ChatGPT login didn't work. Re-run this check.";
  const body = failedSummaryBody(reason);
  assert.ok(body.includes(SUMMARY_MARKER));
  assert.ok(body.includes(reason));
  assert.doesNotMatch(body, /couldn't review/);
  assert.match(failedSummaryBody(), /couldn't review/);
});

test("with no top picks the list sits right under the count, and the footer has no link", () => {
  const findings = [finding({ id: "4444444444", tier: "list", title: "Only one" })];
  const review = {
    pr: { owner: "o", repo: "r", number: 1, title: "t", url: "u", base_sha: "b", head_sha: "abcdef1234" },
    provider: { name: "codex", model: null },
    verifier: null,
    light: "yellow",
    summary: "Summary.",
    findings,
    stats: { duration_ms: 1000 },
  };
  const body = summaryBody({ review, state: nextState(null, findings, "abcdef1234", "yellow", new Map()), urls: new Map() });
  assert.ok(body.includes("Only one"), body);
  assert.ok(!body.includes("#### Also worth fixing"), body);
  assert.ok(!body.includes("#### To fix"), body);
  assert.ok(!body.includes('href="https://mergelight.dev"'), body);
});
