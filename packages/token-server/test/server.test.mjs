import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createTokenServer } from "../src/server.js";

const here = dirname(fileURLToPath(import.meta.url));
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

let server;
let base;

before(async () => {
  // No GitHub here: a real request must never leave the test.
  const fetchImpl = async () => new Response(JSON.stringify({ keys: [] }), { status: 200 });
  server = createTokenServer({ GITHUB_APP_CLIENT_ID: "Iv23-test", GITHUB_APP_PRIVATE_KEY: pem }, fetchImpl);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

test("answers the health check", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { service: "mergelight-token-server" });
});

test("passes the Authorization header on, and rejects a bad token", async () => {
  const res = await fetch(`${base}/token`, { method: "POST", headers: { authorization: "Bearer not-a-jwt" } });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal((await res.json()).error, "invalid_token");
});

test("a request without a token gets a 401", async () => {
  assert.equal((await fetch(`${base}/token`, { method: "POST" })).status, 401);
});

test("a request with a body works too", async () => {
  const res = await fetch(`${base}/token`, { method: "POST", body: "ignored" });
  assert.equal(res.status, 401);
});

test("other paths and methods are refused", async () => {
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  assert.equal((await fetch(`${base}/token`)).status, 405);
});

test("refuses to start without the private key", async () => {
  const child = spawn(process.execPath, [join(here, "..", "src", "server.js")], {
    env: { PATH: process.env.PATH, GITHUB_APP_CLIENT_ID: "x" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 1);
  assert.match(stderr, /GITHUB_APP_PRIVATE_KEY isn't set/);
});
