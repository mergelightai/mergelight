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
/** The Mergelight Setup app, which the setup page signs in with. It has no private key anywhere, so it only ever acts for a signed-in person. */
const SETUP_CLIENT_ID = "Iv23liSVH2xajWoG53R0";

/** The environment the server reads. Only the GitHub App settings matter here. */
export type Env = Record<string, string | undefined>;

/** What GitHub signed. exp is checked to be a number; every other claim is unchecked and must be tested before use. */
export type OidcClaims = { exp: number } & Record<string, unknown>;

/** One of GitHub's OIDC signing keys, as its key set lists it. */
interface Jwk {
  kty?: string;
  kid?: string;
  n?: string;
  e?: string;
}

/**
 * What each kind of token can do, and which runs can ask for it. Neither can push code.
 * review: posts comments and checks, for runs that review a pull request or approve its check.
 * login: saves a refreshed Codex login back to the repository's secret, so customers don't have to
 * create a personal token. Asked for only when the login changed. GitHub never lets it read a secret.
 */
const SCOPES = {
  review: {
    permissions: { checks: "write", pull_requests: "write", contents: "read" },
    events: new Set(["pull_request", "pull_request_target", "pull_request_review"]),
  },
  login: {
    permissions: { secrets: "write" },
    events: new Set(["pull_request", "pull_request_target", "schedule", "workflow_dispatch"]),
  },
} satisfies Record<string, { permissions: Record<string, string>; events: Set<string> }>;

type Scope = keyof typeof SCOPES;

/** The setup page, the only site allowed to sign in through this server. */
const SITE_ORIGIN = "https://mergelight.dev";

const CLOCK_SKEW_S = 30;
const JWKS_TTL_MS = 60 * 60_000;
const JWKS_MIN_REFRESH_MS = 60_000;
const JWKS_FETCH_TIMEOUT_MS = 10_000;
const JWKS_RETRY_AFTER_MS = 10_000;
/** How long a key we already hold stays good while GitHub can't be asked for a new list. */
const JWKS_MAX_STALE_MS = 24 * 60 * 60_000;

export class HttpError extends Error {
  declare status: number;
  declare code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const utf8 = new TextEncoder();

function base64UrlToBytes(text: string): Uint8Array<ArrayBuffer> {
  const raw = atob(text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "="));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let raw = "";
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const jsonToBase64Url = (value: unknown): string => bytesToBase64Url(utf8.encode(JSON.stringify(value)));

/** DER length: short form under 128, else a length-of-length byte. */
function derLength(n: number): number[] {
  if (n < 128) return [n];
  const out: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
  return [0x80 | out.length, ...out];
}

/** GitHub issues PKCS#1 keys, and WebCrypto only imports PKCS#8. This wraps one in the other. */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  const version = [0x02, 0x01, 0x00];
  const rsaEncryption = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const key = [0x04, ...derLength(pkcs1.length), ...pkcs1];
  const body = [...version, ...rsaEncryption, ...key];
  return Uint8Array.from([0x30, ...derLength(body.length), ...body]);
}

function importAppKey(pem: string | undefined): Promise<CryptoKey> {
  // A key pasted into a host's settings can arrive with its line breaks as literal \n.
  // The server refuses to start without a key, so pem is always set here.
  const match = pem!.replace(/\\n/g, "\n").match(/-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END/);
  if (!match) throw new HttpError(500, "bad_key", "The server's private key isn't a PEM key.");
  const der = Uint8Array.from(atob(match[2]!.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    match[1] ? pkcs1ToPkcs8(der) : der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/** Signs the short-lived JWT that identifies the app itself to GitHub. */
export async function createAppJwt(env: Env, now = Date.now()): Promise<string> {
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

let jwksCache: { keys: Map<string, Jwk>; fetchedAt: number } = { keys: new Map(), fetchedAt: 0 };
/** The refresh in flight, shared by every request that needs it. */
let jwksRefresh: Promise<void> | null = null;
let jwksFailedAt = -Infinity;

/** For tests. */
export function resetJwksCache(): void {
  jwksCache = { keys: new Map(), fetchedAt: 0 };
  jwksRefresh = null;
  jwksFailedAt = -Infinity;
}

async function refreshJwks(fetchImpl: typeof fetch, now: number): Promise<void> {
  // now is when the request came in. A fetch that runs into its deadline fails 10 seconds after that,
  // so the failure is stamped with the time it really happened. Otherwise the pause after it is over
  // before it starts.
  const started = Date.now();
  try {
    const res = await fetchImpl(`${OIDC_ISSUER}/.well-known/jwks`, { signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const { keys } = (await res.json()) as { keys: Jwk[] };
    jwksCache = { keys: new Map(keys.filter((k) => k.kty === "RSA" && k.kid).map((k): [string, Jwk] => [k.kid!, k])), fetchedAt: now };
  } catch {
    jwksFailedAt = now + (Date.now() - started);
    throw new HttpError(502, "jwks_unavailable", "Couldn't read GitHub's signing keys.");
  }
}

async function signingKey(kid: string, fetchImpl: typeof fetch, now: number): Promise<Jwk | undefined> {
  const known = jwksCache.keys.get(kid);
  if (known && now - jwksCache.fetchedAt < JWKS_TTL_MS) return known;
  // An unknown kid can mean GitHub rotated its keys, but random kids must not make us refetch every time.
  if (now - jwksCache.fetchedAt >= JWKS_MIN_REFRESH_MS) {
    // Anyone can send a token-shaped request, so these fetches must not pile up: requests that arrive
    // together share one, it has a deadline, and after a failure nobody tries again for a while.
    // A key this server already holds is used while GitHub can't be asked, so one failed fetch doesn't
    // turn every caller away. An unknown key never is: it waits for a list that names it.
    const held = known && now - jwksCache.fetchedAt < JWKS_MAX_STALE_MS ? known : null;
    if (now - jwksFailedAt < JWKS_RETRY_AFTER_MS) {
      if (held) return held;
      throw new HttpError(502, "jwks_unavailable", "Couldn't read GitHub's signing keys.");
    }
    jwksRefresh ??= refreshJwks(fetchImpl, now).finally(() => {
      jwksRefresh = null;
    });
    try {
      await jwksRefresh;
    } catch (err) {
      if (held) return held;
      throw err;
    }
  }
  return jwksCache.keys.get(kid);
}

/** Checks a GitHub Actions OIDC token and returns its claims. Throws a 401 otherwise. */
/**
 * audience: who the token was made for. A token for another Mergelight service is refused here, so
 * a service that takes these tokens can never use one to get an app token from this server.
 */
export async function verifyOidcToken(token: unknown, fetchImpl: typeof fetch = fetch, now = Date.now(), audience = OIDC_AUDIENCE): Promise<OidcClaims> {
  const invalid = (why: string) => new HttpError(401, "invalid_token", `GitHub's OIDC token was rejected: ${why}.`);
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3) throw invalid("it isn't a JWT");

  let header: { alg?: unknown; kid?: unknown };
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[0]!)));
    claims = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[1]!)));
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
    base64UrlToBytes(parts[2]!),
    utf8.encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) throw invalid("bad signature");

  const seconds = Math.floor(now / 1000);
  if (claims.iss !== OIDC_ISSUER) throw invalid("wrong issuer");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(audience)) throw invalid("wrong audience");
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_S < seconds) throw invalid("it expired");
  if (typeof claims.nbf === "number" && claims.nbf - CLOCK_SKEW_S > seconds) throw invalid("it isn't valid yet");
  return claims as OidcClaims;
}

async function callGitHub(fetchImpl: typeof fetch, path: string, appJwt: string, init: { method?: string; body?: string } = {}): Promise<Response> {
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
export async function issueToken(
  claims: OidcClaims,
  env: Env,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
  scope: string = "review",
): Promise<{ token: string; expires_at: string; repository: string }> {
  const { permissions, events } = SCOPES[scope as Scope];
  if (!events.has(claims.event_name as string)) {
    throw new HttpError(403, "event_not_allowed", `Runs triggered by ${claims.event_name} don't get a token.`);
  }
  const match = /^([\w.-]+)\/([\w.-]+)$/.exec((claims.repository as string | undefined) ?? "");
  if (!match) throw new HttpError(401, "invalid_token", "GitHub's OIDC token names no repository.");
  const [, owner, repo] = match as unknown as [string, string, string];

  const appJwt = await createAppJwt(env, now);
  const installation = await callGitHub(fetchImpl, `/repos/${owner}/${repo}/installation`, appJwt);
  if (installation.status === 404) {
    throw new HttpError(404, "not_installed", `The Mergelight AI app isn't installed on ${owner}/${repo}. Install it: ${INSTALL_URL}`);
  }
  if (!installation.ok) throw new HttpError(502, "github_error", `GitHub answered ${installation.status} looking up the app.`);
  const { id } = (await installation.json()) as { id: number };

  const res = await callGitHub(fetchImpl, `/app/installations/${id}/access_tokens`, appJwt, {
    method: "POST",
    body: JSON.stringify({ repositories: [repo], permissions }),
  });
  if (res.status === 403 || res.status === 422) {
    throw new HttpError(403, "needs_approval", `The app's install on ${owner}/${repo} needs the updated permissions approved.`);
  }
  if (!res.ok) throw new HttpError(502, "github_error", `GitHub answered ${res.status} creating a token.`);
  const { token, expires_at } = (await res.json()) as { token: string; expires_at: string };
  return { token, expires_at, repository: `${owner}/${repo}` };
}

function respond(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

/**
 * Swaps the code from "Sign in with GitHub" for the person's token, so the setup page can list their
 * repositories and open the setup pull request. It's a Mergelight Setup token, and this server holds
 * no private key for that app. Only this step needs the client secret, which can't live in a web page.
 * The token goes straight back to the browser, and nothing here stores or logs it.
 */
async function signIn(request: Request, env: Env, fetchImpl: typeof fetch): Promise<Response> {
  const cors = { "access-control-allow-origin": SITE_ORIGIN, vary: "Origin" };
  if (request.headers.get("origin") !== SITE_ORIGIN) return respond(403, { error: "origin_not_allowed" });
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { ...cors, "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type", "access-control-max-age": "600" },
    });
  }
  if (request.method !== "POST") return respond(405, { error: "method_not_allowed" }, cors);

  let code: unknown;
  let app: unknown;
  try {
    ({ code, app = "setup" } = (await request.json()) as { code?: unknown; app?: unknown });
  } catch {
    return respond(400, { error: "bad_request" }, cors);
  }
  if (typeof code !== "string" || !/^[\w-]{1,200}$/.test(code)) return respond(400, { error: "bad_request" }, cors);
  // Which app the person signed in to: the setup page uses Mergelight Setup, the dashboard Mergelight AI.
  // A code only works with the app it was made for, so this picks the client id and secret, nothing more.
  const client =
    app === "setup" ? { id: SETUP_CLIENT_ID, secret: env.GITHUB_SETUP_APP_CLIENT_SECRET }
    : app === "review" ? { id: env.GITHUB_APP_CLIENT_ID, secret: env.GITHUB_APP_CLIENT_SECRET }
    : null;
  if (!client) return respond(400, { error: "bad_request" }, cors);
  if (!client.id || !client.secret) return respond(503, { error: "sign_in_not_set_up" }, cors);

  const res = await fetchImpl("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": "mergelight-token-server" },
    body: JSON.stringify({ client_id: client.id, client_secret: client.secret, code }),
  });
  if (!res.ok) return respond(502, { error: "github_error" }, cors);
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  // GitHub answers 200 with an error for a used or expired code.
  if (!body.access_token) return respond(400, { error: "sign_in_failed" }, cors);
  return respond(200, { token: body.access_token, expires_in: body.expires_in ?? null }, cors);
}

/**
 * Tells the setup page if Mergelight AI, the app that posts reviews, is on a repository. Only this server
 * can ask, because GitHub answers that only with the app's private key. The person's token has to reach the
 * repository first, so nobody learns anything about a repository they can't see. Nothing is stored or logged.
 */
async function reviewApp(request: Request, env: Env, fetchImpl: typeof fetch, now: number, searchParams: URLSearchParams): Promise<Response> {
  const cors = { "access-control-allow-origin": SITE_ORIGIN, vary: "Origin" };
  if (request.headers.get("origin") !== SITE_ORIGIN) return respond(403, { error: "origin_not_allowed" });
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { ...cors, "access-control-allow-methods": "GET", "access-control-allow-headers": "authorization", "access-control-max-age": "600" },
    });
  }
  if (request.method !== "GET") return respond(405, { error: "method_not_allowed" }, cors);
  const repo = searchParams.get("repo") ?? "";
  const person = /^Bearer ([\w-]{1,300})$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || repo.includes("..") || !person) return respond(400, { error: "bad_request" }, cors);

  const visible = await callGitHub(fetchImpl, `/repos/${repo}`, person);
  if (!visible.ok) return respond(404, { error: "no_access" }, cors);
  const installation = await callGitHub(fetchImpl, `/repos/${repo}/installation`, await createAppJwt(env, now));
  if (installation.status === 404) return respond(200, { installed: false }, cors);
  if (!installation.ok) return respond(502, { error: "github_error" }, cors);
  return respond(200, { installed: true }, cors);
}

export async function handle(request: Request, env: Env, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<Response> {
  const { pathname, searchParams } = new URL(request.url);
  if (request.method === "GET" && pathname === "/") return respond(200, { service: "mergelight-token-server" });
  if (pathname === "/sign-in") {
    try {
      return await signIn(request, env, fetchImpl);
    } catch (err) {
      console.error("sign-in error", (err as Error | undefined)?.name);
      return respond(500, { error: "server_error" });
    }
  }
  if (pathname === "/review-app") {
    try {
      return await reviewApp(request, env, fetchImpl, now, searchParams);
    } catch (err) {
      console.error("review-app error", (err as Error | undefined)?.name);
      return respond(500, { error: "server_error" }, { "access-control-allow-origin": SITE_ORIGIN, vary: "Origin" });
    }
  }
  if (pathname !== "/token") return respond(404, { error: "not_found" });
  if (request.method !== "POST") return respond(405, { error: "method_not_allowed" });

  try {
    const scope = searchParams.get("scope") ?? "review";
    if (!Object.hasOwn(SCOPES, scope)) throw new HttpError(400, "unknown_scope", "That kind of token doesn't exist.");
    const auth = request.headers.get("authorization") ?? "";
    if (!auth.startsWith("Bearer ")) throw new HttpError(401, "invalid_token", "Send GitHub's OIDC token as a Bearer token.");
    const claims = await verifyOidcToken(auth.slice("Bearer ".length), fetchImpl, now);
    return respond(200, await issueToken(claims, env, fetchImpl, now, scope));
  } catch (err) {
    if (err instanceof HttpError) return respond(err.status, { error: err.code, message: err.message });
    // Never echo unexpected errors: they could carry key material.
    console.error("token server error", (err as Error | undefined)?.name);
    return respond(500, { error: "server_error", message: "The token server hit an error." });
  }
}
