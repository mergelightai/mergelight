import { readFileSync } from "node:fs";
import type { GitHub } from "./publish/api.js";

/**
 * A moving tag like @v0 gets each release by itself. A pinned commit doesn't, so the review
 * tells those people when there's a newer release. It's only a hint, so anything going wrong
 * here just means no hint.
 */

/** This package's version, like 0.1.19. */
export const CURRENT = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

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

/** A tag as GitHub's list of a repository's tags has it. */
export interface Tag {
  name: string;
  commit: { sha: string };
}

/**
 * The version @v0 points to: the newest release whose canary review passed. A newer release that is still
 * being tried has no one pointed at it yet. Null when it can't be told.
 */
export function rolledOut(tags: Tag[]): string | null {
  const v0 = tags.find((t) => t.name === "v0")?.commit.sha;
  if (!v0) return null;
  return tags.filter((t) => t.commit.sha === v0 && /^v\d+\.\d+\.\d+$/.test(t.name)).map((t) => t.name).sort((a, b) => (isNewer(a, b) ? -1 : 1))[0] ?? null;
}

/** The changes a release's generated notes list, without the version bumps. */
export function releaseNews(notes: string): string[] {
  return [...notes.matchAll(/^\* (.+?) by @\S+ in https:\/\/\S+$/gm)].map((m) => m[1]!).filter((title) => !/^Release v\d/.test(title));
}

/** What a pinned run is missing, if there's a newer release. */
export async function newerVersion(api: Pick<GitHub, "get" | "list">, current = CURRENT, ref = process.env.MERGELIGHT_ACTION_REF): Promise<UpdateNotice | null> {
  if (!/^[0-9a-f]{40}$/i.test(ref ?? "")) return null;
  try {
    const releases = await api.get<{ tag_name: string; body?: string | null; draft: boolean; prerelease: boolean }[]>("/repos/mergelightai/mergelight/releases?per_page=30");
    // Never past the version @v0 points to: a release still in its canary isn't offered yet.
    // Every page: GitHub lists v0 after all the version tags, so it falls past the first page in time.
    const top = rolledOut(await api.list<Tag>("/repos/mergelightai/mergelight/tags"));
    if (!top) return null;
    const newer = releases.filter((r) => !r.draft && !r.prerelease && isNewer(r.tag_name, current) && !isNewer(r.tag_name, top)).sort((a, b) => (isNewer(a.tag_name, b.tag_name) ? -1 : 1));
    if (!newer.length) return null;
    return { tag: newer[0]!.tag_name, current: `v${current.replace(/^v/, "")}`, news: newer.flatMap((r) => releaseNews(r.body ?? "")) };
  } catch {
    return null;
  }
}
