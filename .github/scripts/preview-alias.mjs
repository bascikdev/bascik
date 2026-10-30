#!/usr/bin/env node
// Turns a pull request's branch name into the Workers preview alias CI passes
// to `wrangler versions upload --preview-alias`. One alias serves every Worker
// the repo deploys, so a branch keeps the same Preview URLs on every push:
// https://<alias>-<worker-name>.<account-subdomain>.workers.dev
//
// Usage: node .github/scripts/preview-alias.mjs <branch> <worker-name>...
// Prints the alias. Pass the PR's head branch (github.head_ref), not github.ref.
//
// A branch name that is already a valid alias is used as is. Any other name
// gets a short hash of the full branch name appended, so `feature/x`,
// `Feature_X` and `feature-x` get three different aliases instead of
// overwriting each other's Preview.
import { createHash } from "node:crypto";

/** Longest DNS label: `<alias>-<worker-name>` has to fit in one. */
export const MAX_DNS_LABEL_LENGTH = 63;

/** Hex digits of the branch hash appended to a shortened alias. */
const HASH_LENGTH = 6;

/** Shortest alias still worth having before the hash is appended. */
const MIN_ALIAS_LENGTH = 8;

/**
 * @param {string} branch The branch name, such as `feature/Milk-Frother_v2`.
 * @param {readonly string[]} workerNames Every Worker the alias is used with.
 * @returns {string} Lowercase `[a-z0-9-]`, starting with a letter, not ending
 *   with `-`, short enough for the longest Worker name, and in practice
 *   different for every branch name.
 */
export function previewAlias(branch, workerNames) {
  if (typeof branch !== "string" || branch.trim() === "")
    throw new Error(
      "preview-alias: a branch name is required (github.head_ref on a pull request)",
    );
  if (branch.startsWith("refs/pull/"))
    throw new Error(
      `preview-alias: "${branch}" is a pull request ref, not a branch; pass github.head_ref`,
    );
  if (
    !Array.isArray(workerNames) ||
    workerNames.length === 0 ||
    workerNames.some((name) => typeof name !== "string" || name === "")
  )
    throw new Error("preview-alias: name at least one Worker");

  const name = branch.startsWith("refs/heads/")
    ? branch.slice("refs/heads/".length)
    : branch;
  // Each pattern below is a single character class or a fixed string, so
  // every replace is linear in the branch length.
  let alias = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-/, "")
    .replace(/-$/, "");
  if (alias === "")
    throw new Error(
      `preview-alias: "${branch}" has no letters or digits to build an alias from`,
    );
  // Wrangler accepts only aliases that start with a letter.
  if (!/^[a-z]/.test(alias)) alias = `b-${alias}`;

  const longestWorker = Math.max(...workerNames.map((n) => n.length));
  const maxLength = MAX_DNS_LABEL_LENGTH - 1 - longestWorker;
  if (maxLength < MIN_ALIAS_LENGTH + 1 + HASH_LENGTH)
    throw new Error(
      `preview-alias: a Worker name of ${longestWorker} characters leaves no room for an alias`,
    );
  if (alias === name && alias.length <= maxLength) return alias;

  // A changed or shortened alias ends with a hash of the full branch name, so
  // two branches that clean up to the same text, or share a long prefix,
  // still get different Preview URLs.
  const hash = createHash("sha256")
    .update(name)
    .digest("hex")
    .slice(0, HASH_LENGTH);
  const head = alias.slice(0, maxLength - 1 - HASH_LENGTH).replace(/-$/, "");
  return `${head}-${hash}`;
}

if (import.meta.main) {
  const [branch, ...workers] = process.argv.slice(2);
  try {
    process.stdout.write(`${previewAlias(branch, workers)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
