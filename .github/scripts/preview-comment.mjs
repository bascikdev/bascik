#!/usr/bin/env node
// Publishes the Cloudflare Preview URLs of a branch push. It always writes them
// to the run's job summary, and when the branch has an open pull request in
// this repository, it creates or updates the one comment that lists them
// there. A branch without a pull request gets the summary only.
//
// The comment starts with a hidden marker; a later push edits that comment
// instead of adding another. Only a comment written by the workflow's own bot
// account is ever edited.
//
// Usage (in CI): node .github/scripts/preview-comment.mjs
// Environment: GITHUB_TOKEN, GITHUB_REPOSITORY (owner/name), BRANCH
// (github.ref_name), SHA (github.sha: the commit CI built), DOCS_PREVIEW_URL,
// DEMO_PREVIEW_URL, and optionally RUN_URL, GITHUB_STEP_SUMMARY and
// GITHUB_API_URL.
import { appendFileSync } from "node:fs";

export const MARKER = "<!-- bascik-cloudflare-previews -->";

/** The account GITHUB_TOKEN posts as. */
export const BOT_LOGIN = "github-actions[bot]";

/**
 * @typedef {{ label: string; worker: string; url: string; paths: readonly string[] }} PreviewLink
 * @typedef {{ id: number; body?: string | null; user?: { login?: string } | null }} IssueComment
 * @typedef {{ number: number; head?: { repo?: { full_name?: string } | null } | null }} PullRequest
 */

const SHA = /^[0-9a-f]{7,40}$/i;
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;

/**
 * A push run builds the branch's own commit, `github.sha`, so the comment names
 * that commit and the branch.
 *
 * @param {{ sha: string; branch: string; previews: readonly PreviewLink[]; runUrl?: string }} input
 * @returns {string}
 */
export function commentBody({ sha, branch, previews, runUrl }) {
  if (typeof sha !== "string" || !SHA.test(sha))
    throw new Error(`preview-comment: "${sha}" is not a commit SHA`);
  if (typeof branch !== "string" || branch.trim() === "")
    throw new Error("preview-comment: a branch name is required");
  if (previews.length === 0)
    throw new Error("preview-comment: no Preview URLs to list");
  const rows = previews.map(({ label, worker, url, paths }) => {
    if (!/^https:\/\/[^\s<>|]+$/.test(url))
      throw new Error(`preview-comment: "${url}" is not an https URL`);
    const base = url.replace(/\/$/, "");
    const links = paths.map((path) => `[${path}](${base}${path})`).join(" · ");
    return `| ${label} | \`${worker}\` | ${links} |`;
  });
  // Git allows a backtick in a branch name; it would end the code span.
  const shownBranch = branch.replace(/`/g, "'");
  return [
    MARKER,
    "### Cloudflare Previews",
    "",
    `Built from ${sha.slice(0, 12)} on \`${shownBranch}\`. These URLs stay the same for this branch and show its newest successful build.`,
    "",
    "| Site | Worker | Preview |",
    "| :--- | :----- | :------ |",
    ...rows,
    "",
    runUrl ? `[Deploy run](${runUrl})` : "",
  ]
    .join("\n")
    .trimEnd();
}

/**
 * @param {readonly IssueComment[]} comments
 * @returns {IssueComment | undefined}
 */
export function findStickyComment(comments) {
  return comments.find(
    (comment) =>
      comment.user?.login === BOT_LOGIN &&
      typeof comment.body === "string" &&
      comment.body.startsWith(MARKER),
  );
}

/**
 * @param {{ token: string; fetchImpl?: typeof fetch }} input
 * @returns {(url: string, init?: RequestInit) => Promise<any>}
 */
function githubClient({ token, fetchImpl = fetch }) {
  if (!token) throw new Error("preview-comment: GITHUB_TOKEN is not set");
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
  };
  return async (url, init) => {
    const response = await fetchImpl(url, {
      ...init,
      headers: { ...headers, ...init?.headers },
    });
    if (!response.ok)
      throw new Error(
        `preview-comment: ${init?.method ?? "GET"} ${new URL(url).pathname} answered ${response.status}`,
      );
    return response.json();
  };
}

/** @param {string} repository */
function checkRepository(repository) {
  if (typeof repository !== "string" || !REPOSITORY.test(repository))
    throw new Error(
      `preview-comment: "${repository}" is not an owner/name repository`,
    );
}

/**
 * The open pull requests whose head is `branch` in `repository` itself. A
 * fork's branch of the same name has another owner, so `head=<owner>:<branch>`
 * never matches it.
 *
 * @param {{ apiUrl?: string; repository: string; branch: string; token: string; fetchImpl?: typeof fetch }} input
 * @returns {Promise<number[]>} Pull request numbers, oldest first.
 */
export async function findOpenPullRequests({
  apiUrl = "https://api.github.com",
  repository,
  branch,
  token,
  fetchImpl,
}) {
  checkRepository(repository);
  if (typeof branch !== "string" || branch.trim() === "")
    throw new Error("preview-comment: a branch name is required");
  const call = githubClient({ token, fetchImpl });
  const owner = repository.split("/")[0];
  const head = encodeURIComponent(`${owner}:${branch}`);
  /** @type {PullRequest[]} */
  const pulls = await call(
    `${apiUrl}/repos/${repository}/pulls?head=${head}&state=open&per_page=100`,
  );
  return pulls
    .filter((pull) => (pull.head?.repo?.full_name ?? repository) === repository)
    .map((pull) => pull.number)
    .sort((a, b) => a - b);
}

/**
 * @param {{ apiUrl?: string; repository: string; issue: number; token: string; body: string; fetchImpl?: typeof fetch }} input
 * @returns {Promise<{ action: "created" | "updated"; id: number }>}
 */
export async function upsertComment({
  apiUrl = "https://api.github.com",
  repository,
  issue,
  token,
  body,
  fetchImpl,
}) {
  checkRepository(repository);
  if (!Number.isInteger(issue) || issue <= 0)
    throw new Error(`preview-comment: "${issue}" is not a pull request number`);
  const call = githubClient({ token, fetchImpl });

  const base = `${apiUrl}/repos/${repository}/issues`;
  /** @type {IssueComment | undefined} */
  let existing;
  for (let page = 1; !existing; page++) {
    /** @type {IssueComment[]} */
    const comments = await call(
      `${base}/${issue}/comments?per_page=100&page=${page}`,
    );
    existing = findStickyComment(comments);
    if (comments.length < 100) break;
  }
  const json = { "content-type": "application/json" };
  if (existing) {
    await call(`${base}/comments/${existing.id}`, {
      method: "PATCH",
      headers: json,
      body: JSON.stringify({ body }),
    });
    return { action: "updated", id: existing.id };
  }
  const created = await call(`${base}/${issue}/comments`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ body }),
  });
  return { action: "created", id: created.id };
}

/**
 * What CI runs: builds the body, appends it to the job summary, then comments
 * on each open pull request of the branch.
 *
 * @param {Record<string, string | undefined>} env
 * @param {{ fetchImpl?: typeof fetch; log?: (line: string) => void; appendSummary?: (path: string, text: string) => void }} [options]
 * @returns {Promise<{ body: string; comments: { pr: number; action: "created" | "updated"; id: number }[] }>}
 */
export async function run(
  env,
  {
    fetchImpl,
    log = console.log,
    appendSummary = (path, text) => appendFileSync(path, text),
  } = {},
) {
  for (const name of ["DOCS_PREVIEW_URL", "DEMO_PREVIEW_URL", "SHA", "BRANCH"])
    if (!env[name]) throw new Error(`preview-comment: ${name} is not set`);
  const branch = env.BRANCH ?? "";
  const body = commentBody({
    sha: env.SHA ?? "",
    branch,
    runUrl: env.RUN_URL,
    previews: [
      {
        label: "Docs (bascik.dev)",
        worker: "bascik",
        url: env.DOCS_PREVIEW_URL ?? "",
        paths: ["/", "/components", "/deployment/cloudflare"],
      },
      {
        label: "Adapter demo (cloudflare-adapter.bascik.dev)",
        worker: "cloudflare-adapter",
        url: env.DEMO_PREVIEW_URL ?? "",
        paths: ["/", "/catalog", "/catalog-stream"],
      },
    ],
  });
  if (env.GITHUB_STEP_SUMMARY)
    appendSummary(env.GITHUB_STEP_SUMMARY, `${body}\n`);

  const target = {
    apiUrl: env.GITHUB_API_URL,
    repository: env.GITHUB_REPOSITORY ?? "",
    token: env.GITHUB_TOKEN ?? "",
    fetchImpl,
  };
  const pulls = await findOpenPullRequests({ ...target, branch });
  if (pulls.length === 0) {
    log(
      `No open pull request from ${branch}; the Preview URLs are in the job summary.`,
    );
    return { body, comments: [] };
  }
  const comments = [];
  for (const pr of pulls) {
    const result = await upsertComment({ ...target, issue: pr, body });
    log(`Preview comment ${result.action} on #${pr} (id ${result.id})`);
    comments.push({ pr, ...result });
  }
  return { body, comments };
}

if (import.meta.main) {
  try {
    await run(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
