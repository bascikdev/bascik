/**
 * CI stage 5 deploys both Cloudflare Workers (see DEPLOYMENT.md). These tests
 * cover the helper scripts in .github/scripts that the deploy jobs run, and
 * the shape of .github/workflows/ci.yml: five stages, each job waiting on
 * every job of the stage before it, and the Cloudflare token reaching only
 * deploy jobs that skip fork pull requests.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_DNS_LABEL_LENGTH,
  previewAlias,
} from "../../../.github/scripts/preview-alias.mjs";
import { previewAliasUrl } from "../../../.github/scripts/wrangler-preview-url.mjs";
import {
  parseChecks,
  smokeTest,
} from "../../../.github/scripts/smoke-test.mjs";
import {
  newestCommit,
  tipOf,
} from "../../../.github/scripts/newest-commit.mjs";
import {
  BOT_LOGIN,
  MARKER,
  commentBody,
  findStickyComment,
  upsertComment,
} from "../../../.github/scripts/preview-comment.mjs";

const repoDir = fileURLToPath(new URL("../../..", import.meta.url));
const WORKERS = ["bascik", "bascik-streaming-test"];
const ALIAS_SHAPE = /^[a-z](?:[a-z0-9-]*[a-z0-9])?$/;

describe("preview-alias", () => {
  it("uses a branch name that is already an alias as is", () => {
    expect(previewAlias("pre-release-20261026", WORKERS)).toBe(
      "pre-release-20261026",
    );
    expect(previewAlias("refs/heads/main", WORKERS)).toBe("main");
  });

  it("lowercases any other branch, turns every other character run into one dash, and appends a hash", () => {
    expect(previewAlias("Feature/Milk_Frother  v2", WORKERS)).toMatch(
      /^feature-milk-frother-v2-[0-9a-f]{6}$/,
    );
    expect(previewAlias("--fix//--trailing--", WORKERS)).toMatch(
      /^fix-trailing-[0-9a-f]{6}$/,
    );
  });

  it("gives branches that clean up to the same text different aliases", () => {
    const aliases = ["feature-x", "feature/x", "Feature_X", "feature--x"].map(
      (branch) => previewAlias(branch, WORKERS),
    );
    expect(aliases[0]).toBe("feature-x");
    expect(new Set(aliases).size).toBe(aliases.length);
    for (const alias of aliases) expect(alias).toMatch(ALIAS_SHAPE);
  });

  it("starts with a letter, as Wrangler requires", () => {
    expect(previewAlias("2026-10-30-release", WORKERS)).toMatch(
      /^b-2026-10-30-release-[0-9a-f]{6}$/,
    );
    expect(previewAlias("_123", WORKERS)).toMatch(/^b-123-[0-9a-f]{6}$/);
  });

  it("keeps <alias>-<longest worker> within one DNS label, with a hash so long branches stay distinct", () => {
    const long = `feature/${"milk-frother-".repeat(10)}`;
    const a = previewAlias(`${long}a`, WORKERS);
    const b = previewAlias(`${long}b`, WORKERS);
    expect(a).not.toBe(b);
    for (const alias of [a, b]) {
      expect(alias).toMatch(ALIAS_SHAPE);
      expect(`${alias}-bascik-streaming-test`.length).toBeLessThanOrEqual(
        MAX_DNS_LABEL_LENGTH,
      );
    }
    expect(a).toMatch(/^feature-milk-frother-milk-frother-[0-9a-f]{6}$/);
    // The cut lands on a dash here, which is dropped before the hash.
    expect(a).toHaveLength(MAX_DNS_LABEL_LENGTH - 1 - 21 - 1);
    // The same branch always gives the same alias, so Preview URLs are stable.
    expect(previewAlias(`${long}a`, WORKERS)).toBe(a);
    // Exactly at the limit is not shortened.
    const fits = "a".repeat(MAX_DNS_LABEL_LENGTH - 1 - 21);
    expect(previewAlias(fits, WORKERS)).toBe(fits);
    expect(previewAlias(`${fits}b`, WORKERS)).not.toBe(`${fits}b`);
  });

  it("never ends a shortened alias with a double dash", () => {
    for (let cut = 0; cut < 12; cut++) {
      const alias = previewAlias(`${"x".repeat(20 + cut)}-${"y".repeat(40)}`, [
        "bascik-streaming-test",
      ]);
      expect(alias).toMatch(ALIAS_SHAPE);
      expect(alias).not.toContain("--");
    }
  });

  it("rejects input it cannot turn into an alias, naming the fix", () => {
    expect(() => previewAlias("", WORKERS)).toThrow(/github\.head_ref/);
    expect(() => previewAlias("refs/pull/113/merge", WORKERS)).toThrow(
      /pull request ref/,
    );
    expect(() => previewAlias("///", WORKERS)).toThrow(/no letters or digits/);
    expect(() => previewAlias("main", [])).toThrow(/at least one Worker/);
    expect(() => previewAlias("main", ["x".repeat(50)])).toThrow(/no room/);
  });

  it("stays linear on long dash and slash runs", () => {
    const start = performance.now();
    const alias = previewAlias(`a${"-/".repeat(200_000)}b`, WORKERS);
    expect(alias).toMatch(/^a-b-[0-9a-f]{6}$/);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe("newest-commit", () => {
  const X = "1".repeat(40);
  const Y = "2".repeat(40);
  const lsRemote = [
    `${Y}\trefs/heads/main`,
    `${X}\trefs/heads/feature/refs/heads/main`,
    "",
  ].join("\n");

  it("matches the whole ref name, not a ref that only ends with it", () => {
    expect(tipOf(lsRemote, "refs/heads/main")).toBe(Y);
    expect(tipOf(lsRemote, "refs/heads/feature/refs/heads/main")).toBe(X);
    expect(tipOf(lsRemote, "refs/heads/feature")).toBeUndefined();
    expect(tipOf(`${Y}\trefs/heads/main\r\n`, "refs/heads/main")).toBe(Y);
  });

  it("deploys only the branch tip, so a late older run never replaces a newer deploy", () => {
    expect(newestCommit(lsRemote, "refs/heads/main", Y)).toEqual({
      newest: true,
    });
    expect(newestCommit(lsRemote, "refs/heads/main", Y.toUpperCase())).toEqual({
      newest: true,
    });
    const older = newestCommit(lsRemote, "refs/heads/main", X);
    expect(older.newest).toBe(false);
    expect(older.reason).toMatch(/moved on to 222222222222/);
    const deleted = newestCommit(lsRemote, "refs/heads/gone", X);
    expect(deleted).toEqual({
      newest: false,
      reason: "refs/heads/gone no longer exists",
    });
  });

  it("rejects a ref or SHA it cannot check, instead of answering false", () => {
    expect(() => newestCommit(lsRemote, "main", Y)).toThrow(/refs\/heads/);
    expect(() => newestCommit(lsRemote, "refs/pull/113/merge", Y)).toThrow(
      /not a branch ref/,
    );
    expect(() => newestCommit(lsRemote, "refs/heads/main", "")).toThrow(
      /full commit SHA/,
    );
    expect(() =>
      newestCommit(lsRemote, "refs/heads/main", Y.slice(0, 12)),
    ).toThrow(/full commit SHA/);
  });
});

describe("wrangler-preview-url", () => {
  const session = JSON.stringify({ type: "wrangler-session", version: 1 });
  const upload = (extra: object) =>
    JSON.stringify({ type: "version-upload", version: 1, ...extra });

  it("reads preview_alias_url from the last version-upload entry", () => {
    const text = [
      session,
      upload({ preview_alias_url: "https://old-bascik.example.workers.dev" }),
      "",
      upload({
        preview_url: "https://1a2b3c4d-bascik.example.workers.dev",
        preview_alias_url: "https://feature-bascik.example.workers.dev",
      }),
      "",
    ].join("\r\n");
    expect(previewAliasUrl(text)).toBe(
      "https://feature-bascik.example.workers.dev",
    );
  });

  it("says what is missing when the upload failed, had no alias, or the file is not ND-JSON", () => {
    expect(() => previewAliasUrl(session)).toThrow(/no version-upload entry/);
    expect(() => previewAliasUrl("")).toThrow(/no version-upload entry/);
    // What a --dry-run, or a Worker with preview_urls off, writes.
    expect(() =>
      previewAliasUrl(upload({ version_id: null, worker_name: "bascik" })),
    ).toThrow(/preview_urls: true/);
    expect(() =>
      previewAliasUrl(upload({ preview_alias_url: "http://x.workers.dev" })),
    ).toThrow(/unexpected/);
    expect(() => previewAliasUrl(`${session}\nUploaded bascik`)).toThrow(
      /line 2 .* not JSON/,
    );
  });
});

describe("smoke-test", () => {
  it("parses <path>=<status> checks and rejects anything else", () => {
    expect(parseChecks(["/=200", "/semantic-html=301", "/a=b=404"])).toEqual([
      { path: "/", status: 200 },
      { path: "/semantic-html", status: 301 },
      { path: "/a=b", status: 404 },
    ]);
    for (const bad of [
      "catalog=200",
      "/catalog",
      "/catalog=",
      "/x=99",
      "/x=2O0",
    ])
      expect(() => parseChecks([bad]), bad).toThrow(/<path>=<status>/);
    expect(() => parseChecks([])).toThrow(/at least one/);
  });

  it("checks status without following redirects, and retries until a path answers", async () => {
    let catalogHits = 0;
    const server = createServer((request, response) => {
      if (request.url === "/") return response.writeHead(200).end("ok");
      if (request.url === "/semantic-html")
        return response.writeHead(301, { location: "/" }).end();
      if (request.url === "/catalog")
        return response.writeHead(++catalogHits < 3 ? 404 : 200).end();
      response.writeHead(500).end();
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const log: string[] = [];
    try {
      const failures = await smokeTest(
        base,
        parseChecks(["/=200", "/semantic-html=301", "/catalog=200", "/x=200"]),
        { attempts: 3, delayMs: 0, log: (line) => log.push(line) },
      );
      expect(catalogHits).toBe(3);
      expect(failures).toEqual([`${base}/x: status 500, expected 200`]);
      expect(log.filter((line) => line.includes("retrying"))).toHaveLength(4);
    } finally {
      await new Promise((done) => server.close(done));
    }
  });

  it("reports network errors and rejects a base that is not an http(s) URL", async () => {
    const failures = await smokeTest(
      "https://preview.invalid",
      [{ path: "/", status: 200 }],
      {
        attempts: 2,
        delayMs: 0,
        log: () => {},
        fetchImpl: async () => {
          throw new Error("getaddrinfo ENOTFOUND preview.invalid");
        },
      },
    );
    expect(failures).toEqual([
      "https://preview.invalid/: getaddrinfo ENOTFOUND preview.invalid, expected 200",
    ]);
    await expect(smokeTest("", [{ path: "/", status: 200 }])).rejects.toThrow(
      /not a URL/,
    );
    await expect(
      smokeTest("ftp://bascik.dev", [{ path: "/", status: 200 }]),
    ).rejects.toThrow(/not an http/);
  });
});

describe("preview-comment", () => {
  const previews = [
    {
      label: "Docs",
      worker: "bascik",
      url: "https://feature-bascik.example.workers.dev/",
      paths: ["/", "/components"],
    },
    {
      label: "Demo",
      worker: "bascik-streaming-test",
      url: "https://feature-bascik-streaming-test.example.workers.dev",
      paths: ["/catalog"],
    },
  ];
  const commits = {
    headSha: "fc70e85a0123456789abcdef0123456789abcdef",
    mergeSha: "a18dc30c0123456789abcdef0123456789abcdef",
    baseRef: "main",
  };

  it("starts with the marker and lists every Preview URL and the commits it was built from", () => {
    const body = commentBody({ ...commits, previews, runUrl: "https://run" });
    expect(body.startsWith(MARKER)).toBe(true);
    // A pull request run builds the branch merged into its base, not the branch alone.
    expect(body).toContain(
      "Built from fc70e85a0123 merged into `main` (merge commit a18dc30c0123)",
    );
    expect(body).toContain(
      "[/components](https://feature-bascik.example.workers.dev/components)",
    );
    expect(body).toContain(
      "[/catalog](https://feature-bascik-streaming-test.example.workers.dev/catalog)",
    );
    expect(body).toContain("[Deploy run](https://run)");
  });

  it("refuses an empty URL, a non-https URL, a bad SHA, or a bad base branch", () => {
    const withUrl = (url: string) => [{ ...previews[0], url }];
    expect(() => commentBody({ ...commits, previews: withUrl("") })).toThrow(
      /https/,
    );
    expect(() =>
      commentBody({ ...commits, previews: withUrl("http://x.workers.dev") }),
    ).toThrow(/https/);
    expect(() =>
      commentBody({ ...commits, previews: withUrl("https://x|y") }),
    ).toThrow(/https/);
    expect(() =>
      commentBody({ ...commits, headSha: "main", previews }),
    ).toThrow(/SHA/);
    expect(() => commentBody({ ...commits, mergeSha: "", previews })).toThrow(
      /SHA/,
    );
    expect(() =>
      commentBody({ ...commits, baseRef: "main`<b>", previews }),
    ).toThrow(/branch name/);
    expect(() => commentBody({ ...commits, previews: [] })).toThrow(
      /no Preview/,
    );
  });

  it("only treats the bot's own marker comment as the sticky one", () => {
    const comments = [
      { id: 1, body: `Quoting it: ${MARKER}`, user: { login: BOT_LOGIN } },
      { id: 2, body: `${MARKER} spoof`, user: { login: "someone" } },
      { id: 3, body: null, user: null },
      { id: 4, body: `${MARKER}\nold`, user: { login: BOT_LOGIN } },
    ];
    expect(findStickyComment(comments)?.id).toBe(4);
    expect(findStickyComment(comments.slice(0, 3))).toBeUndefined();
  });

  /** A fake GitHub API holding `count` unrelated comments, plus the sticky one at `stickyAt`. */
  function fakeGitHub(count: number, stickyAt?: number) {
    const calls: { method: string; url: string; body?: string }[] = [];
    const comments = Array.from({ length: count }, (_, i) => ({
      id: i + 1,
      body: i === stickyAt ? `${MARKER}\nold` : "lgtm",
      user: { login: i === stickyAt ? BOT_LOGIN : "reviewer" },
    }));
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? "GET",
        url,
        body: init?.body as string | undefined,
      });
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer t0ken",
      );
      const page = Number(new URL(url).searchParams.get("page") ?? 1);
      const json =
        (init?.method ?? "GET") === "GET"
          ? comments.slice((page - 1) * 100, page * 100)
          : { id: 999 };
      return new Response(JSON.stringify(json), { status: 200 });
    }) as typeof fetch;
    return { calls, fetchImpl };
  }
  const input = {
    repository: "bascikdev/bascik",
    issue: 113,
    token: "t0ken",
    body: `${MARKER}\nnew`,
  };

  it("creates the comment when none exists, reading every page first", async () => {
    const { calls, fetchImpl } = fakeGitHub(150);
    const result = await upsertComment({ ...input, fetchImpl });
    expect(result).toEqual({ action: "created", id: 999 });
    expect(calls.map((call) => call.method)).toEqual(["GET", "GET", "POST"]);
    expect(calls[2].url).toBe(
      "https://api.github.com/repos/bascikdev/bascik/issues/113/comments",
    );
    expect(JSON.parse(calls[2].body!)).toEqual({ body: input.body });
  });

  it("updates the sticky comment found on a later page", async () => {
    const { calls, fetchImpl } = fakeGitHub(150, 120);
    const result = await upsertComment({ ...input, fetchImpl });
    expect(result).toEqual({ action: "updated", id: 121 });
    expect(calls.map((call) => call.method)).toEqual(["GET", "GET", "PATCH"]);
    expect(calls[2].url).toBe(
      "https://api.github.com/repos/bascikdev/bascik/issues/comments/121",
    );
  });

  it("fails on an API error or bad input without printing the token", async () => {
    const denied = (async () =>
      new Response("{}", { status: 403 })) as typeof fetch;
    const error = await upsertComment({ ...input, fetchImpl: denied }).catch(
      (caught: Error) => caught,
    );
    expect(String(error)).toMatch(/GET .*comments answered 403/);
    expect(String(error)).not.toContain("t0ken");
    await expect(upsertComment({ ...input, token: "" })).rejects.toThrow(
      /GITHUB_TOKEN/,
    );
    await expect(upsertComment({ ...input, issue: NaN })).rejects.toThrow(
      /pull request number/,
    );
    await expect(
      upsertComment({ ...input, repository: "bascik" }),
    ).rejects.toThrow(/owner\/name/);
  });
});

interface CiJob {
  stage: number;
  needs: string[];
  body: string[];
}

/** Each job's stage (from the `# ── Stage N:` headers), needs, and body lines, keyed by job id. */
function ciStages(workflow: string): Map<string, CiJob> {
  const jobs = new Map<string, CiJob>();
  const lines = workflow.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  let stage = 0;
  let current: CiJob | undefined;
  let inNeeds = false;
  for (const line of start < 0 ? [] : lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const header = /^ {2}# ── Stage (\d+):/.exec(line);
    if (header) {
      stage = Number(header[1]);
      continue;
    }
    const job = /^ {2}([\w-]+):\s*$/.exec(line);
    if (job) {
      jobs.set(job[1], (current = { stage, needs: [], body: [] }));
      inNeeds = false;
      continue;
    }
    if (!current || line.trim().startsWith("#")) continue;
    current.body.push(line);
    if (/^ {4}needs:/.test(line)) inNeeds = true;
    else if (/^ {4}\S/.test(line)) inNeeds = false;
    if (inNeeds)
      for (const need of line.replace(/^ {4}needs:/, "").matchAll(/[\w-]+/g))
        current.needs.push(need[0]);
  }
  return jobs;
}

/** Every job `id` waits on, directly or through other jobs. */
function allNeeds(jobs: Map<string, CiJob>, id: string): Set<string> {
  const seen = new Set<string>();
  const pending = [...(jobs.get(id)?.needs ?? [])];
  while (pending.length) {
    const next = pending.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    pending.push(...(jobs.get(next)?.needs ?? []));
  }
  return seen;
}

const FORK_GUARD =
  "github.event.pull_request.head.repo.full_name == github.repository";

describe("CI stages and the deploy stage", () => {
  const jobs = ciStages(
    readFileSync(join(repoDir, ".github/workflows/ci.yml"), "utf8"),
  );

  it("parses stage headers, jobs and needs, skipping comments", () => {
    const parsed = ciStages(
      [
        "jobs:",
        "  # ── Stage 1: a",
        "  a:",
        "    steps: []",
        "  # ── Stage 2: b",
        "  b:",
        "    # needs: [nope]",
        "    needs:",
        "      [",
        "        a,",
        "      ]",
        "    steps: []",
        "env: {}",
      ].join("\r\n"),
    );
    expect([...parsed].map(([id, job]) => [id, job.stage, job.needs])).toEqual([
      ["a", 1, []],
      ["b", 2, ["a"]],
    ]);
  });

  it("runs five stages in order, every job under a stage header", () => {
    const stages = [...jobs.values()].map((job) => job.stage);
    expect(stages.filter((stage) => stage === 0)).toEqual([]);
    expect([...new Set(stages)]).toEqual([1, 2, 3, 4, 5]);
  });

  it("makes every job wait on every job of the stage before it", () => {
    const missing: string[] = [];
    for (const [id, job] of jobs) {
      if (job.stage === 1) {
        if (job.needs.length) missing.push(`${id}: stage 1 needs nothing`);
        continue;
      }
      for (const need of job.needs) {
        const needed = jobs.get(need);
        if (!needed) missing.push(`${id}: needs unknown job ${need}`);
        else if (needed.stage !== job.stage - 1 && needed.stage !== job.stage)
          missing.push(`${id}: needs ${need} from stage ${needed.stage}`);
      }
      // A job may wait on the previous stage through a job of its own stage
      // (the Preview comment waits on both deploy jobs).
      const waits = allNeeds(jobs, id);
      for (const [other, otherJob] of jobs)
        if (otherJob.stage === job.stage - 1 && !waits.has(other))
          missing.push(`${id} (stage ${job.stage}) does not wait on ${other}`);
    }
    expect(missing).toEqual([]);
  });

  it("deploys both Workers in stage 5, previews on pull requests and production on main", () => {
    const stage5 = [...jobs].filter(([, job]) => job.stage === 5);
    expect(stage5.map(([id]) => id).sort()).toEqual([
      "deploy-demo",
      "deploy-docs",
      "preview-comment",
    ]);
    for (const id of ["deploy-docs", "deploy-demo"]) {
      const body = jobs.get(id)!.body.join("\n");
      expect(body, id).toMatch(
        /wrangler versions upload .*--preview-alias "\$ALIAS"/,
      );
      expect(body, id).toMatch(/yarn wrangler deploy\b/);
      expect(body, id).toContain("WRANGLER_OUTPUT_FILE_PATH");
      expect(body, id).toContain(".github/scripts/smoke-test.mjs");
      expect(body, id).toMatch(
        /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/,
      );
    }
    expect(jobs.get("deploy-docs")!.body.join("\n")).toMatch(/fetch-depth: 0/);
  });

  it("runs Wrangler only when the commit is still the newest on its branch", () => {
    for (const id of ["deploy-docs", "deploy-demo"]) {
      const lines = jobs.get(id)!.body;
      const check = lines.findIndex((line) =>
        line.includes(".github/scripts/newest-commit.mjs"),
      );
      expect(check, id).toBeGreaterThan(0);
      // Every step that uploads, deploys or smoke-tests is gated on it.
      const gated = lines
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => /^ {6}- name: (Upload|Deploy|Smoke)/.test(line));
      expect(gated.length, id).toBe(4);
      for (const { line, index } of gated) {
        expect(index, `${id}: ${line}`).toBeGreaterThan(check);
        expect(lines[index + 1], `${id}: ${line}`).toMatch(
          /^ {8}if: .*&& steps\.newest\.outputs\.newest == 'true'$/,
        );
      }
    }
    const comment = jobs.get("preview-comment")!.body.join("\n");
    expect(comment).toContain("needs.deploy-docs.outputs.preview-url != ''");
    expect(comment).toContain("needs.deploy-demo.outputs.preview-url != ''");
    expect(comment).toContain("MERGE_SHA: ${{ github.sha }}");
  });

  it("gives the Cloudflare token only to stage 5 jobs that skip fork pull requests", () => {
    const leaks: string[] = [];
    for (const [id, job] of jobs) {
      const body = job.body.join("\n");
      const usesToken = body.includes("secrets.CLOUDFLARE_API_TOKEN");
      const writesPr = /pull-requests: write/.test(body);
      if (!usesToken && !writesPr) continue;
      if (job.stage !== 5) leaks.push(`${id}: not a stage 5 job`);
      if (!body.includes(FORK_GUARD)) leaks.push(`${id}: no fork guard`);
      // The token goes to the Wrangler steps, never the whole job.
      if (/^ {4}env:/m.test(body)) leaks.push(`${id}: job-level env`);
    }
    expect(leaks).toEqual([]);
    expect(
      [...jobs].filter(([, job]) =>
        job.body.join("\n").includes("secrets.CLOUDFLARE_API_TOKEN"),
      ).length,
    ).toBe(2);
  });
});
