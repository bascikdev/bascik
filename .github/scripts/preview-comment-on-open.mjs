#!/usr/bin/env node
// Posts the branch Previews on a pull request opened after they deployed.
//
// CI's push run uploads the Previews and, in its last job (Publish Preview
// URLs), comments them on the branch's open pull request. A pull request
// opened after that job finished got no comment: the job had found none and
// wrote the summary only. When a pull request is opened or reopened, this
// finds the branch's newest push run whose comment job succeeded and reruns
// that job, which now finds the pull request. The comment job edits its one
// marked comment, so a rerun never adds a second.
//
// A run still on its way to the comment job is left alone: it will find the
// pull request itself. A run whose comment job finished while other jobs still
// run cannot be rerun yet (GitHub refuses a rerun inside a running run), so
// this waits for that run to finish first.
//
// Usage (in CI): node .github/scripts/preview-comment-on-open.mjs
// Environment: GITHUB_TOKEN (actions: write), GITHUB_REPOSITORY (owner/name),
// BRANCH (the pull request's head branch), and optionally GITHUB_API_URL.

export const WORKFLOW_FILE = "ci.yml";
export const COMMENT_JOB = "Publish Preview URLs";

/** How many of the branch's newest push runs are searched. */
export const RUNS_SEARCHED = 10;

const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;

/**
 * @typedef {{ id: number; status: string; conclusion: string | null; head_sha: string; html_url?: string }} WorkflowRun
 * @typedef {{ id: number; name: string; status: string; conclusion: string | null }} WorkflowJob
 * @typedef {(url: string, init?: RequestInit) => Promise<any>} Call
 */

/**
 * @param {{ token: string; fetchImpl?: typeof fetch }} input
 * @returns {Call}
 */
function githubClient({ token, fetchImpl = fetch }) {
  if (!token)
    throw new Error("preview-comment-on-open: GITHUB_TOKEN is not set");
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
        `preview-comment-on-open: ${init?.method ?? "GET"} ${new URL(url).pathname} answered ${response.status}`,
      );
    // A rerun answers 201 with an empty body.
    const text = await response.text();
    return text ? JSON.parse(text) : undefined;
  };
}

/**
 * What to do with the branch's push runs, newest first, each with its comment
 * job (undefined when the run has not created it yet).
 *
 * @param {readonly { run: WorkflowRun; job: WorkflowJob | undefined }[]} runs
 * @returns {{ action: "rerun"; run: WorkflowRun; job: WorkflowJob } | { action: "wait"; run: WorkflowRun; job: WorkflowJob } | { action: "none"; reason: string }}
 */
export function choosePreviewRun(runs) {
  for (const { run, job } of runs) {
    const jobDone = job?.status === "completed";
    if (run.status !== "completed") {
      // Still on its way to the comment job, or in it: it sees the pull request.
      if (!jobDone)
        return {
          action: "none",
          reason: `push run ${run.id} (${run.head_sha.slice(0, 12)}) has not posted yet; its comment job will find the pull request`,
        };
      if (job.conclusion === "success") return { action: "wait", run, job };
      continue;
    }
    if (job && jobDone && job.conclusion === "success")
      return { action: "rerun", run, job };
  }
  return {
    action: "none",
    reason: `none of the branch's newest ${RUNS_SEARCHED} push runs published Previews`,
  };
}

/**
 * @param {Call} call
 * @param {string} base
 * @param {WorkflowRun} run
 * @returns {Promise<WorkflowJob | undefined>}
 */
async function commentJobOf(call, base, run) {
  /** @type {{ jobs: WorkflowJob[] }} */
  const { jobs } = await call(
    `${base}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
  );
  return jobs.find((job) => job.name === COMMENT_JOB);
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {{ fetchImpl?: typeof fetch; log?: (line: string) => void; sleep?: (ms: number) => Promise<void>; pollMs?: number; maxWaitMs?: number }} [options]
 * @returns {Promise<{ rerun: number | undefined; reason?: string }>} The rerun job's id, or why nothing was rerun.
 */
export async function run(
  env,
  {
    fetchImpl,
    log = console.log,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    pollMs = 30_000,
    maxWaitMs = 30 * 60_000,
  } = {},
) {
  const repository = env.GITHUB_REPOSITORY ?? "";
  if (!REPOSITORY.test(repository))
    throw new Error(
      `preview-comment-on-open: "${repository}" is not an owner/name repository`,
    );
  const branch = env.BRANCH ?? "";
  if (branch.trim() === "")
    throw new Error("preview-comment-on-open: BRANCH is not set");
  const call = githubClient({ token: env.GITHUB_TOKEN ?? "", fetchImpl });
  const base = `${env.GITHUB_API_URL ?? "https://api.github.com"}/repos/${repository}`;

  /** @type {{ workflow_runs: WorkflowRun[] }} */
  const { workflow_runs } = await call(
    `${base}/actions/workflows/${WORKFLOW_FILE}/runs?branch=${encodeURIComponent(branch)}&event=push&per_page=${RUNS_SEARCHED}`,
  );
  const runs = [];
  for (const pushRun of workflow_runs)
    runs.push({ run: pushRun, job: await commentJobOf(call, base, pushRun) });
  let choice = choosePreviewRun(runs);
  if (choice.action === "none") {
    log(choice.reason);
    return { rerun: undefined, reason: choice.reason };
  }

  if (choice.action === "wait") {
    const { run: waiting, job } = choice;
    log(
      `push run ${waiting.id} posted before the pull request opened; waiting for it to finish to rerun its comment job`,
    );
    let waited = 0;
    for (;;) {
      if (waited >= maxWaitMs) {
        const reason = `push run ${waiting.id} did not finish within ${Math.round(maxWaitMs / 60_000)} minutes; rerun its "${COMMENT_JOB}" job by hand`;
        throw new Error(`preview-comment-on-open: ${reason}`);
      }
      await sleep(pollMs);
      waited += pollMs;
      /** @type {WorkflowRun} */
      const latest = await call(`${base}/actions/runs/${waiting.id}`);
      if (latest.status === "completed") {
        choice = { action: "rerun", run: latest, job };
        break;
      }
    }
  }

  await call(`${base}/actions/jobs/${choice.job.id}/rerun`, {
    method: "POST",
  });
  log(
    `Reran "${COMMENT_JOB}" (job ${choice.job.id}) of push run ${choice.run.id} (${choice.run.head_sha.slice(0, 12)}) so it comments on the pull request`,
  );
  return { rerun: choice.job.id };
}

if (import.meta.main) {
  try {
    await run(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
