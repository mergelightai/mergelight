import assert from "node:assert/strict";
import { test } from "node:test";
import { summaryBody } from "../dist/publish/markdown.js";
import { isNewer, newerVersion, releaseNews } from "../dist/update.js";

test("compares versions as numbers", () => {
  assert.equal(isNewer("v0.2.0", "0.1.0"), true);
  assert.equal(isNewer("v0.10.0", "0.9.0"), true, "not as text");
  assert.equal(isNewer("v1.0.0", "0.9.9"), true);
  assert.equal(isNewer("v0.1.0", "0.1.0"), false);
  assert.equal(isNewer("v0.1.0", "0.2.0"), false);
});

const notes = (...titles) => titles.map((title, i) => `* ${title} by @steelzeh in https://github.com/mergelightai/mergelight/pull/${i}`).join("\n");
const release = (tag, body = "", over = {}) => ({ tag_name: tag, body, draft: false, prerelease: false, ...over });
const latest = (tag, body) => ({ get: async () => [release(tag, body)] });

const PINNED = "a".repeat(40);

test("a moving tag gets each release by itself, so only a pinned commit hears about one", async () => {
  assert.equal(await newerVersion(latest("v0.2.0"), "0.1.0", "v0"), null);
  assert.equal(await newerVersion(latest("v0.2.0"), "0.1.0", "my-branch"), null);
  assert.equal(await newerVersion(latest("v0.2.0"), "0.1.0", ""), null);
});

test("only speaks up when there's something newer", async () => {
  assert.deepEqual(await newerVersion(latest("v0.2.0"), "0.1.0", PINNED), { tag: "v0.2.0", current: "v0.1.0", news: [] });
  assert.equal(await newerVersion(latest("v0.1.0"), "0.1.0", PINNED), null);
});

test("a failed lookup never gets in the way of a review", async () => {
  assert.equal(await newerVersion({ get: async () => { throw new Error("rate limited"); } }, "0.1.0", PINNED), null);
});

const review = {
  pr: { head_sha: "abcdef1234" },
  summary: "Looks fine.",
  light: "green",
  findings: [],
  provider: { name: "codex", model: null },
  verifier: null,
  stats: { duration_ms: 1000 },
};
const input = { review, state: { v: 1, round: 1, findings: [] }, urls: new Map() };

test("collects the news from every release since this one, newest first, without version bumps or drafts", async () => {
  const api = { get: async () => [
    release("v0.3.0", notes("Newest thing", "Release v0.3.0")),
    release("v0.4.0", "", { draft: true }),
    release("v0.5.0-rc", notes("Not out yet"), { prerelease: true }),
    release("v0.2.0", notes("Older thing")),
    release("v0.1.0", notes("Already have this")),
  ] };
  assert.deepEqual(await newerVersion(api, "0.1.0", PINNED), { tag: "v0.3.0", current: "v0.1.0", news: ["Newest thing", "Older thing"] });
});

test("reads only the change lines of release notes", () => {
  assert.deepEqual(releaseNews("To pin:\n\n## What's Changed\n" + notes("A change", "Release v1.0.0") + "\n\n**Full Changelog**: https://x"), ["A change"]);
});

test("the update banner is the first thing in the comment, and says what's new", () => {
  assert.doesNotMatch(summaryBody(input), /missing out/);
  const body = summaryBody({ ...input, update: { tag: "v0.2.0", current: "v0.1.0", news: ["Approves green reviews"] } }, false);
  assert.ok(body.indexOf("[!IMPORTANT]") < body.indexOf("### "), body);
  assert.match(body, /You're missing out: Mergelight v0\.2\.0 is out, and this repo is on v0\.1\.0\./);
  assert.match(body, /> - Approves green reviews/);
  assert.match(body, /\[Update now\]\(https:\/\/mergelight\.dev\/setup\/\)/);
});

test("a long list is cut short, and no news still shows the banner", () => {
  const body = summaryBody({ ...input, update: { tag: "v0.2.0", current: "v0.1.0", news: ["1", "2", "3", "4", "5", "6"] } }, false);
  assert.match(body, /> - 4\n> - and 2 more/);
  const plain = summaryBody({ ...input, update: { tag: "v0.2.0", current: "v0.1.0", news: [] } }, false);
  assert.match(plain, /missing out/);
  assert.doesNotMatch(plain, /> - /);
});
