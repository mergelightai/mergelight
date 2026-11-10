// The review program and the server, talking over real HTTP, with a real database behind it.
// Only GitHub is faked: it hands out the OIDC tokens and serves the keys that sign them.
//
// It imports the built CLI, so build packages/mergelight first (npm test there does).

import assert from "node:assert/strict";
import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { resetJwksCache } from "../../token-server/dist/token.js";
import { createApi } from "../dist/api.js";
import { connectOrg, createPool, migrate, withOrg } from "../dist/db.js";
import { createDataServer } from "../dist/server.js";
import { startPostgres } from "./postgres.mjs";

const { cloudConnected, reportReview } = await import("../../mergelight/dist/cloud.js").catch(() => {
  throw new Error("Build the CLI first: npm test in packages/mergelight.");
});

const KID = "e2e-kid";
const oidc = generateKeyPairSync("rsa", { modulusLength: 2048 });
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** What GitHub does when a run asks for a token: sign who the run is, for the audience it asked for. */
function githubSigns(audience) {
  const head = b64({ alg: "RS256", kid: KID });
  const seconds = Math.floor(Date.now() / 1000);
  const body = b64({
    iss: "https://token.actions.githubusercontent.com",
    aud: audience,
    exp: seconds + 300,
    nbf: seconds - 10,
    jti: randomUUID(),
    repository: "acme/widgets",
    repository_id: "501",
    repository_owner: "acme",
    repository_owner_id: "1001",
    run_id: "9001",
    run_attempt: "1",
    event_name: "pull_request",
  });
  const signer = createSign("RSA-SHA256");
  signer.update(`${head}.${body}`);
  return `${head}.${body}.${signer.sign(oidc.privateKey).toString("base64url")}`;
}

const review = {
  pr: { owner: "acme", repo: "widgets", number: 42, title: "t", url: "u", base_sha: "b".repeat(40), head_sha: "a".repeat(40) },
  provider: { name: "codex", model: "gpt-5.5-codex", effort: "high" },
  light: "red",
  summary: "s",
  findings: [
    { class: "bug", tier: "post", severity: "major" },
    { class: "risk", tier: "decision", severity: "minor" },
  ],
  stats: { duration_ms: 300_000, diff_chars: 100, files_changed: 3, additions: 40, deletions: 2 },
};

let postgres;
let pool;
let server;
let deps;

before(async () => {
  resetJwksCache();
  postgres = await startPostgres();
  pool = createPool(postgres.url);
  await migrate(pool);
  const jwks = async () => new Response(JSON.stringify({ keys: [{ ...oidc.publicKey.export({ format: "jwk" }), kid: KID }] }), { status: 200 });
  // The server's own address is part of what it checks, and the port is only known once it listens.
  let api;
  server = createDataServer((request) => api(request));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  api = createApi({ pool, publicUrl: `http://127.0.0.1:${server.address().port}`, fetchImpl: jwks });

  deps = {
    env: {
      MERGELIGHT_SERVER: `http://127.0.0.1:${server.address().port}`,
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://actions.test/idtoken",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
    },
    // GitHub's token endpoint is the fake. Everything else is a real request to the real server.
    fetchImpl: async (url, init) => {
      const u = new URL(url);
      if (u.host === "actions.test") return new Response(JSON.stringify({ value: githubSigns(u.searchParams.get("audience")) }), { status: 200 });
      return fetch(url, init);
    },
    log: (line) => deps.lines.push(line),
    mask: () => {},
    lines: [],
  };
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
  await postgres.stop();
});

test("before the org turns the dashboard on: not connected, and a report is refused and stored nowhere", async () => {
  assert.equal(await cloudConnected(deps), false);
  assert.equal(await reportReview(review, deps), false);
  assert.match(deps.lines.at(-1), /answered 404/);
});

test("after it does: connected, and the review's numbers land in the org's rows", async () => {
  await connectOrg(pool, 1001, "acme");
  assert.equal(await cloudConnected(deps), true);
  assert.equal(await reportReview(review, deps), true);

  const rows = await withOrg(pool, 1001, async (db) => (await db.query("select r.name, v.pr, v.light, v.bugs, v.risks, v.major, v.tier_post, v.tier_decision, v.provider, v.model, v.verifier from reviews v join repos r on r.org_id = v.org_id and r.id = v.repo_id")).rows);
  assert.deepEqual(rows, [{ name: "acme/widgets", pr: 42, light: "red", bugs: 1, risks: 1, major: 1, tier_post: 1, tier_decision: 1, provider: "codex", model: "gpt-5.5-codex", verifier: null }]);
});
