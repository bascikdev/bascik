#!/usr/bin/env node
// Tells a deploy job whether the commit it built is still the newest one on
// its branch. Runs finish in any order, and the deploy jobs have no
// concurrency group of their own (on main a shared group would let an older
// deploy that queued later cancel a newer pending one), so when commit X's
// run reaches Wrangler after the newer commit Y's has deployed, X would put
// older code live. Each deploy job runs this right before Wrangler and skips
// the upload or deploy, and the smoke checks, when it prints `false`.
//
// Usage: node .github/scripts/newest-commit.mjs <ref> <sha>
//   <ref>  github.ref of the push, such as refs/heads/main.
//   <sha>  github.sha, the commit the push run built.
// Prints `true` or `false`, and explains a `false` on stderr.
import { execFileSync } from "node:child_process";

/**
 * Finds `ref`'s commit in `git ls-remote` output. Matches the whole ref name:
 * `git ls-remote origin refs/heads/main` also lists refs that only end with
 * `refs/heads/main`.
 *
 * @param {string} lsRemoteOutput Lines of `<sha>\t<ref>`.
 * @param {string} ref A full ref name, such as `refs/heads/main`.
 * @returns {string | undefined} The commit, or undefined when the ref is gone.
 */
export function tipOf(lsRemoteOutput, ref) {
  for (const line of lsRemoteOutput.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab > 0 && line.slice(tab + 1).trimEnd() === ref)
      return line.slice(0, tab);
  }
  return undefined;
}

/**
 * @param {string} lsRemoteOutput
 * @param {string} ref
 * @param {string} sha The commit this run built.
 * @returns {{ newest: boolean; reason?: string }}
 */
export function newestCommit(lsRemoteOutput, ref, sha) {
  if (typeof ref !== "string" || !ref.startsWith("refs/heads/"))
    throw new Error(
      `newest-commit: "${ref}" is not a branch ref (refs/heads/<name>)`,
    );
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/i.test(sha))
    throw new Error(`newest-commit: "${sha}" is not a full commit SHA`);
  const tip = tipOf(lsRemoteOutput, ref);
  if (tip === undefined)
    return { newest: false, reason: `${ref} no longer exists` };
  if (tip.toLowerCase() !== sha.toLowerCase())
    return {
      newest: false,
      reason: `${ref} has moved on to ${tip.slice(0, 12)}; that run deploys instead of ${sha.slice(0, 12)}`,
    };
  return { newest: true };
}

if (import.meta.main) {
  const [ref, sha] = process.argv.slice(2);
  try {
    // Validate before running git, so a typo'd ref is an error, not `false`.
    newestCommit("", ref, sha);
    const output = execFileSync("git", ["ls-remote", "origin", ref], {
      encoding: "utf8",
    });
    const result = newestCommit(output, ref, sha);
    if (!result.newest)
      console.error(`::notice::Skipping the deploy: ${result.reason}`);
    process.stdout.write(`${result.newest}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
