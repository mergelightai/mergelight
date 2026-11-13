import assert from "node:assert/strict";
import { test } from "node:test";
import { buildHunterPrompt } from "../dist/prompt.js";
import { jobsLines } from "../dist/publish/markdown.js";
import { jobsReport } from "../dist/run-jobs.js";

const COMMIT = "8873502".padEnd(40, "0");
const result = {
  head: "b".repeat(40),
  outcomes: [
    { name: "translations", source: ".mergelight/jobs/translations.md", status: "changed", files: ["locales/da.json", "locales/de.json"], summary: "Added 3 keys to da.json and de.json." },
    { name: "docs", source: ".mergelight/jobs/docs.md", status: "nothing", files: [], summary: "No new feature to document." },
    { name: "guide", source: ".mergelight/jobs/guide.md", status: "refused", files: ["README.md"], summary: "It changed files it may not: README.md. All its changes were dropped." },
  ],
  problems: [{ source: ".mergelight/jobs/x.md", problem: "names no on paths, the files whose change starts the job" }],
  changes: [{ path: "locales/da.json", contents: "" }],
};

test("the summary's Jobs part says what each job did, and which commit the jobs pushed", () => {
  const report = jobsReport(result, { commit: COMMIT });
  assert.deepEqual(jobsLines(report), [
    "#### Jobs",
    "- ✅ **translations**: Added 3 keys to da.json and de.json. (2 files in `8873502`)",
    "- **docs** changed nothing: No new feature to document.",
    "- ⚠️ **guide** was dropped: It changed files it may not: README.md. All its changes were dropped.",
    "- ⚠️ `.mergelight/jobs/x.md` is left out: names no on paths, the files whose change starts the job.",
    "",
    "The jobs wrote `8873502` with AI, and this review read it like the rest. Pull before you push again.",
  ]);
});

test("when the push step pushed nothing, the summary says why", () => {
  const lines = jobsLines(jobsReport(result, { why: "The branch moved while the jobs ran. The next push runs them again." }));
  assert.ok(lines.includes("- ✅ **translations**: Added 3 keys to da.json and de.json. (2 files, not pushed)"));
  assert.ok(lines.includes("- ⚠️ Nothing was pushed: The branch moved while the jobs ran. The next push runs them again."));
  assert.ok(!lines.some((l) => /Pull before you push/.test(l)));
  assert.match(jobsLines(jobsReport(result, {})).join("\n"), /Nothing was pushed: The push step didn't say why\./);
});

test("the report keeps only what it can show, and nothing when no job ran", () => {
  assert.equal(jobsReport({ head: "x", outcomes: [], problems: [], changes: [], skipped: "This pull request changes none of the files that start a job." }), null);
  assert.equal(jobsReport(null), null);
  const odd = jobsReport({ outcomes: [{ name: "x", status: "hacked", files: [], summary: "" }, { name: "y".repeat(100), status: "nothing", files: "no", summary: "<!-- mergelight:summary --> @team" }], problems: [], changes: [] }, { commit: "not a sha" });
  assert.equal(odd.outcomes.length, 1, "an unknown status is left out");
  assert.equal(odd.outcomes[0].name.length, 40);
  assert.equal(odd.outcomes[0].files, 0);
  assert.equal(odd.commit, undefined, "only a full commit id counts");
  // Text from the file can't fake Mergelight's markers or ping people.
  const shown = jobsLines(odd).join("\n");
  assert.doesNotMatch(shown, /<!-- mergelight/);
  assert.doesNotMatch(shown, /(^|\s)@team/);
});

test("the reviewers learn which commit the jobs wrote, so they read it like the rest", () => {
  const input = { pr: { owner: "acme", repo: "app", number: 7, title: "t", author: "a", baseRef: "main", body: "" }, mergeBase: "base", headSha: COMMIT, diffStat: "", diff: "", diffTruncated: false };
  const prompt = buildHunterPrompt({ ...input, jobCommit: { sha: COMMIT, jobs: ["translations"] } }, "data");
  assert.match(prompt, new RegExp(`The newest commit, ${COMMIT}, was written by the team's jobs "translations" with AI, just before this review, not by the author\\. Review its lines like any other code in the diff\\.`));
  assert.doesNotMatch(buildHunterPrompt(input, "data"), /written by the team's jobs/);
});
