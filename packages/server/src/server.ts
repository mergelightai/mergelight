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
//   SIGN_IN_APP    The GitHub App people sign in to the dashboard with, by its name in its address.
//                  Default: mergelight-setup
//   CONNECT_ORGS   Orgs to turn the dashboard on for at start, as "id:login,id:login" with GitHub's
//                  number for each account. It stands in until sign-in exists.
//
// This server holds no GitHub key. The app's private key stays on the token server.

import { createServer, type IncomingMessage, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { createApi, MAX_BODY } from "./api.js";
import { assertRowRulesHold, connectOrg, createPool, migrate, parseConnectOrgs } from "./db.js";
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
      for (const name of ["authorization", "content-type", "origin"] as const) {
        const value = req.headers[name];
        if (value) headers[name] = value;
      }
      const body = req.method === "POST" ? await readBody(req) : undefined;
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
    api = createApi({ pool, publicUrl: PUBLIC_URL, origins: parseOrigins(process.env.DASHBOARD_ORIGINS), signInApp: process.env.SIGN_IN_APP || undefined });
    const orgs = parseConnectOrgs(process.env.CONNECT_ORGS);
    await assertRowRulesHold(pool);
    await migrate(pool);
    for (const org of orgs) await connectOrg(pool, org.id, org.login);
    if (orgs.length) console.log(`The dashboard is on for: ${orgs.map((o) => o.login).join(", ")}`);
  } catch (err) {
    console.error(`Can't start: ${(err as Error).message}`);
    process.exit(1);
  }
  const server = createDataServer(api);
  server.listen(process.env.PORT ? Number(process.env.PORT) : 10001, "0.0.0.0", () => console.log("Mergelight server listening"));
  // Finish requests in flight when the host restarts it for a deploy.
  process.on("SIGTERM", () => server.close(() => void pool.end().then(() => process.exit(0))));
}
