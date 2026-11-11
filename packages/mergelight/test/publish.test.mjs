// Run with: npm test (builds first)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parsePatch, place } from "../dist/publish/diff-lines.js";
import { mergeLight, tierOf } from "../dist/review.js";
import { closedBody, patchTouches, readClosed, reopenedBody, resolvedByPeople, threadAction } from "../dist/publish/closed.js";
import { clean, failedSummaryBody, isFailedSummary, limitNotice, notReadLine, loginNotice, FINDING_MARKER_RE, inlineBody, isPendingSummary, pendingSummaryBody, SUMMARY_MARKER, summaryBody } from "../dist/publish/markdown.js";
import { APPROVAL_MARKER, approvalHold, approvalLight, UNREVIEWED, checkConclusion, isYellowCheck, syncApproval, trustedComment, CHECK_FAILED_TITLE, checkLimitTitle, checkLoginTitle, isFailedCheckTitle } from "../dist/publish/publish.js";
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
  assert.equal(body.match(/<details><summary>🔴 Bug: <b>Listed one<\/b> <code>[^<]+<\/code><\/summary>/g)?.length, 1, body);
  assert.ok(!body.includes("<summary>Details</summary>"), body);
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
  assert.equal(checkConclusion("red"), "neutral", "a review is a judgment, not a failed build: no red cross unless the team asks for it");
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
  const body = failedSummaryBody(loginNotice("ChatGPT", reason));
  assert.ok(body.includes(SUMMARY_MARKER));
  assert.ok(body.includes(reason));
  assert.doesNotMatch(body, /couldn't review/);
  assert.match(failedSummaryBody(), /couldn't review/);
  assert.match(failedSummaryBody(loginNotice("Claude", "r")), /the Claude login didn't work/);
});

test("a used-up plan says so and when it comes back, instead of the general failure", () => {
  const body = failedSummaryBody(limitNotice("Claude", "9am (UTC)"));
  assert.ok(body.includes(SUMMARY_MARKER), "the next round still finds it");
  assert.ok(!isPendingSummary(body));
  assert.match(body, /### ⏳ Mergelight: your Claude plan hit its limit/);
  assert.match(body, /\*\*Resets:\*\* 9am \(UTC\)/);
  assert.doesNotMatch(body, /couldn't review/);
  const unknown = failedSummaryBody(limitNotice("ChatGPT", null));
  assert.match(unknown, /your ChatGPT plan hit its limit/);
  assert.match(unknown, /once your plan has usage again/);
  assert.doesNotMatch(unknown, /Resets/);
});

test("a newer failure can replace an older one, but never real results", () => {
  assert.ok(isFailedSummary(failedSummaryBody()));
  assert.ok(isFailedSummary(failedSummaryBody(limitNotice("Claude", null))));
  assert.ok(isFailedSummary(`${SUMMARY_MARKER}\n### ⚠️ Mergelight couldn't review this pull request\n\nThe Mergelight check has the reason. The next push tries again.`), "a failure written by an earlier release");
  assert.ok(!isFailedSummary(pendingSummaryBody()));
  assert.ok(!isFailedSummary(undefined));
  assert.ok(!isFailedSummary(`${SUMMARY_MARKER}\nSafe to merge\n<!-- mergelight:failed -->\n`), "results that quote the marker stay");
});

test("every way a review can end early counts as failed", () => {
  for (const title of [CHECK_FAILED_TITLE, checkLimitTitle("Claude"), checkLimitTitle("ChatGPT"), checkLoginTitle("ChatGPT"), checkLoginTitle("Claude")]) assert.ok(isFailedCheckTitle(title), title);
  assert.ok(!isFailedCheckTitle("Safe to merge"));
  assert.ok(!isFailedCheckTitle(undefined));
  assert.match(checkLimitTitle("Claude"), /^Couldn't review/, "the setup page reads this start");
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

function reviewsApi(reviews) {
  const writes = [];
  return { writes, list: async () => reviews, write: async (method, path, body) => (writes.push({ method, path, body }), { id: 1 }) };
}
const ours = (over) => ({ id: 7, state: "APPROVED", commit_id: "old", body: `${APPROVAL_MARKER}\nok`, user: { login: "mergelight-ai[bot]" }, ...over });

test("green approves the commit, once", async () => {
  const fresh = reviewsApi([]);
  assert.equal(await syncApproval(fresh, 3, "green", "head"), "approved");
  assert.equal(fresh.writes[0].path, "pulls/3/reviews");
  assert.equal(fresh.writes[0].body.event, "APPROVE");
  assert.equal(fresh.writes[0].body.commit_id, "head");
  const again = reviewsApi([ours({ commit_id: "head" })]);
  assert.equal(await syncApproval(again, 3, "green", "head"), "already");
  assert.equal(again.writes.length, 0);
});

test("Mergelight doesn't approve a pull request while one of the team's own checks hasn't passed", () => {
  const check = (outcome) => ({ id: "K1", name: "Translations", text: "t", outcome, summary: "s", problems: [] });
  assert.equal(approvalLight({ light: "green" }), "green");
  assert.equal(approvalLight({ light: "green", team_checks: [] }), "green");
  assert.equal(approvalLight({ light: "green", team_checks: [check("pass"), check("skipped")] }), "green");
  // A failed check, one that couldn't tell and one that couldn't run each hold the approval back, and take an earlier one away.
  for (const outcome of ["fail", "unsure", "error"]) assert.equal(approvalLight({ light: "green", team_checks: [check("pass"), check(outcome)] }), "yellow", outcome);
  // The review's own light is never made better or worse than it is.
  assert.equal(approvalLight({ light: "yellow", team_checks: [check("pass")] }), "yellow");
  assert.equal(approvalLight({ light: "red", team_checks: [check("fail")] }), "red");
  // The dismissal names the check that held the approval, not a finding the review never had.
  assert.equal(approvalHold({ team_checks: [check("pass"), check("fail")] }), `Your team's check "Translations" hasn't passed.`);
  assert.equal(approvalHold({ team_checks: [check("fail"), { ...check("error"), name: "Refunds" }] }), `Your team's checks "Translations", "Refunds" haven't passed.`);
  assert.equal(approvalHold({ team_checks: [check("pass")] }), null);
});

test("Mergelight doesn't approve when the team's server couldn't be asked for its rules and checks", () => {
  // No checks ran, so none failed. But nobody knows what the team's rules and checks would have said.
  assert.equal(approvalLight({ light: "green" }, true), "yellow");
  assert.match(approvalHold({}, true), /couldn't reach your team's server/);
  assert.equal(approvalLight({ light: "green" }, false), "green");
  assert.equal(approvalLight({ light: "red" }, true), "red");
});

test("a dismissal says why, and a review that couldn't run takes an earlier approval back", async () => {
  const sent = [];
  const api = {
    list: async () => [{ id: 9, state: "APPROVED", commit_id: "older", body: `${APPROVAL_MARKER}\nfine`, user: { login: "mergelight-ai[bot]" } }],
    write: async (method, path, body) => (sent.push([method, path, body]), {}),
  };
  assert.equal(await syncApproval(api, 3, "yellow", "head", () => {}, { why: UNREVIEWED, otherCommitsOnly: true }), "dismissed");
  assert.deepEqual(sent, [["PUT", "pulls/3/reviews/9/dismissals", { message: UNREVIEWED, event: "DISMISS" }]]);
  sent.length = 0;
  assert.equal(await syncApproval(api, 3, "yellow", "head"), "dismissed");
  assert.equal(sent[0][2].message, "A newer Mergelight review found something to look at.");
  // A second run on a commit Mergelight already approved fails: what the first run said about that commit still stands.
  sent.length = 0;
  assert.equal(await syncApproval(api, 3, "yellow", "older", () => {}, { why: UNREVIEWED, otherCommitsOnly: true }), "none");
  assert.deepEqual(sent, []);
});

test("yellow and red take back Mergelight's approval, and never request changes", async () => {
  for (const light of ["yellow", "red"]) {
    const api = reviewsApi([ours(), ours({ id: 8, state: "DISMISSED" })]);
    assert.equal(await syncApproval(api, 3, light, "head"), "dismissed");
    assert.deepEqual(api.writes.map((w) => w.path), ["pulls/3/reviews/7/dismissals"]);
    assert.ok(!api.writes.some((w) => w.body.event === "REQUEST_CHANGES"));
  }
});

test("a person's approval is never touched, even if it quotes the marker", async () => {
  const api = reviewsApi([ours({ user: { login: "someone" } }), { id: 9, state: "APPROVED", commit_id: "x", body: "lgtm", user: { login: "someone" } }]);
  assert.equal(await syncApproval(api, 3, "red", "head"), "none");
  assert.equal(api.writes.length, 0);
});

test("a refused approval only logs, because the check already has the result", async () => {
  const logs = [];
  const api = { list: async () => [], write: async () => { throw new Error("HTTP 422"); } };
  assert.equal(await syncApproval(api, 3, "green", "head", (l) => logs.push(l)), "none");
  assert.match(logs[0], /Couldn't update Mergelight's approval/);
});

test("a fold-out title is safe HTML, keeps code, and mentions nobody", () => {
  const findings = [finding({ id: "5555555555", tier: "list", title: "<img src=x> breaks `foo` for @alice & co" })];
  const review = {
    pr: { owner: "o", repo: "r", number: 1, title: "t", url: "u", base_sha: "b", head_sha: "abcdef1234" },
    provider: { name: "codex", model: null }, verifier: null, light: "yellow", summary: "Summary.", findings, stats: { duration_ms: 1000 },
  };
  const body = summaryBody({ review, state: nextState(null, findings, "abcdef1234", "yellow", new Map()), urls: new Map() }, false);
  const summary = body.match(/<summary>.*<\/summary>/)[0];
  assert.ok(summary.includes("&lt;img src=x&gt;"), summary);
  assert.ok(summary.includes("<code>foo</code>"), summary);
  assert.ok(summary.includes("&amp; co"), summary);
  assert.ok(!/(^|[^\w`])@alice/.test(summary), summary);
});

test("minor risks and rare findings are left alone, but a major bug never is", () => {
  const f = (over) => ({ class: "risk", severity: "major", likelihood: "plausible", recommendation: "fix", rank: null, ...over });
  assert.equal(tierOf(f({})), "list", "a major risk stays");
  assert.equal(tierOf(f({ severity: "minor" })), "hardening");
  assert.equal(tierOf(f({ severity: "minor", rank: 1 })), "hardening", "even as a top pick");
  assert.equal(tierOf(f({ severity: "minor", recommendation: "decide" })), "hardening");
  assert.equal(tierOf(f({ likelihood: "rare" })), "hardening");
  assert.equal(tierOf(f({ class: "bug", severity: "minor", likelihood: "rare" })), "hardening");
  assert.equal(tierOf(f({ class: "bug", severity: "minor" })), "list", "a minor bug that really happens stays");
  assert.equal(tierOf(f({ class: "bug", likelihood: "rare" })), "list", "a rare major bug stays, because it turns the check red");
  assert.equal(tierOf(f({ class: "bug", likelihood: "rare", rank: 1 })), "post");
});

test("a pull request with only minor risks can go green", () => {
  const only = [{ class: "risk", severity: "minor", recommendation: "fix", tier: tierOf({ class: "risk", severity: "minor", likelihood: "plausible", recommendation: "fix", rank: null }) }];
  assert.equal(mergeLight(only), "green");
});


test("the comment says which actions' code wasn't read", () => {
  assert.equal(notReadLine(undefined), null);
  assert.equal(notReadLine([]), null);
  assert.equal(notReadLine([{ uses: "acme/tool@v1", why: "program" }]), "<sub>Not read: the code that `acme/tool@v1` runs (a Node or Docker action, so only its definition was read).</sub>");
  const both = notReadLine([{ uses: "a/b@v1", why: "program" }, { uses: "c/d@v2", why: "program" }, { uses: "x/y@v3", why: "unreadable" }]);
  assert.match(both, /`a\/b@v1`, `c\/d@v2` run \(a Node or Docker action, so only their definitions were read\), and `x\/y@v3` \(couldn't be read\)\./);
  const many = notReadLine(Array.from({ length: 6 }, (_, i) => ({ uses: `a/t${i}@v1`, why: "unreadable" })));
  assert.match(many, /`a\/t3@v1` and 2 more/);
  assert.doesNotMatch(notReadLine([{ uses: "a/b@v1`<img>", why: "unreadable" }]), /<img>/);
});

test("a patch touches a finding when a hunk's old lines reach it, context included", () => {
  const patch = "@@ -10,3 +10,4 @@ fn\n a\n+b\n@@ -40 +41 @@\n-c\n+d\n@@ -60,0 +62,2 @@\n+e";
  assert.equal(patchTouches(patch, 12, 12), true);
  assert.equal(patchTouches(patch, 13, 20), false);
  assert.equal(patchTouches(patch, 40, 40), true);
  assert.equal(patchTouches(patch, 60, 60), true, "an insertion after line 60 counts for line 60");
  assert.equal(patchTouches(patch, 1, 9), false);
});

test("a round is dated by when its review started, so a reply written while it ran counts as newer", () => {
  const state = nextState(null, [], "a".repeat(40), "green", new Map(), new Date("2030-01-01T10:00:00Z"));
  assert.equal(state.rounds[0].at, "2030-01-01T10:00:00.000Z");
});

test("the state keeps the reasons waiting for the server, and only when there are some", () => {
  const sha = "a".repeat(40);
  assert.deepEqual(nextState(null, [], sha, "green", new Map(), new Date(), [{ id: "abcdef1234", at: "2030-01-01T00:00:00Z" }]).remember, [{ id: "abcdef1234", at: "2030-01-01T00:00:00Z" }]);
  assert.equal("remember" in nextState(null, [], sha, "green", new Map()), false);
});
