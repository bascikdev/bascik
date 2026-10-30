#!/usr/bin/env node
// Creates or updates the one pull request comment that lists the Cloudflare
// Preview URLs. The comment starts with a hidden marker; a later push edits
// that comment instead of adding another. Only a comment written by the
// workflow's own bot account is ever edited.
//
// Usage (in CI): node .github/scripts/preview-comment.mjs
// Environment: GITHUB_TOKEN, GITHUB_REPOSITORY (owner/name), PR_NUMBER,
// HEAD_SHA (the branch commit), MERGE_SHA (github.sha: the commit CI built,
// the branch merged into BASE_REF), BASE_REF, DOCS_PREVIEW_URL,
// DEMO_PREVIEW_URL, and optionally RUN_URL and GITHUB_API_URL.

export const MARKER = "<!-- bascik-cloudflare-previews -->";

/** The account GITHUB_TOKEN posts as. */
export const BOT_LOGIN = "github-actions[bot]";

/**
 * @typedef {{ label: string; worker: string; url: string; paths: readonly string[] }} PreviewLink
 * @typedef {{ id: number; body?: string | null; user?: { login?: string } | null }} IssueComment
 */

const SHA = /^[0-9a-f]{7,40}$/i;

/**
 * A pull request run builds `refs/pull/<n>/merge`: the branch's head commit
 * merged into the base branch. The comment names both, so nobody reads the
 * Preview as the branch alone.
 *
 * @param {{ headSha: string; mergeSha: string; baseRef: string; previews: readonly PreviewLink[]; runUrl?: string }} input
 * @returns {string}
 */
export function commentBody({ headSha, mergeSha, baseRef, previews, runUrl }) {
  for (const sha of [headSha, mergeSha])
    if (typeof sha !== "string" || !SHA.test(sha))
      throw new Error(`preview-comment: "${sha}" is not a commit SHA`);
  if (typeof baseRef !== "string" || !/^[\w./-]+$/.test(baseRef))
    throw new Error(`preview-comment: "${baseRef}" is not a branch name`);
  if (previews.length === 0)
    throw new Error("preview-comment: no Preview URLs to list");
  const rows = previews.map(({ label, worker, url, paths }) => {
    if (!/^https:\/\/[^\s<>|]+$/.test(url))
      throw new Error(`preview-comment: "${url}" is not an https URL`);
    const base = url.replace(/\/$/, "");
    const links = paths.map((path) => `[${path}](${base}${path})`).join(" · ");
    return `| ${label} | \`${worker}\` | ${links} |`;
  });
  return [
    MARKER,
    "### Cloudflare Previews",
    "",
    `Built from ${headSha.slice(0, 12)} merged into \`${baseRef}\` (merge commit ${mergeSha.slice(0, 12)}). These URLs stay the same for this branch and show its newest successful build.`,
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
 * @param {{ apiUrl?: string; repository: string; issue: number; token: string; body: string; fetchImpl?: typeof fetch }} input
 * @returns {Promise<{ action: "created" | "updated"; id: number }>}
 */
export async function upsertComment({
  apiUrl = "https://api.github.com",
  repository,
  issue,
  token,
  body,
  fetchImpl = fetch,
}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error(
      `preview-comment: "${repository}" is not an owner/name repository`,
    );
  if (!Number.isInteger(issue) || issue <= 0)
    throw new Error(`preview-comment: "${issue}" is not a pull request number`);
  if (!token) throw new Error("preview-comment: GITHUB_TOKEN is not set");
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
  };
  /** @param {string} url @param {RequestInit} [init] */
  const call = async (url, init) => {
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

if (import.meta.main) {
  const env = process.env;
  try {
    for (const name of [
      "DOCS_PREVIEW_URL",
      "DEMO_PREVIEW_URL",
      "HEAD_SHA",
      "MERGE_SHA",
      "BASE_REF",
    ])
      if (!env[name]) throw new Error(`preview-comment: ${name} is not set`);
    const body = commentBody({
      headSha: env.HEAD_SHA ?? "",
      mergeSha: env.MERGE_SHA ?? "",
      baseRef: env.BASE_REF ?? "",
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
          worker: "bascik-streaming-test",
          url: env.DEMO_PREVIEW_URL ?? "",
          paths: ["/", "/catalog", "/catalog-stream"],
        },
      ],
    });
    const result = await upsertComment({
      apiUrl: env.GITHUB_API_URL,
      repository: env.GITHUB_REPOSITORY ?? "",
      issue: Number(env.PR_NUMBER),
      token: env.GITHUB_TOKEN ?? "",
      body,
    });
    console.log(`Preview comment ${result.action} (id ${result.id})`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
