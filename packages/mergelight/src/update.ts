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

export interface UpdateNotice {
  /** The newest release. */
  tag: string;
  /** The version this run is on. */
  current: string;
  /** What the releases since then added, newest first. */
  news: string[];
}

/** The changes a release's generated notes list, without the version bumps. */
export function releaseNews(notes: string): string[] {
  return [...notes.matchAll(/^\* (.+?) by @\S+ in https:\/\/\S+$/gm)].map((m) => m[1]!).filter((title) => !/^Release v\d/.test(title));
}

/** What a pinned run is missing, if there's a newer release. */
export async function newerVersion(api: Pick<GitHub, "get">, current = CURRENT, ref = process.env.MERGELIGHT_ACTION_REF): Promise<UpdateNotice | null> {
  if (!/^[0-9a-f]{40}$/i.test(ref ?? "")) return null;
  try {
    const releases = await api.get<{ tag_name: string; body?: string | null; draft: boolean; prerelease: boolean }[]>("/repos/mergelightai/mergelight/releases?per_page=30");
    const newer = releases.filter((r) => !r.draft && !r.prerelease && isNewer(r.tag_name, current)).sort((a, b) => (isNewer(a.tag_name, b.tag_name) ? -1 : 1));
    if (!newer.length) return null;
    return { tag: newer[0]!.tag_name, current: `v${current.replace(/^v/, "")}`, news: newer.flatMap((r) => releaseNews(r.body ?? "")) };
  } catch {
    return null;
  }
}
