// Runs the Mergelight server as a plain Node process.
//
// Required environment:
//   DATABASE_URL   A Postgres address. The role must not be a superuser, or the row rules don't hold.
//   PUBLIC_URL     The address workflows reach this server at, like https://data.example.com.
//                  Tokens must be made for exactly this address, so one made for another server is refused.
//   PORT           Port to listen on. The host sets it.
// Optional:
//   DASHBOARD_ORIGINS  Sites whose pages may show the dashboard, with commas between them.
//                  Default: https://mergelight.dev
//   SIGN_IN_APP    The GitHub Apps people sign in to the dashboard with, by the name in their address,
//                  split by commas. Default: mergelight-ai,mergelight-setup
//   CONNECT_ORGS   Orgs to turn the dashboard on for at start, as "id:login,id:login" with GitHub's
//                  number for each account. A free grant from the operator: the dashboard stays on for
//                  them whatever they pay (plan.ts).
//   JOBS_ORGS      Orgs the operator gives Jobs for free, as "id,id" with GitHub's number for each
//                  account. Other orgs get Jobs with a working Pro plan (plan.ts). A run of the team's
//                  jobs asks first, and runs none without one of the two. Taking an org out takes its
//                  free Jobs away at the next start.
//   PADDLE_ENV, PADDLE_API_KEY, PADDLE_WEBHOOK_SECRET, PADDLE_CLIENT_TOKEN, PADDLE_PRICE_LIGHT, PADDLE_PRICE_PRO
//                  Payments through Paddle (billing.ts): all six, or none for a server that sells
//                  nothing. PADDLE_ENV is "sandbox" or "live". Paddle sends its messages to
//                  <PUBLIC_URL>/v1/billing/paddle.
//
// This server holds no GitHub key. The app's private key stays on the token server.

import { createServer, type IncomingMessage, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { createApi, MAX_BODY } from "./api.js";
import { parsePaddleConfig } from "./billing.js";
import { assertRowRulesHold, connectOrg, createPool, migrate, parseConnectOrgs, parseJobsOrgs, purgeExpiredMemories } from "./db.js";
import { parseOrigins } from "./people.js";

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Only the method, path, body and these headers matter, so nothing else from the request is passed on. */
export function createDataServer(api: (request: Request) => Promise<Response>): Server {
  const server = createServer(async (req, res) => {
    try {
      const headers: Record<string, string> = {};
      // paddle-signature: Paddle signs each payment message, and the signature comes in this header.
      for (const name of ["authorization", "content-type", "origin", "paddle-signature"] as const) {
        const value = req.headers[name];
        // Node gives a list only for set-cookie, which none of these is.
        if (typeof value === "string" && value) headers[name] = value;
      }
      // A DELETE can carry a body too: deleting an org's data sends its name to confirm.
      const body = req.method === "POST" || req.method === "DELETE" ? await readBody(req) : undefined;
      const request = new Request(new URL(req.url ?? "/", "http://mergelight-server"), { method: req.method, headers, body: body?.length ? new Uint8Array(body) : undefined });
      const response = await api(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
    } catch (err) {
      console.error("server error", (err as Error | null)?.name);
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad_request" }));
    }
  });
  server.requestTimeout = 30_000;
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { DATABASE_URL, PUBLIC_URL } = process.env;
  if (!DATABASE_URL || !PUBLIC_URL) {
    console.error(`${DATABASE_URL ? "PUBLIC_URL" : "DATABASE_URL"} isn't set.`);
    process.exit(1);
  }
  const pool = createPool(DATABASE_URL);
  let api: (request: Request) => Promise<Response>;
  try {
    const orgs = parseConnectOrgs(process.env.CONNECT_ORGS);
    const paddle = parsePaddleConfig(process.env);
    api = createApi({ pool, publicUrl: PUBLIC_URL, origins: parseOrigins(process.env.DASHBOARD_ORIGINS), signInApp: process.env.SIGN_IN_APP || undefined, jobsOrgs: parseJobsOrgs(process.env.JOBS_ORGS), keptOn: new Set(orgs.map((o) => o.id)), paddle });
    await assertRowRulesHold(pool);
    await migrate(pool);
    for (const org of orgs) await connectOrg(pool, org.id, org.login);
    if (orgs.length) console.log(`The dashboard is on for: ${orgs.map((o) => o.login).join(", ")}`);
    console.log(paddle ? `Payments: Paddle ${paddle.env}` : "Payments: off");
  } catch (err) {
    console.error(`Can't start: ${(err as Error).message}`);
    process.exit(1);
  }
  // What nobody needed for 90 days is dropped on a clock, so it goes even from a repository that stopped being reviewed.
  const purge = () => void purgeExpiredMemories(pool).catch((err) => console.error("purge error", (err as { code?: string } | null)?.code ?? (err as Error | null)?.name));
  purge();
  setInterval(purge, 6 * 60 * 60_000).unref();
  const server = createDataServer(api);
  server.listen(process.env.PORT ? Number(process.env.PORT) : 10001, "0.0.0.0", () => console.log("Mergelight server listening"));
  // Finish requests in flight when the host restarts it for a deploy.
  process.on("SIGTERM", () => server.close(() => void pool.end().then(() => process.exit(0))));
}
