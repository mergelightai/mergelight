import assert from "node:assert/strict";
import { test } from "node:test";
import { headline } from "../dist/publish/markdown.js";
import { approveCheck } from "../dist/publish/publish.js";

/** A pull request with a yellow Mergelight check, and who may push to the repository. */
function fakeApi({ canPush = ["ada"], check = { id: 9, conclusion: "neutral", output: { title: "🟡 Needs a human: Changes a file that always needs a human", summary: "..." } } } = {}) {
  const writes = [];
  return {
    writes,
    get: async (path) => {
      if (path === "pulls/7") return { head: { sha: "a".repeat(40) } };
      if (path.startsWith(`commits/${"a".repeat(40)}/check-runs`)) return { check_runs: check ? [check] : [] };
      const login = /^collaborators\/([^/]+)\/permission$/.exec(path)?.[1];
      if (login) return { permission: canPush.includes(decodeURIComponent(login)) ? "write" : "read" };
      throw new Error(`unexpected GET ${path}`);
    },
    write: async (method, path, body) => {
      writes.push({ method, path, body });
      return {};
    },
  };
}

test("an approval turns a 'needs a human' check green only when it comes from someone who can push", async () => {
  const api = fakeApi();
  const refused = await approveCheck(api, 7, "passer-by");
  assert.match(refused, /passer-by can't push to this repository/);
  assert.deepEqual(api.writes, []);

  const ok = await approveCheck(api, 7, "ada");
  assert.match(ok, /approved by ada/);
  assert.equal(api.writes.length, 1);
  assert.equal(api.writes[0].body.conclusion, "success");
});

test("an approval of an earlier commit doesn't turn the newest one green", async () => {
  const api = fakeApi();
  const stale = await approveCheck(api, 7, "ada", "b".repeat(40));
  assert.match(stale, /approved an earlier commit/);
  assert.deepEqual(api.writes, []);
  assert.match(await approveCheck(api, 7, "ada", "a".repeat(40)), /approved by ada/);
  assert.equal(api.writes.length, 1);
});

test("when GitHub can't say whether someone can push, their approval doesn't count", async () => {
  const api = fakeApi();
  api.get = async (path) => {
    if (path === "pulls/7") return { head: { sha: "a".repeat(40) } };
    if (path.includes("/check-runs")) return { check_runs: [{ id: 9, conclusion: "neutral", output: { title: "🟡 Needs a human: 1 for you to decide", summary: "" } }] };
    throw new Error("GitHub is down");
  };
  assert.match(await approveCheck(api, 7, "ada"), /can't push/);
  assert.deepEqual(api.writes, []);
});

const review = (over = {}) => ({ findings: [], ...over });

test("the check's headline says why a guarded pull request needs a human", () => {
  assert.equal(headline(review()), "Nothing worth fixing");
  assert.equal(headline(review({ needs_human: ["src/billing/tax.ts"] })), "Changes a file that always needs a human");
  assert.equal(headline(review({ needs_human: [] })), "Nothing worth fixing");
  // With something to fix, that comes first, as before.
  const bug = { tier: "post", class: "bug", severity: "major" };
  assert.equal(headline(review({ findings: [bug], needs_human: ["a.sql"] })), "1 bug to fix");
});

test("an approval of a blocked review says it doesn't clear it, though both end neutral", async () => {
  const api = fakeApi({ check: { id: 9, conclusion: "neutral", output: { title: "🔴 Blocked: 1 bug to fix", summary: "..." } } });
  assert.match(await approveCheck(api, 7, "ada"), /blocked\. An approval doesn't clear it/);
  assert.deepEqual(api.writes, []);
});

test("the Reviewing comment gets the models' names, and a comment with a result is left alone", async () => {
  const { updatePendingSummary } = await import("../dist/publish/publish.js");
  const { pendingSummaryBody } = await import("../dist/publish/markdown.js");
  const writes = [];
  const { encodeState, nextState } = await import("../dist/publish/state.js");
  const earlier = encodeState(nextState(null, [], "a".repeat(40), "green", new Map()));
  const bodies = { 5: pendingSummaryBody(), 7: "<!-- mergelight:summary -->\n### 🟢 Mergelight: Safe to merge", 8: `${pendingSummaryBody()}\n${earlier}` };
  const api = { get: async (path) => ({ id: Number(path.split("/").pop()), body: bodies[path.split("/").pop()] }), write: async (method, path, body) => (writes.push({ method, path, body }), {}) };
  const plan = { reviewer: { name: "codex", model: "gpt-6-astra" }, checker: { name: "claude", model: "claude-opus-5-5" } };
  await updatePendingSummary(api, { id: 5, body: pendingSummaryBody() }, plan);
  // Another run finished since this one began: its result stays.
  await updatePendingSummary(api, { id: 7, body: pendingSummaryBody() }, plan);
  assert.equal(writes[0].path, "issues/comments/5");
  assert.match(writes[0].body.body, /Reviewing with Codex GPT-6-Astra, and Claude Opus 5\.5 checks the findings/);
  await updatePendingSummary(api, { id: 6, body: "<!-- mergelight:summary -->\n### 🟢 Mergelight: Safe to merge" }, plan);
  await updatePendingSummary(api, null, plan);
  assert.equal(writes.length, 1);
  // After a reconnect the Reviewing comment carries earlier rounds' state, and it stays.
  await updatePendingSummary(api, { id: 8, body: bodies[8] }, plan);
  assert.ok(writes[1].body.body.endsWith(earlier));
  assert.match(writes[1].body.body, /Reviewing with Codex GPT-6-Astra/);
});

test("the Reviewing check names the tool that reviews", async () => {
  const { startCheck } = await import("../dist/publish/publish.js");
  const writes = [];
  const api = { write: async (method, path, body) => (writes.push(body), { id: 1 }) };
  await startCheck(api, "a".repeat(40), "claude");
  await startCheck(api, "a".repeat(40), "codex");
  await startCheck(api, "a".repeat(40));
  assert.deepEqual(writes.map((w) => w.output.summary.split(" on your own plan")[0]), [
    "Mergelight is reviewing this pull request with Claude",
    "Mergelight is reviewing this pull request with Codex",
    "Mergelight is reviewing this pull request",
  ]);
});
