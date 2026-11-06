// Runs the token server as a plain Node process.
//
// Required environment:
//   GITHUB_APP_CLIENT_ID     The Mergelight AI app's client id. Public.
//   GITHUB_APP_PRIVATE_KEY   The app's private key, in PEM. Keep it in the host's secret settings.
//   PORT                     Port to listen on. Render sets it.

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { handle } from "./token.js";

/** Only the method, path and Authorization header matter, so nothing else from the request is passed on. */
export function createTokenServer(env, fetchImpl = fetch) {
  const server = createServer(async (req, res) => {
    req.resume();
    try {
      const headers = req.headers.authorization ? { authorization: req.headers.authorization } : {};
      const request = new Request(new URL(req.url ?? "/", "http://token-server"), { method: req.method, headers });
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
