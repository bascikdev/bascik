/**
 * .github/scripts/preview-comment-on-open.mjs reruns CI's "Publish Preview
 * URLs" job when a pull request opens after the branch's push run already
 * posted (to no pull request). These tests drive it against a fake GitHub API
 * and check the workflow that runs it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  COMMENT_JOB,
  choosePreviewRun,
  run,
  type WorkflowJob,
  type WorkflowRun,
} from "../../../.github/scripts/preview-comment-on-open.mjs";

const repoDir = fileURLToPath(new URL("../../..", import.meta.url));
const SHA = (n: number) => String(n).repeat(40).slice(0, 40);

const pushRun = (
  id: number,
  status: string,
  conclusion: string | null = status === "completed" ? "success" : null,
): WorkflowRun => ({ id, status, conclusion, head_sha: SHA(id % 10) });

const commentJob = (
  id: number,
  status: string,
  conclusion: string | null = status === "completed" ? "success" : null,
): WorkflowJob => ({ id, name: COMMENT_JOB, status, conclusion });

describe("choosePreviewRun", () => {
  it("reruns the newest finished run whose comment job succeeded", () => {
    const choice = choosePreviewRun([
      {
        run: pushRun(3, "completed", "failure"),
        job: commentJob(30, "completed", "skipped"),
      },
      { run: pushRun(2, "completed"), job: commentJob(20, "completed") },
      { run: pushRun(1, "completed"), job: commentJob(10, "completed") },
    ]);
    expect(choice).toMatchObject({ action: "rerun", job: { id: 20 } });
  });

  it("leaves a run that has not reached its comment job to post by itself", () => {
    for (const job of [
      undefined,
      commentJob(30, "queued"),
      commentJob(30, "in_progress"),
    ])
      expect(
        choosePreviewRun([
          { run: pushRun(3, "in_progress"), job },
          { run: pushRun(2, "completed"), job: commentJob(20, "completed") },
        ]).action,
      ).toBe("none");
  });

  it("waits for a running run whose comment job already posted", () => {
    expect(
      choosePreviewRun([
        { run: pushRun(3, "in_progress"), job: commentJob(30, "completed") },
      ]),
    ).toMatchObject({ action: "wait", job: { id: 30 } });
  });

  it("does nothing when no run published Previews", () => {
    expect(choosePreviewRun([]).action).toBe("none");
    expect(
      choosePreviewRun([
        {
          run: pushRun(1, "completed", "failure"),
          job: commentJob(10, "completed", "skipped"),
        },
        { run: pushRun(2, "completed", "cancelled"), job: undefined },
      ]).action,
    ).toBe("none");
  });
});

/** A fake GitHub API that answers the run list, each run's jobs, and reruns. */
function fakeGitHub(
  runs: { run: WorkflowRun; job?: WorkflowJob }[],
  later: Record<number, WorkflowRun[]> = {},
) {
  const calls: string[] = [];
  const polls = new Map<number, number>();
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const { pathname, search } = new URL(url);
    calls.push(`${init?.method ?? "GET"} ${pathname}${search}`);
    const json = (body: unknown, status = 200) =>
      new Response(body === undefined ? "" : JSON.stringify(body), { status });
    if (pathname.endsWith("/actions/workflows/ci.yml/runs"))
      return json({ workflow_runs: runs.map(({ run: r }) => r) });
    const jobs = /\/actions\/runs\/(\d+)\/jobs$/.exec(pathname);
    if (jobs) {
      const entry = runs.find(({ run: r }) => r.id === Number(jobs[1]));
      return json({ jobs: entry?.job ? [entry.job] : [] });
    }
    const one = /\/actions\/runs\/(\d+)$/.exec(pathname);
    if (one) {
      const id = Number(one[1]);
      const n = polls.get(id) ?? 0;
      polls.set(id, n + 1);
      const sequence = later[id] ?? [];
      return json(sequence[Math.min(n, sequence.length - 1)]);
    }
    if (
      /\/actions\/jobs\/\d+\/rerun$/.test(pathname) &&
      init?.method === "POST"
    )
      return json(undefined, 201);
    return json({ message: "Not Found" }, 404);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const ENV = {
  GITHUB_TOKEN: "test-token",
  GITHUB_REPOSITORY: "bascikdev/bascik",
  BRANCH: "release-1.1.0",
};

describe("run", () => {
  it("reruns the comment job of the push run that posted before the pull request existed", async () => {
    const { calls, fetchImpl } = fakeGitHub([
      { run: pushRun(2, "completed"), job: commentJob(20, "completed") },
    ]);
    const lines: string[] = [];
    await expect(
      run(ENV, { fetchImpl, log: (line) => lines.push(line) }),
    ).resolves.toEqual({ rerun: 20 });
    expect(calls[0]).toBe(
      "GET /repos/bascikdev/bascik/actions/workflows/ci.yml/runs?branch=release-1.1.0&event=push&per_page=10",
    );
    expect(calls.at(-1)).toBe(
      "POST /repos/bascikdev/bascik/actions/jobs/20/rerun",
    );
    expect(lines.join("\n")).toContain("push run 2");
  });

  it("encodes the branch name in the run query", async () => {
    const { calls, fetchImpl } = fakeGitHub([]);
    await run({ ...ENV, BRANCH: "feat/a&b" }, { fetchImpl, log: () => {} });
    expect(calls[0]).toContain("branch=feat%2Fa%26b&");
  });

  it("reruns nothing while the newest run is still on its way to the comment job", async () => {
    const { calls, fetchImpl } = fakeGitHub([
      { run: pushRun(3, "in_progress") },
      { run: pushRun(2, "completed"), job: commentJob(20, "completed") },
    ]);
    const result = await run(ENV, { fetchImpl, log: () => {} });
    expect(result.rerun).toBeUndefined();
    expect(calls.some((call) => call.startsWith("POST"))).toBe(false);
  });

  it("waits for a running run to finish, then reruns its comment job", async () => {
    const { calls, fetchImpl } = fakeGitHub(
      [{ run: pushRun(3, "in_progress"), job: commentJob(30, "completed") }],
      { 3: [pushRun(3, "in_progress"), pushRun(3, "completed")] },
    );
    const slept: number[] = [];
    await expect(
      run(ENV, {
        fetchImpl,
        log: () => {},
        sleep: async (ms) => void slept.push(ms),
        pollMs: 5,
      }),
    ).resolves.toEqual({ rerun: 30 });
    expect(slept).toEqual([5, 5]);
    expect(calls.at(-1)).toBe(
      "POST /repos/bascikdev/bascik/actions/jobs/30/rerun",
    );
  });

  it("fails, naming the job to rerun by hand, when the run never finishes", async () => {
    const { fetchImpl } = fakeGitHub(
      [{ run: pushRun(3, "in_progress"), job: commentJob(30, "completed") }],
      { 3: [pushRun(3, "in_progress")] },
    );
    await expect(
      run(ENV, {
        fetchImpl,
        log: () => {},
        sleep: async () => {},
        pollMs: 10,
        maxWaitMs: 30,
      }),
    ).rejects.toThrow(/push run 3 did not finish.*Publish Preview URLs/);
  });

  it("names the request that failed", async () => {
    const fetchImpl = (async () =>
      new Response("{}", { status: 403 })) as unknown as typeof fetch;
    await expect(run(ENV, { fetchImpl, log: () => {} })).rejects.toThrow(
      "GET /repos/bascikdev/bascik/actions/workflows/ci.yml/runs answered 403",
    );
  });

  it("refuses a missing token, repository or branch", async () => {
    const { fetchImpl } = fakeGitHub([]);
    await expect(
      run({ ...ENV, GITHUB_TOKEN: "" }, { fetchImpl }),
    ).rejects.toThrow(/GITHUB_TOKEN/);
    await expect(
      run({ ...ENV, GITHUB_REPOSITORY: "nope" }, { fetchImpl }),
    ).rejects.toThrow(/owner\/name/);
    await expect(run({ ...ENV, BRANCH: " " }, { fetchImpl })).rejects.toThrow(
      /BRANCH/,
    );
  });
});

describe("preview-comment.yml", () => {
  const workflow = readFileSync(
    `${repoDir}.github/workflows/preview-comment.yml`,
    "utf8",
  );
  const ci = readFileSync(`${repoDir}.github/workflows/ci.yml`, "utf8");

  it("runs on an opened or reopened same-repository pull request with actions: write only", () => {
    expect(workflow).toMatch(/pull_request:\n {4}types: \[opened, reopened\]/);
    expect(workflow).toMatch(/^permissions: \{\}$/m);
    expect(workflow).toContain(
      "if: github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(workflow).toMatch(
      /permissions:\n {6}actions: write\n {6}contents: read\n/,
    );
    expect(workflow).not.toMatch(/secrets\.(?!GITHUB_TOKEN)/);
  });

  it("reruns the job ci.yml names Publish Preview URLs, whose template rows outlive a day", () => {
    expect(ci).toContain(`name: ${COMMENT_JOB}\n`);
    expect(ci).toMatch(
      /name: template-preview-\$\{\{ matrix\.slug \}\}[\s\S]*?retention-days: 7/,
    );
    expect(workflow).toContain(
      "node .github/scripts/preview-comment-on-open.mjs",
    );
  });
});
