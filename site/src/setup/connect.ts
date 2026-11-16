/**
 * Reads what a run asks for in its comment on the pull request. No imports and only plain types, so a Node test
 * can load this file as it is.
 */

/** The link and code for connecting an AI, as the Action posted them on the pull request. */
export interface ConnectCode {
  /** Empty when only Claude is on offer. */
  url: string;
  code: string;
  claudeUrl: string | null;
  /** What the login is for: the review, or checking another AI's review. */
  purpose: 'review' | 'check';
}

/**
 * Who can post for Mergelight. Anyone can comment on a public pull request, and entering someone else's
 * code would sign them in on your plan, so nobody else's comment counts.
 */
const OWN_COMMENTERS = ['mergelight-ai[bot]', 'github-actions[bot]'];

/** The hidden line a run writes. Each value still has to be the exact shape it should be, whatever the comment says. */
export function readConnectData(body: string): ConnectCode | null {
  const raw = body.match(/^<!-- mergelight:connect:v1 (\{.*\}) -->$/m)?.[1];
  if (!raw) return null;
  try {
    const { url, code, claudeUrl, for: purpose } = JSON.parse(raw) as { url?: unknown; code?: unknown; claudeUrl?: unknown; for?: unknown };
    const device = typeof url === 'string' && typeof code === 'string' && /^https:\/\/auth\.openai\.com\/\S+$/.test(url) && /^[A-Z0-9]{4}-[A-Z0-9]{4,}$/.test(code);
    const claude = typeof claudeUrl === 'string' && /^https:\/\/claude\.(?:com|ai)\/\S+$/.test(claudeUrl) ? claudeUrl : null;
    if (!device && !claude) return null;
    // A line without "for" is a reviewer's, as every release before checkers wrote it.
    return { url: device ? (url as string) : '', code: device ? (code as string) : '', claudeUrl: claude, purpose: purpose === 'check' ? 'check' : 'review' };
  } catch {
    return null;
  }
}

/**
 * Finds the code in Mergelight's comment, if that comment is still asking for one. It has to be in the
 * exact shape the Action writes, because a finished review's comment can quote text from the pull request.
 */
export function readConnectCode(comments: { user: { login: string } | null; body?: string | null }[]): ConnectCode | null {
  const body = comments.filter((c) => OWN_COMMENTERS.includes(c.user?.login ?? '') && c.body?.includes('<!-- mergelight:summary -->')).at(-1)?.body;
  if (!body?.includes('<!-- mergelight:pending -->')) return null;
  const data = readConnectData(body);
  if (data) return data;
  // Releases before v0.1.10 only have these lines.
  const url = body.match(/^1\. Open (https:\/\/auth\.openai\.com\/\S+)$/m)?.[1];
  const code = body.match(/^2\. Enter this code: `([A-Z0-9]{4}-[A-Z0-9]{4,})`$/m)?.[1];
  const claudeUrl = body.match(/^Claude: Open (https:\/\/claude\.(?:com|ai)\/\S+)$/m)?.[1] ?? null;
  if (!(url && code) && !claudeUrl) return null;
  return { url: url && code ? url : '', code: url && code ? code : '', claudeUrl, purpose: 'review' };
}

/**
 * The one AI this run can connect, when that's all it offers, so the page never offers the other. A checker's line
 * holds one AI. A reviewer's line with only Claude's link is a run that has no ChatGPT code to give. A reviewer's line
 * with only a code still leaves Claude by hand, as before.
 */
export function onlyAi(found: ConnectCode): 'claude' | 'codex' | null {
  if (found.claudeUrl && !found.code) return 'claude';
  if (found.purpose === 'check' && found.code && !found.claudeUrl) return 'codex';
  return null;
}
