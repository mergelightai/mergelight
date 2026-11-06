import { readFileSync } from "node:fs";
import type { GitHub } from "./publish/api.js";

/**
 * People run a pinned commit of the Action, so a fix doesn't reach them by itself.
 * The review tells them when there's a newer release. It's only a hint, so anything
 * going wrong here just means no hint.
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

/** The latest release's tag, if it's newer than the version running here. */
export async function newerVersion(api: Pick<GitHub, "get">, current = CURRENT): Promise<string | null> {
  try {
    const { tag_name: tag } = await api.get<{ tag_name: string }>("/repos/mergelightai/mergelight/releases/latest");
    return isNewer(tag, current) ? tag : null;
  } catch {
    return null;
  }
}
