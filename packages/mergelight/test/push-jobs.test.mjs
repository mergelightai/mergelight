import assert from "node:assert/strict";
import { test } from "node:test";
import { parseJobFile } from "../dist/jobs.js";
import { checkPush, commitMessage } from "../dist/push-jobs.js";

const HEAD = "a".repeat(40);
const translations = parseJobFile(".mergelight/jobs/translations.md", "---\non: locales/en.json\nmay-change: locales/*.json\n---\nTranslate.").job;
const docs = parseJobFile(".mergelight/jobs/docs.md", "---\non: src\nmay-change: docs\n---\nWrite docs.").job;
const b64 = (text) => Buffer.from(text).toString("base64");

function result(changes, outcomes) {
  return {
    head: HEAD,
    problems: [],
    outcomes: outcomes ?? [{ name: "translations", source: ".mergelight/jobs/translations.md", status: "changed", files: changes.map((c) => c.path), summary: "Added 3 keys." }],
    changes,
  };
}
const modes = (entries) => new Map(Object.entries(entries));

test("a jobs result that the base branch's jobs allow is pushed as written", () => {
  const plan = checkPush(result([{ path: "locales/da.json", contents: b64("{}\n") }, { path: "locales/old.json", deleted: true }]), [translations], HEAD, modes({ "locales/da.json": "100644", "locales/old.json": "100644" }));
  assert.deepEqual(plan.additions.map((a) => [a.path, a.bytes.toString()]), [["locales/da.json", "{}\n"]]);
  assert.deepEqual(plan.deletions, ["locales/old.json"]);
  assert.deepEqual(plan.jobs, [{ name: "translations", summary: "Added 3 keys." }]);
});

test("nothing in the result file is trusted: each change is checked again", () => {
  const why = (r, m = { "locales/da.json": "100644" }, jobs = [translations]) => checkPush(r, jobs, HEAD, modes(m)).why;
  const one = (change) => result([change]);
  assert.match(why({ ...one({ path: "locales/da.json", contents: b64("x") }), head: "b".repeat(40) }), /the branch is at aaaaaaa now/);
  assert.match(why(null), /can't be read/);
  // A job may only change its own paths, and the job must be on the base branch.
  assert.match(why(one({ path: ".github/workflows/ci.yml", contents: b64("x") }), { ".github/workflows/ci.yml": "100644" }), /may not change \.github\/workflows\/ci\.yml/);
  assert.match(why(one({ path: "README.md", contents: b64("x") }), { "README.md": "100644" }), /may not change README\.md/);
  assert.match(why(one({ path: "locales/da.json", contents: b64("x") }), undefined, [docs]), /The job "translations" isn't on the base branch/);
  assert.match(why(result([{ path: "locales/da.json", contents: b64("x") }], [])), /No job says it changed locales\/da\.json/);
  // Paths must be plain, and each changes once.
  for (const path of ["../x.json", "/etc/passwd", "locales//da.json", "locales/./da.json", "locales/da.json\n", ""]) assert.match(why(one({ path, contents: b64("x") }), { [path]: "100644" }), /isn't a plain path/, JSON.stringify(path));
  assert.match(why(result([{ path: "locales/da.json", contents: b64("x") }, { path: "locales/da.json", deleted: true }])), /changed twice/);
  // Only ordinary files, and only text.
  assert.match(why(one({ path: "locales/da.json", contents: b64("x") }), { "locales/da.json": "120000" }), /isn't an ordinary file at the head \(mode 120000\)/);
  assert.match(why(one({ path: "locales/da.json", contents: b64("x") }), { "locales/da.json": "100755" }), /mode 100755/);
  assert.match(why(one({ path: "locales/da.json", contents: Buffer.from([1, 0, 2]).toString("base64") })), /would be a binary file/);
  assert.match(why(one({ path: "locales/da.json", contents: "not base64!" })), /can't be read/);
  assert.match(why(one({ path: "locales/da.json", deleted: true }), { "locales/da.json": null }), /the head has no such file/);
  assert.match(why(one({ path: "locales/da.json", contents: b64("x") }), {}), /wasn't looked up/);
});

test("the push refuses a change in any skill folder", () => {
  const r = result([{ path: "locales/skill/notes.md", contents: b64("x") }]);
  assert.match(checkPush(r, [translations], HEAD, modes({ "locales/skill/notes.md": "100644" }), ["locales/skill"]).why, /may not change locales\/skill\/notes\.md/);
});

test("the push never writes through a folder that is a link at the head", () => {
  const anything = parseJobFile(".mergelight/jobs/anything.md", '---\non: src\nmay-change: "**"\n---\nTask.').job;
  const r = result([{ path: "locales/ci/release.yml", contents: b64("x") }], [{ name: "anything", source: "", status: "changed", files: ["locales/ci/release.yml"], summary: "x" }]);
  assert.match(checkPush(r, [anything], HEAD, modes({ "locales/ci/release.yml": null, locales: null, "locales/ci": "120000" })).why, /locales\/ci\/release\.yml is inside locales\/ci, which is a link at the head/);
});

test("the limits hold in the push too", () => {
  const many = Array.from({ length: 101 }, (_, i) => ({ path: `locales/${i}.json`, contents: b64("{}") }));
  assert.match(checkPush(result(many), [translations], HEAD, modes({})).why, /101 files, over the limit of 100/);
  const big = [{ path: "locales/a.json", contents: b64("x".repeat(600_000)) }, { path: "locales/b.json", contents: b64("y".repeat(600_000)) }];
  assert.match(checkPush(result(big), [translations], HEAD, modes({ "locales/a.json": null, "locales/b.json": null })).why, /more than 1000 KB/);
});

test("the commit says what each job did, and ends with the line that keeps jobs off their own commit", () => {
  const one = commitMessage({ additions: [], deletions: [], jobs: [{ name: "translations", summary: "Added 3 keys." }] });
  assert.deepEqual(one, { headline: "Run the job translations", body: "- translations: Added 3 keys.\n\nMergelight-Jobs: translations" });
  const two = commitMessage({ additions: [], deletions: [], jobs: [{ name: "translations", summary: "Mergelight-Jobs: fake" }, { name: "docs", summary: "Wrote a page." }] });
  assert.equal(two.headline, "Run the jobs translations and docs");
  assert.equal(two.body, "- translations:  fake\n- docs: Wrote a page.\n\nMergelight-Jobs: translations, docs");
});

test("the push keeps UTF-16 text with its byte-order mark, as the jobs step does, and refuses other zero bytes", () => {
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('"hello" = "Hej";\n', "utf16le")]);
  const plan = checkPush(result([{ path: "locales/da.json", contents: utf16.toString("base64") }]), [translations], HEAD, modes({ "locales/da.json": "100644" }));
  assert.deepEqual(plan.additions.map((a) => a.path), ["locales/da.json"]);
  const binary = checkPush(result([{ path: "locales/da.json", contents: Buffer.from([0x50, 0x4b, 0x00, 0x01]).toString("base64") }]), [translations], HEAD, modes({ "locales/da.json": "100644" }));
  assert.match(binary.why, /would be a binary file/);
});

test("a job's summary is cut by characters in the commit, never in the middle of an emoji, and keys are taken out", () => {
  const long = `${"a".repeat(299)}🎉 and more`;
  const plan = checkPush(result([{ path: "locales/da.json", contents: b64("{}\n") }], [{ name: "translations", source: ".mergelight/jobs/translations.md", status: "changed", files: ["locales/da.json"], summary: long }]), [translations], HEAD, modes({ "locales/da.json": "100644" }));
  assert.equal(plan.jobs[0].summary, `${"a".repeat(299)}🎉`);
  const key = `ghp_${"A".repeat(36)}`;
  const scrubbed = checkPush(result([{ path: "locales/da.json", contents: b64("{}\n") }], [{ name: "translations", source: ".mergelight/jobs/translations.md", status: "changed", files: ["locales/da.json"], summary: `Used ${key}.` }]), [translations], HEAD, modes({ "locales/da.json": "100644" }));
  assert.doesNotMatch(scrubbed.jobs[0].summary, /ghp_/);
});

test("the push refuses a write that clashes with a file, a submodule or a folder at the head", () => {
  const all = parseJobFile(".mergelight/jobs/all.md", '---\non: src\nmay-change: "**"\n---\nTask.').job;
  const why = (path, m) => checkPush(result([{ path, contents: b64("x\n") }], [{ name: "all", source: ".mergelight/jobs/all.md", status: "changed", files: [path], summary: "" }]), [all], HEAD, modes(m)).why;
  assert.match(why("docs/a.md/x.md", { docs: "040000", "docs/a.md": "100644", "docs/a.md/x.md": null }), /inside docs\/a\.md, which isn't a folder at the head/);
  assert.match(why("vendor/lib/x.md", { vendor: "040000", "vendor/lib": "160000", "vendor/lib/x.md": null }), /inside vendor\/lib, which isn't a folder at the head/);
  assert.match(why("docs", { docs: "040000" }), /isn't an ordinary file at the head \(mode 040000\)/);
  assert.equal(why("docs/new.md", { docs: "040000", "docs/new.md": null }), undefined);
});
