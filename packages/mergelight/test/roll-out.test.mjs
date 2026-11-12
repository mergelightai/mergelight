import assert from "node:assert/strict";
import { test } from "node:test";
import { byVersion, canaryBranch, canaryVerdict, pickRelease } from "../../../.github/scripts/roll-out.mjs";

const releases = [
  { tag: "v0.1.19", sha: "c19" },
  { tag: "v0.1.18", sha: "c18" },
  { tag: "v0.1.17", sha: "c17" },
  { tag: "v0.1.4", sha: "c04" },
];
const verdicts = (map) => (tag) => map[tag] ?? "waiting";

test("a canary passes only when its review finished and found something", () => {
  assert.equal(canaryVerdict(undefined), "waiting");
  assert.equal(canaryVerdict({ status: "in_progress", output: { title: "Reviewing" } }), "waiting");
  assert.equal(canaryVerdict({ status: "completed", output: { title: "🔴 Blocked: 1 bug to fix" } }), "passed");
  assert.equal(canaryVerdict({ status: "completed", output: { title: "🟡 Needs a human: 1 minor bug to fix" } }), "passed");
  assert.equal(canaryVerdict({ status: "completed", output: { title: "🟢 Safe to merge" } }), "failed", "the planted bug was missed");
  assert.equal(canaryVerdict({ status: "completed", output: { title: "Couldn't review this pull request" } }), "failed");
  assert.equal(canaryVerdict({ status: "completed", output: { title: "The ChatGPT login didn't work" } }), "failed");
  assert.equal(canaryVerdict({ status: "completed", output: { title: null } }), "failed");
});

test("versions sort by number, newest first", () => {
  assert.deepEqual(["v0.1.9", "v0.1.10", "v0.2.0", "v0.1.4"].sort(byVersion), ["v0.2.0", "v0.1.10", "v0.1.9", "v0.1.4"]);
  assert.equal(canaryBranch("v0.1.18"), "canary/v0.1.18");
});

test("the tag goes to the newest release whose canary passed", () => {
  const pick = pickRelease(releases, verdicts({ "v0.1.19": "waiting", "v0.1.18": "passed" }), "c04");
  assert.equal(pick.move.tag, "v0.1.18");
  assert.deepEqual(pick.waiting, ["v0.1.19"]);
  assert.deepEqual(pick.failed, []);
});

test("a failed canary is skipped and reported, and an older release that passed is taken", () => {
  const pick = pickRelease(releases, verdicts({ "v0.1.19": "failed", "v0.1.18": "passed" }), "c04");
  assert.equal(pick.move.tag, "v0.1.18");
  assert.deepEqual(pick.failed, ["v0.1.19"]);
});

test("never back: the tag stays on a release newer than every one that passed", () => {
  const pick = pickRelease(releases, verdicts({ "v0.1.19": "waiting", "v0.1.17": "passed" }), "c18");
  assert.equal(pick.stay, "v0.1.18");
  assert.equal(pick.move, undefined);
});

test("with no canary that passed, the tag doesn't move", () => {
  const pick = pickRelease(releases, verdicts({}), "c04");
  assert.equal(pick.stay, "v0.1.4");
  assert.deepEqual(pick.waiting, ["v0.1.19", "v0.1.18", "v0.1.17"]);
});

test("a tag on a pulled release moves off it, even back to an older one", () => {
  const pick = pickRelease(releases, verdicts({ "v0.1.17": "passed" }), "pulled");
  assert.equal(pick.move.tag, "v0.1.17");
});

test("a run by hand with now takes the newest release without its canary", () => {
  assert.equal(pickRelease(releases, verdicts({}), "c04", true).move.tag, "v0.1.19");
  assert.equal(pickRelease(releases, verdicts({}), "c19", true).stay, "v0.1.19");
});

test("a major tag that doesn't exist yet is created on the newest release that passed", () => {
  assert.equal(pickRelease(releases, verdicts({ "v0.1.18": "passed" }), "").move.tag, "v0.1.18");
});
