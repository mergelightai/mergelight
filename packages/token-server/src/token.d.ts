// Types for the parts of token.js that the Mergelight server (packages/server) shares.
// Keep it in step with token.js. It goes away when the token server itself is TypeScript.

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string);
}

/** What GitHub signed. exp is checked to be a number; every other claim is unchecked and must be tested before use. */
export type OidcClaims = { exp: number } & Record<string, unknown>;

export function verifyOidcToken(token: unknown, fetchImpl?: typeof fetch, now?: number, audience?: string): Promise<OidcClaims>;
