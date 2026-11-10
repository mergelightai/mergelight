// A real Postgres for the tests. The row rules are the database's own work, so a stand-in can't test them.
//
// With TEST_DATABASE_URL (a superuser address, as in CI) it uses that server. Without it, it starts a
// throwaway one in Docker and removes it afterwards.
//
// Either way the tests sign in as a plain role that owns the database, like the hosted server does.
// A superuser would skip the row rules, and the tests would pass without proving anything.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import pg from "pg";

const IMAGE = "postgres:17-alpine";

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function startInDocker() {
  const port = await freePort();
  const password = randomBytes(12).toString("hex");
  const name = `mergelight-test-${randomBytes(4).toString("hex")}`;
  try {
    execFileSync("docker", ["run", "--rm", "-d", "--name", name, "-e", `POSTGRES_PASSWORD=${password}`, "-p", `127.0.0.1:${port}:5432`, IMAGE], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (err) {
    throw new Error(`The tests need Postgres. Start Docker, or set TEST_DATABASE_URL to a superuser address. (${String(err.stderr ?? err.message).trim().split("\n").pop()})`);
  }
  const url = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;
  const stop = () => {
    try {
      execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    } catch {}
  };
  // The image starts Postgres once to set itself up, then again for real, so one good answer isn't enough.
  let good = 0;
  for (let i = 0; i < 120 && good < 3; i++) {
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
    client.on("error", () => {});
    try {
      await client.connect();
      await client.query("select 1");
      good++;
    } catch {
      good = 0;
    } finally {
      await client.end().catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (good < 3) {
    stop();
    throw new Error("Postgres in Docker didn't start in time.");
  }
  return { url, stop };
}

export async function startPostgres() {
  let adminUrl = process.env.TEST_DATABASE_URL;
  let stopCluster = () => {};
  if (!adminUrl) {
    const docker = await startInDocker();
    adminUrl = docker.url;
    stopCluster = docker.stop;
  }

  const suffix = randomBytes(6).toString("hex");
  const role = `mergelight_app_${suffix}`;
  const database = `mergelight_test_${suffix}`;
  const password = randomBytes(12).toString("hex");
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create role ${role} login password '${password}'`);
  await admin.query(`create database ${database} owner ${role}`);

  const at = new URL(adminUrl);
  at.username = role;
  at.password = password;
  at.pathname = `/${database}`;

  return {
    url: at.toString(),
    adminUrl,
    async stop() {
      await admin.query(`drop database if exists ${database} with (force)`).catch(() => {});
      await admin.query(`drop role if exists ${role}`).catch(() => {});
      await admin.end();
      stopCluster();
    },
  };
}
