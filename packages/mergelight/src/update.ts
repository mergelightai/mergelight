import { readFileSync } from "node:fs";
import type { GitHub } from "./publish/api.js";

/**
 * A moving tag like @v0 gets each release by itself. A pinned commit doesn't, so the review
 * tells those people when there's a newer release. It's only a hint, so anything going wrong
 * here just means no hint.
 */

const CURRENT = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

const parts = (version: string) => version.replace(/^v/, "").split(".").map(Number);

export function isNewer(candidate: string, than: string): boolean {
  const [a, b] = [parts(candidate), parts(than)];
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff) return diff > 0;
  }
  return false;
}

/** The latest release's tag, if this run is pinned to a commit and that release is newer. */
export async function newerVersion(api: Pick<GitHub, "get">, current = CURRENT, ref = process.env.MERGELIGHT_ACTION_REF): Promise<string | null> {
  if (!/^[0-9a-f]{40}$/i.test(ref ?? "")) return null;
  try {
    const { tag_name: tag } = await api.get<{ tag_name: string }>("/repos/mergelightai/mergelight/releases/latest");
    return isNewer(tag, current) ? tag : null;
  } catch {
    return null;
  }
}
