// The Mergelight token server. It holds the GitHub App's private key, so customers never need it.
//
// A workflow proves which repository it runs in with GitHub's OIDC token. The server checks that
// token, and if the Mergelight AI app is installed on that repository, returns a short-lived app
// token limited to that one repository. Comments and checks then carry the app's name and logo.
//
// It stores nothing, and never sees code or model logins.

const OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const OIDC_AUDIENCE = "mergelight";
const GITHUB_API = "https://api.github.com";
const INSTALL_URL = "https://github.com/apps/mergelight-ai/installations/new";

/** What a review needs. Nothing can push code. */
const PERMISSIONS = { checks: "write", pull_requests: "write", contents: "read" };

/** Only runs that review a pull request or approve its check get a token. */
const EVENTS = new Set(["pull_request", "pull_request_target", "pull_request_review"]);

const CLOCK_SKEW_S = 30;
const JWKS_TTL_MS = 60 * 60_000;
const JWKS_MIN_REFRESH_MS = 60_000;

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const utf8 = new TextEncoder();

function base64UrlToBytes(text) {
  const raw = atob(text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "="));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function bytesToBase64Url(bytes) {
  let raw = "";
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const jsonToBase64Url = (value) => bytesToBase64Url(utf8.encode(JSON.stringify(value)));

/** DER length: short form under 128, else a length-of-length byte. */
function derLength(n) {
  if (n < 128) return [n];
  const out = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
  return [0x80 | out.length, ...out];
}

/** GitHub issues PKCS#1 keys, and WebCrypto only imports PKCS#8. This wraps one in the other. */
function pkcs1ToPkcs8(pkcs1) {
  const version = [0x02, 0x01, 0x00];
  const rsaEncryption = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const key = [0x04, ...derLength(pkcs1.length), ...pkcs1];
  const body = [...version, ...rsaEncryption, ...key];
  return Uint8Array.from([0x30, ...derLength(body.length), ...body]);
}

function importAppKey(pem) {
  // A key pasted into a host's settings can arrive with its line breaks as literal \n.
  const match = pem.replace(/\\n/g, "\n").match(/-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END/);
  if (!match) throw new HttpError(500, "bad_key", "The server's private key isn't a PEM key.");
  const der = Uint8Array.from(atob(match[2].replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    match[1] ? pkcs1ToPkcs8(der) : der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/** Signs the short-lived JWT that identifies the app itself to GitHub. */
export async function createAppJwt(env, now = Date.now()) {
  const seconds = Math.floor(now / 1000);
  // GitHub allows at most 10 minutes. iat is set back to allow for clock drift.
  const signing = `${jsonToBase64Url({ alg: "RS256", typ: "JWT" })}.${jsonToBase64Url({
    iss: env.GITHUB_APP_CLIENT_ID,
    iat: seconds - 60,
    exp: seconds + 540,
  })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await importAppKey(env.GITHUB_APP_PRIVATE_KEY), utf8.encode(signing));
  return `${signing}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

let jwksCache = { keys: new Map(), fetchedAt: 0 };

/** For tests. */
export function resetJwksCache() {
  jwksCache = { keys: new Map(), fetchedAt: 0 };
}

async function signingKey(kid, fetchImpl, now) {
  const known = jwksCache.keys.get(kid);
  if (known && now - jwksCache.fetchedAt < JWKS_TTL_MS) return known;
  // An unknown kid can mean GitHub rotated its keys, but random kids must not make us refetch every time.
  if (now - jwksCache.fetchedAt >= JWKS_MIN_REFRESH_MS) {
    const res = await fetchImpl(`${OIDC_ISSUER}/.well-known/jwks`);
    if (!res.ok) throw new HttpError(502, "jwks_unavailable", "Couldn't read GitHub's signing keys.");
    const { keys } = await res.json();
    jwksCache = { keys: new Map(keys.filter((k) => k.kty === "RSA" && k.kid).map((k) => [k.kid, k])), fetchedAt: now };
  }
  return jwksCache.keys.get(kid);
}

/** Checks a GitHub Actions OIDC token and returns its claims. Throws a 401 otherwise. */
export async function verifyOidcToken(token, fetchImpl = fetch, now = Date.now()) {
  const invalid = (why) => new HttpError(401, "invalid_token", `GitHub's OIDC token was rejected: ${why}.`);
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3) throw invalid("it isn't a JWT");

  let header;
  let claims;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[1])));
  } catch {
    throw invalid("it can't be read");
  }
  // Fixed to RS256, so a token can't choose "none" or another algorithm.
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw invalid("wrong algorithm");

  const jwk = await signingKey(header.kid, fetchImpl, now);
  if (!jwk) throw invalid("unknown signing key");
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlToBytes(parts[2]),
    utf8.encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) throw invalid("bad signature");

  const seconds = Math.floor(now / 1000);
  if (claims.iss !== OIDC_ISSUER) throw invalid("wrong issuer");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(OIDC_AUDIENCE)) throw invalid("wrong audience");
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_S < seconds) throw invalid("it expired");
  if (typeof claims.nbf === "number" && claims.nbf - CLOCK_SKEW_S > seconds) throw invalid("it isn't valid yet");
  return claims;
}

async function callGitHub(fetchImpl, path, appJwt, init = {}) {
  return fetchImpl(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${appJwt}`,
      "user-agent": "mergelight-token-server",
      "x-github-api-version": "2022-11-28",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
}

/** Turns verified claims into an app token limited to the repository the run belongs to. */
export async function issueToken(claims, env, fetchImpl = fetch, now = Date.now()) {
  if (!EVENTS.has(claims.event_name)) {
    throw new HttpError(403, "event_not_allowed", `Runs triggered by ${claims.event_name} don't get a token.`);
  }
  const match = /^([\w.-]+)\/([\w.-]+)$/.exec(claims.repository ?? "");
  if (!match) throw new HttpError(401, "invalid_token", "GitHub's OIDC token names no repository.");
  const [, owner, repo] = match;

  const appJwt = await createAppJwt(env, now);
  const installation = await callGitHub(fetchImpl, `/repos/${owner}/${repo}/installation`, appJwt);
  if (installation.status === 404) {
    throw new HttpError(404, "not_installed", `The Mergelight AI app isn't installed on ${owner}/${repo}. Install it: ${INSTALL_URL}`);
  }
  if (!installation.ok) throw new HttpError(502, "github_error", `GitHub answered ${installation.status} looking up the app.`);
  const { id } = await installation.json();

  const res = await callGitHub(fetchImpl, `/app/installations/${id}/access_tokens`, appJwt, {
    method: "POST",
    body: JSON.stringify({ repositories: [repo], permissions: PERMISSIONS }),
  });
  if (res.status === 403 || res.status === 422) {
    throw new HttpError(403, "needs_approval", `The app's install on ${owner}/${repo} needs the updated permissions approved.`);
  }
  if (!res.ok) throw new HttpError(502, "github_error", `GitHub answered ${res.status} creating a token.`);
  const { token, expires_at } = await res.json();
  return { token, expires_at, repository: `${owner}/${repo}` };
}

function respond(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function handle(request, env, fetchImpl = fetch, now = Date.now()) {
  const { pathname } = new URL(request.url);
  if (request.method === "GET" && pathname === "/") return respond(200, { service: "mergelight-token-server" });
  if (pathname !== "/token") return respond(404, { error: "not_found" });
  if (request.method !== "POST") return respond(405, { error: "method_not_allowed" });

  try {
    const auth = request.headers.get("authorization") ?? "";
    if (!auth.startsWith("Bearer ")) throw new HttpError(401, "invalid_token", "Send GitHub's OIDC token as a Bearer token.");
    const claims = await verifyOidcToken(auth.slice("Bearer ".length), fetchImpl, now);
    return respond(200, await issueToken(claims, env, fetchImpl, now));
  } catch (err) {
    if (err instanceof HttpError) return respond(err.status, { error: err.code, message: err.message });
    // Never echo unexpected errors: they could carry key material.
    console.error("token server error", err?.name);
    return respond(500, { error: "server_error", message: "The token server hit an error." });
  }
}
