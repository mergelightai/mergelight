import assert from "node:assert/strict";
import { test } from "node:test";
import { byVersion, CANARY_TIMEOUT_MS, canaryBranch, canaryVerdict, pickRelease, PLANTED_FILE, summaryFlags } from "../../../.github/scripts/roll-out.mjs";

const releases = [
  { tag: "v0.1.19", sha: "c19" },
  { tag: "v0.1.18", sha: "c18" },
  { tag: "v0.1.17", sha: "c17" },
  { tag: "v0.1.4", sha: "c04" },
];
const verdicts = (map) => (tag) => map[tag] ?? "waiting";

test("a canary passes only when its review finished and flagged the planted bug", () => {
  const openedAt = "2026-11-12T20:00:00Z";
  const soon = Date.parse(openedAt) + 60_000;
  const done = (title) => ({ status: "completed", output: { title } });
  const verdict = (check, flaggedPlantedFile = true, now = soon) => canaryVerdict({ check, flaggedPlantedFile, openedAt, now }).verdict;
  assert.equal(verdict(undefined), "waiting");
  assert.equal(verdict({ status: "in_progress", output: { title: "Reviewing" } }), "waiting");
  assert.equal(verdict(done("🔴 Blocked: 1 bug to fix")), "passed");
  assert.equal(verdict(done("🟡 Needs a human: 1 minor bug to fix")), "passed");
  assert.equal(verdict(done("🟢 Approved by someone")), "passed", "someone approved the canary by mistake");
  assert.equal(verdict(done("🟢 Safe to merge")), "failed", "the planted bug was missed");
  assert.equal(verdict(done("Couldn't review this pull request")), "failed");
  assert.equal(verdict(done("The ChatGPT login didn't work")), "failed");
  assert.equal(verdict(done(null)), "failed");
});

test("a canary that flags only other things fails", () => {
  const result = canaryVerdict({ check: { status: "completed", output: { title: "🟡 Needs a human: 1 risk to fix" } }, flaggedPlantedFile: false, openedAt: "2026-11-12T20:00:00Z" });
  assert.equal(result.verdict, "failed");
  assert.match(result.why, new RegExp(PLANTED_FILE));
});

test("a canary with no finished review after 3 hours fails, so a release that hangs still says so", () => {
  const openedAt = "2026-11-12T20:00:00Z";
  const late = Date.parse(openedAt) + CANARY_TIMEOUT_MS + 1;
  assert.equal(canaryVerdict({ check: undefined, openedAt, now: late }).verdict, "failed");
  assert.equal(canaryVerdict({ check: { status: "in_progress" }, openedAt, now: late }).why, "no finished review after 3 hours");
  assert.equal(canaryVerdict({ check: { status: "in_progress" }, openedAt, now: late - 2 }).verdict, "waiting");
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

test("a tag on a pulled release with nothing that passed is reported as stuck, not left quiet", () => {
  const pick = pickRelease(releases, verdicts({}), "pulled");
  assert.equal(pick.move, undefined);
  assert.equal(pick.stuck, true);
  assert.equal(pickRelease(releases, verdicts({}), "").stuck, false, "no tag yet is not stuck");
});

test("a run by hand with now takes the newest release without its canary", () => {
  assert.equal(pickRelease(releases, verdicts({}), "c04", true).move.tag, "v0.1.19");
  assert.equal(pickRelease(releases, verdicts({}), "c19", true).stay, "v0.1.19");
});

test("a major tag that doesn't exist yet is created on the newest release that passed", () => {
  assert.equal(pickRelease(releases, verdicts({ "v0.1.18": "passed" }), "").move.tag, "v0.1.18");
});

test("the summary counts the planted file only in a finding to fix, not in the intro or the left-alone list", () => {
  const intro = `This pull request adds ${PLANTED_FILE} and pins the workflow.\n\n`;
  assert.equal(summaryFlags(`${intro}#### To fix\n- 🔴 Major bug: [Anyone can delete any project](u) \`${PLANTED_FILE}:5\``), true);
  assert.equal(summaryFlags(`${intro}#### Also worth fixing\n<details><summary>🟠 Minor bug: <b>t</b> <code>${PLANTED_FILE}:5</code></summary>`), true);
  assert.equal(summaryFlags(`${intro}#### To fix\n- 🟡 Risk: [Pin](u) \`.github/workflows/mergelight.yml:35\``), false, "only the intro names it");
  assert.equal(summaryFlags(`${intro}<details><summary>Left alone: 1</summary>\n- x \`${PLANTED_FILE}:5\``), false);
  assert.equal(summaryFlags(`${intro}#### Your call\n- x \`${PLANTED_FILE}:5\``), false);
  assert.equal(summaryFlags(`The bug at \`${PLANTED_FILE}:5\` is left as hardening.\n\n#### To fix\n- 🟡 Risk: [Pin](u) \`.github/workflows/mergelight.yml:35\``), false, "the intro is skipped");
  assert.equal(summaryFlags(`No findings at \`${PLANTED_FILE}:5\`.`), false, "no findings section at all");
  assert.equal(summaryFlags(`${intro}**1 minor bug to fix**\n\n- 🟠 Minor bug: [Anyone can delete any project](u) \`${PLANTED_FILE}:5\``), true, "one list with no heading");
  assert.equal(summaryFlags(`${intro}**Nothing left to fix**\n\n<details><summary>Left alone: 1</summary>\n- x \`${PLANTED_FILE}:5\``), false);
  assert.equal(summaryFlags(undefined), false);
});

test("a review run again after 3 hours gets its own 3 hours", () => {
  const openedAt = "2026-11-12T20:00:00Z";
  const started = Date.parse(openedAt) + CANARY_TIMEOUT_MS + 60_000;
  const check = { status: "in_progress", started_at: new Date(started).toISOString() };
  assert.equal(canaryVerdict({ check, openedAt, now: started + 60_000 }).verdict, "waiting");
  assert.equal(canaryVerdict({ check, openedAt, now: started + CANARY_TIMEOUT_MS + 1 }).verdict, "failed");
});

test("a release whose canary never opened is listed apart from a failed one", () => {
  const pick = pickRelease(releases, verdicts({ "v0.1.19": "missing", "v0.1.18": "failed", "v0.1.17": "passed" }), "c04");
  assert.equal(pick.move.tag, "v0.1.17");
  assert.deepEqual(pick.missing, ["v0.1.19"]);
  assert.deepEqual(pick.failed, ["v0.1.18"]);
});
