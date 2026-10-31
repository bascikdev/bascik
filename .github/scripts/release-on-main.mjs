#!/usr/bin/env node
// Packages release only from commits on main (RELEASING.md). Every publish job
// in release.yml runs this right after a full-history checkout, before it
// builds, tests or publishes anything, and the job fails unless the tagged
// commit is an ancestor of origin/main. A tag pushed on an unmerged branch or a
// local commit therefore never reaches npm or the Marketplace.
//
// Usage: node .github/scripts/release-on-main.mjs <tag> <sha>
//   <tag>  github.ref_name, such as v1.0.0 or create-v1.0.3.
//   <sha>  github.sha. A tag object is dereferenced to the commit it tags.
// Exits 0 when the commit is on main; otherwise prints an ::error:: line and
// exits 1.
//
// It runs before setup-node, on the runner's preinstalled Node, so it uses no
// API newer than Node 20 (no import.meta.main).
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAIN = "refs/remotes/origin/main";

/** @typedef {{ status: number | null; stdout: string; stderr: string }} GitResult */

/**
 * @param {string} tag The pushed tag's name.
 * @param {string} sha The full SHA the tag points at (a commit or a tag object).
 * @param {(args: string[]) => GitResult} git Runs git in the checkout.
 * @returns {string} A one-line confirmation.
 */
export function releaseOnMain(tag, sha, git) {
  if (typeof tag !== "string" || tag === "")
    throw new Error(
      "release-on-main: no tag name (pass github.ref_name as the first argument)",
    );
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/i.test(sha))
    throw new Error(`release-on-main: "${sha}" is not a full commit SHA`);
  if (
    git(["rev-parse", "--verify", "--quiet", `${MAIN}^{commit}`]).status !== 0
  )
    throw new Error(
      "release-on-main: origin/main is not in this checkout, so the tag cannot be checked. Check out with " +
        "fetch-depth: 0 (actions/checkout fetches only the tagged commit by default).",
    );
  const resolved = git(["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]);
  if (resolved.status !== 0)
    throw new Error(
      `release-on-main: ${sha} (tag ${tag}) is not in this checkout`,
    );
  const commit = resolved.stdout.trim();
  const ancestor = git(["merge-base", "--is-ancestor", commit, MAIN]);
  if (ancestor.status === 0)
    return `${tag} points at ${commit.slice(0, 12)}, which is on main`;
  if (ancestor.status === 1)
    throw new Error(
      `Tag ${tag} points at commit ${commit}, which is not on main. Packages release only from commits on ` +
        `main: merge the pull request first, then tag the commit on main. Delete this tag with ` +
        `git tag -d ${tag} && git push origin :refs/tags/${tag} (see RELEASING.md).`,
    );
  throw new Error(
    `release-on-main: git merge-base failed (exit ${ancestor.status}): ${ancestor.stderr.trim()}`,
  );
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url
) {
  const [tag, sha] = process.argv.slice(2);
  /** @type {(args: string[]) => GitResult} */
  const git = (args) => {
    const result = spawnSync("git", args, { encoding: "utf8" });
    if (result.error) throw result.error;
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };
  try {
    console.log(releaseOnMain(tag, sha, git));
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
