import assert from "node:assert/strict";
import { test } from "node:test";
import { summaryBody } from "../dist/publish/markdown.js";
import { isNewer, newerVersion } from "../dist/update.js";

test("compares versions as numbers", () => {
  assert.equal(isNewer("v0.2.0", "0.1.0"), true);
  assert.equal(isNewer("v0.10.0", "0.9.0"), true, "not as text");
  assert.equal(isNewer("v1.0.0", "0.9.9"), true);
  assert.equal(isNewer("v0.1.0", "0.1.0"), false);
  assert.equal(isNewer("v0.1.0", "0.2.0"), false);
});

const latest = (tag) => ({ get: async () => ({ tag_name: tag }) });

test("only speaks up when there's something newer", async () => {
  assert.equal(await newerVersion(latest("v0.2.0"), "0.1.0"), "v0.2.0");
  assert.equal(await newerVersion(latest("v0.1.0"), "0.1.0"), null);
});

test("a failed lookup never gets in the way of a review", async () => {
  assert.equal(await newerVersion({ get: async () => { throw new Error("rate limited"); } }, "0.1.0"), null);
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

test("the summary only mentions an update when there is one", () => {
  assert.doesNotMatch(summaryBody(input), /Update it/);
  const body = summaryBody({ ...input, update: "v0.2.0" });
  assert.match(body, /Mergelight v0\.2\.0 is out\..*Update it/);
  assert.match(body, /mergelight\.dev\/setup/);
});
