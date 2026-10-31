#!/usr/bin/env node
// The two Workers deploy to production only from pull requests merged into
// main (DEPLOYMENT.md). A push to main runs no tests, because the pull
// request's branch was tested before the merge; a commit pushed straight to
// main was never tested that way, so it must not deploy. On a push to main
// each deploy job asks GitHub which pull requests the commit belongs to
// (`GET /repos/{owner}/{repo}/commits/{sha}/pulls`) and runs this on the
// answer before it builds or runs Wrangler. The emergency path for a deploy
// without CI is the manual one in DEPLOYMENT.md.
//
// Usage: node .github/scripts/merged-pull-request.mjs <sha> <pulls.json>
//   <sha>         github.sha, the commit the push run built.
//   <pulls.json>  The `gh api repos/<owner>/<repo>/commits/<sha>/pulls` output.
// Prints the pull request it found, or an ::error:: line and exits 1.
import { readFileSync } from "node:fs";

const EMERGENCY = 'DEPLOYMENT.md, "Manual Deploy in an Emergency"';

/**
 * @param {unknown} pulls The parsed API response: a list of pull requests.
 * @param {string} sha The commit this run built.
 * @param {string} [base] The branch the pull request must have merged into.
 * @returns {number} The merged pull request's number.
 */
export function mergedPullRequest(pulls, sha, base = "main") {
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/i.test(sha))
    throw new Error(`merged-pull-request: "${sha}" is not a full commit SHA`);
  if (!Array.isArray(pulls))
    throw new Error(
      `merged-pull-request: the GitHub API did not return a list of pull requests for ${sha}: ` +
        JSON.stringify(pulls).slice(0, 300),
    );
  const merged = pulls.find(
    (pull) => pull && pull.merged_at && pull.base && pull.base.ref === base,
  );
  if (merged) return merged.number;
  const seen = pulls
    .map((pull) =>
      pull && pull.merged_at
        ? `#${pull.number} (merged into ${pull.base && pull.base.ref})`
        : `#${pull && pull.number} (${(pull && pull.state) || "not merged"})`,
    )
    .join(", ");
  throw new Error(
    `${sha.slice(0, 12)} did not come from a pull request merged into ${base}, so it does not deploy ` +
      `(pull requests with this commit: ${seen || "none"}). Merge changes into ${base} through a pull ` +
      `request; to deploy without CI, see ${EMERGENCY}.`,
  );
}

if (import.meta.main) {
  const [sha, file] = process.argv.slice(2);
  try {
    if (!file)
      throw new Error(
        "merged-pull-request: pass the commit SHA and the gh api output file",
      );
    const text = readFileSync(file, "utf8");
    let pulls;
    try {
      pulls = JSON.parse(text);
    } catch {
      throw new Error(
        `merged-pull-request: ${file} is not JSON (did gh api fail?): ${text.slice(0, 200)}`,
      );
    }
    const number = mergedPullRequest(pulls, sha);
    console.log(
      `${sha.slice(0, 12)} came from pull request #${number}; deploying.`,
    );
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
