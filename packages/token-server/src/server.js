// Runs the token server as a plain Node process.
//
// Required environment:
//   GITHUB_APP_CLIENT_ID     The Mergelight AI app's client id. Public.
//   GITHUB_APP_PRIVATE_KEY   The app's private key, in PEM. Keep it in the host's secret settings.
//   GITHUB_APP_CLIENT_SECRET The app's client secret, for "Sign in with GitHub" on the setup page.
//                            Optional: without it, only sign-in is off.
//   PORT                     Port to listen on. Render sets it.

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { handle } from "./token.js";

/** A sign-in code fits easily in this, and anything larger isn't one. */
const MAX_BODY = 4096;

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Only the method, path, body and these headers matter, so nothing else from the request is passed on. */
export function createTokenServer(env, fetchImpl = fetch) {
  const server = createServer(async (req, res) => {
    try {
      const headers = {};
      for (const name of ["authorization", "origin", "content-type"]) {
        if (req.headers[name]) headers[name] = req.headers[name];
      }
      const hasBody = req.method === "POST";
      const body = hasBody ? await readBody(req) : undefined;
      const request = new Request(new URL(req.url ?? "/", "http://token-server"), { method: req.method, headers, body: body?.length ? body : undefined });
      const response = await handle(request, env, fetchImpl);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
    } catch (err) {
      console.error("token server error", err?.name);
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad_request" }));
    }
  });
  server.requestTimeout = 30_000;
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const name of ["GITHUB_APP_CLIENT_ID", "GITHUB_APP_PRIVATE_KEY"]) {
    if (!process.env[name]) {
      console.error(`${name} isn't set.`);
      process.exit(1);
    }
  }
  const server = createTokenServer(process.env);
  server.listen(Number(process.env.PORT) || 10000, "0.0.0.0", () => console.log("Token server listening"));
  // Finish requests in flight when the host restarts it for a deploy.
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
}
