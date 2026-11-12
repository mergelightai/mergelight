#!/usr/bin/env node
// Decides where the major tag people follow, like v0, goes next. Used by .github/workflows/roll-out.yml.
//
// A release reaches @v0 only once its canary passed. canary.yml opens a pull request in the sandbox
// repository that runs the review with that release on one planted, obvious bug, and the sandbox
// reviews it for real. The canary passed when that review finished and found something: a review
// that can't run, or that calls the planted bug safe, means the release is broken.

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const CANARY_REPO = "mergelightai/action-sandbox";
export const canaryBranch = (tag) => `canary/${tag}`;

export const PLANTED_FILE = "canary/delete-project.js";
export const CANARY_TIMEOUT_MS = 3 * 60 * 60 * 1000;

/**
 * "passed", "failed" or "waiting" for one canary pull request, with the reason.
 * Passed: the newest "Mergelight" check finished as a review that holds the merge (🔴 or 🟡, or 🟢
 * only because someone approved it), and the review commented on the planted file. A review that
 * can't run, that calls the bug safe, or that flags only other things means the release is broken.
 * A canary with no finished review after 3 hours failed too, so a release that hangs still says so.
 */
export function canaryVerdict({ check, flaggedPlantedFile, openedAt, now = Date.now() }) {
  if (check?.status !== "completed") {
    if (now - Date.parse(openedAt) > CANARY_TIMEOUT_MS) return { verdict: "failed", why: "no finished review after 3 hours" };
    return { verdict: "waiting", why: check ? "the review is running" : "no review yet" };
  }
  const title = check.output?.title ?? "";
  if (!/^(🔴|🟡) |^🟢 Approved by /u.test(title)) return { verdict: "failed", why: title || "the review ended without a result" };
  if (!flaggedPlantedFile) return { verdict: "failed", why: `the review didn't flag the planted bug in ${PLANTED_FILE}` };
  return { verdict: "passed", why: title };
}

/** Version order, newest first: v0.1.10 comes after v0.1.9. A tag that isn't a plain version sorts last. */
export function byVersion(a, b) {
  const parts = (tag) => (/^v\d+\.\d+\.\d+$/.test(tag) ? tag.slice(1).split(".").map(Number) : [-1, -1, -1]);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i];
  return 0;
}

/**
 * Walks the releases newest first and takes the first whose canary passed.
 * Never back: if the tag already points at a release before one passes, it stays, because that
 * release is newer than every release that could still be picked. A pulled release (made a
 * pre-release, or deleted) isn't in the list, so the tag moves off it. When nothing passed, `stuck`
 * says the tag is still on a pulled release, so the run can say so instead of staying quiet.
 * `now` rolls out the newest release without waiting for its canary.
 */
export function pickRelease(releases, verdictOf, current, now = false) {
  const failed = [];
  const waiting = [];
  for (const release of releases) {
    if (current && release.sha === current) return { stay: release.tag, failed, waiting };
    const verdict = now ? "passed" : verdictOf(release.tag);
    if (verdict === "passed") return { move: release, failed, waiting };
    (verdict === "failed" ? failed : waiting).push(release.tag);
  }
  return { failed, waiting, stuck: Boolean(current) };
}

async function github(path, token) {
  const res = await fetch(`https://api.github.com/${path}`, {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" },
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${path.split("?")[0]}`);
  return res.json();
}

async function readCanary(tag, publishedAt, isNewest, token) {
  const [owner] = CANARY_REPO.split("/");
  const pulls = await github(`repos/${CANARY_REPO}/pulls?state=all&per_page=10&head=${owner}:${encodeURIComponent(canaryBranch(tag))}`, token);
  const pull = pulls.sort((a, b) => b.number - a.number)[0];
  // The newest release's canary opens right after it. If it never did, it would wait forever without a
  // word, so it gets the same 3 hours. An older release without one is just passed over: it may be from
  // before canaries existed, and a newer release has its own.
  if (!pull) {
    const late = isNewest && Date.now() - Date.parse(publishedAt) > CANARY_TIMEOUT_MS;
    return late ? { verdict: "failed", note: "no canary was opened within 3 hours of the release" } : { verdict: "waiting", note: "no canary" };
  }
  const { check_runs } = await github(`repos/${CANARY_REPO}/commits/${pull.head.sha}/check-runs?check_name=Mergelight&per_page=20`, token);
  const check = check_runs.sort((a, b) => b.id - a.id)[0];
  // The planted bug counts as flagged when the review put a comment on its file, or named the file in the
  // check's summary, where a finding without an inline comment is listed.
  let flaggedPlantedFile = (check?.output?.summary ?? "").includes(PLANTED_FILE);
  if (check?.status === "completed" && !flaggedPlantedFile) {
    const comments = await github(`repos/${CANARY_REPO}/pulls/${pull.number}/comments?per_page=100`, token);
    flaggedPlantedFile = comments.some((c) => c.path === PLANTED_FILE && c.user?.type === "Bot");
  }
  const { verdict, why } = canaryVerdict({ check, flaggedPlantedFile, openedAt: pull.created_at });
  return { verdict, note: `${pull.html_url}: ${why}` };
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const now = process.env.NOW === "true";
  const sandboxToken = process.env.SANDBOX_TOKEN ?? "";
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
  const commitOf = (tag) => {
    try {
      return git("rev-parse", "-q", "--verify", `refs/tags/${tag}^{commit}`);
    } catch {
      return "";
    }
  };

  // Every release people can get: not a draft, not a pre-release.
  const published = new Map(
    (await github(`repos/${repo}/releases?per_page=100`, process.env.GH_TOKEN))
      .filter((r) => !r.draft && !r.prerelease && /^v\d+\.\d+\.\d+$/.test(r.tag_name))
      .map((r) => [r.tag_name, r.published_at]),
  );
  const all = [...published.keys()].sort(byVersion);
  if (all.length === 0) return console.log("There is no release yet.");
  const major = all[0].split(".")[0];
  // A release whose tag isn't in this checkout can't be moved to, so it is left out.
  const releases = all.filter((tag) => tag.startsWith(`${major}.`)).map((tag) => ({ tag, sha: commitOf(tag) })).filter((r) => r.sha);
  const current = commitOf(major);

  if (!sandboxToken && !now) console.log("::warning::The release app isn't set up, so no canary can be read. Only a run with \"now\" moves the tag.");
  const verdicts = new Map();
  for (const release of releases) {
    if ((current && release.sha === current) || now) break;
    const canary = sandboxToken ? await readCanary(release.tag, published.get(release.tag), release === releases[0], sandboxToken) : { verdict: "waiting", note: "no release app" };
    verdicts.set(release.tag, canary.verdict);
    console.log(`${release.tag}: canary ${canary.verdict} (${canary.note})`);
  }

  const pick = pickRelease(releases, (tag) => verdicts.get(tag) ?? "waiting", current, now);
  const out = (line) => process.env.GITHUB_OUTPUT && appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
  out(`major=${major}`);
  out(`failed=${pick.failed.join(" ")}`);
  if (pick.move) {
    out(`tag=${pick.move.tag}`);
    out(`sha=${pick.move.sha}`);
    console.log(`${major} goes to ${pick.move.tag}${now ? ", by hand without its canary" : ", whose canary passed"}.`);
  } else if (pick.stay) {
    console.log(`${major} stays on ${pick.stay}.`);
  } else if (pick.stuck) {
    console.log(`::error::${major} is on ${current.slice(0, 7)}, which is no longer a release (it was pulled), and no release has a canary that passed. Run the Canary workflow for an older release, or run Roll out with "now".`);
    process.exitCode = 1;
  } else {
    console.log(`No ${major} release has a canary that passed yet.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`::error::${err.message}`);
    process.exit(1);
  });
}
