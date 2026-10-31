/**
 * CI stage 5 deploys both Cloudflare Workers (see DEPLOYMENT.md). These tests
 * cover the helper scripts in .github/scripts that the deploy jobs run, and
 * the shape of .github/workflows/ci.yml: five stages, each job waiting on
 * every job of the stage before it, which runs start which jobs and steps
 * (evaluated from the workflow's own `if:` conditions for a push to main, a
 * branch push, a tag, a same-repo pull request and a fork's), and the
 * Cloudflare token reaching only the stage 5 Wrangler steps.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
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
import { mergedPullRequest } from "../../../.github/scripts/merged-pull-request.mjs";
import {
  BOT_LOGIN,
  MARKER,
  commentBody,
  findOpenPullRequests,
  findStickyComment,
  run,
  upsertComment,
} from "../../../.github/scripts/preview-comment.mjs";

const repoDir = fileURLToPath(new URL("../../..", import.meta.url));
const WORKERS = ["bascik", "cloudflare-adapter"];
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
      expect(`${alias}-cloudflare-adapter`.length).toBeLessThanOrEqual(
        MAX_DNS_LABEL_LENGTH,
      );
    }
    // The budget comes from the longest Worker name, so renaming a Worker never needs this test changed.
    const budget =
      MAX_DNS_LABEL_LENGTH - 1 - Math.max(...WORKERS.map((w) => w.length));
    expect(a).toMatch(
      /^feature-milk-frother-milk-frother-[a-z0-9-]*[0-9a-f]{6}$/,
    );
    expect(a).not.toMatch(/--/);
    // A cut that lands on a dash drops it before the hash, so the alias can be one short of the budget.
    expect(a.length).toBeLessThanOrEqual(budget);
    expect(a.length).toBeGreaterThanOrEqual(budget - 1);
    // The same branch always gives the same alias, so Preview URLs are stable.
    expect(previewAlias(`${long}a`, WORKERS)).toBe(a);
    // Exactly at the limit is not shortened.
    const fits = "a".repeat(budget);
    expect(previewAlias(fits, WORKERS)).toBe(fits);
    expect(previewAlias(`${fits}b`, WORKERS)).not.toBe(`${fits}b`);
  });

  it("never ends a shortened alias with a double dash", () => {
    for (let cut = 0; cut < 12; cut++) {
      const alias = previewAlias(`${"x".repeat(20 + cut)}-${"y".repeat(40)}`, [
        "cloudflare-adapter",
      ]);
      expect(alias).toMatch(ALIAS_SHAPE);
      expect(alias).not.toContain("--");
    }
  });

  it("rejects input it cannot turn into an alias, naming the fix", () => {
    expect(() => previewAlias("", WORKERS)).toThrow(/github\.ref_name/);
    expect(() => previewAlias("refs/pull/113/merge", WORKERS)).toThrow(
      /pull request ref/,
    );
    expect(() => previewAlias("refs/tags/v1.0.0", WORKERS)).toThrow(/is a tag/);
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

describe("merged-pull-request", () => {
  const SHA = "3".repeat(40);
  const pull = (number: number, merged: boolean, base = "main") => ({
    number,
    state: merged ? "closed" : "open",
    merged_at: merged ? "2026-10-31T12:00:00Z" : null,
    base: { ref: base },
  });

  it("finds the pull request merged into main that the commit came from", () => {
    expect(mergedPullRequest([pull(7, false), pull(12, true)], SHA)).toBe(12);
    expect(mergedPullRequest([pull(12, true)], SHA.toUpperCase())).toBe(12);
  });

  it("refuses a commit no merged pull request put on main, naming the commit and the emergency path", () => {
    for (const pulls of [
      [],
      [pull(7, false)],
      [pull(8, true, "pre-release-20261030")],
    ])
      expect(() => mergedPullRequest(pulls, SHA)).toThrow(
        /333333333333 did not come from a pull request merged into main.*DEPLOYMENT\.md, "Manual Deploy in an Emergency"/s,
      );
    expect(() => mergedPullRequest([pull(7, false)], SHA)).toThrow(
      /#7 \(open\)/,
    );
    expect(() =>
      mergedPullRequest([pull(8, true, "pre-release-20261030")], SHA),
    ).toThrow(/#8 \(merged into pre-release-20261030\)/);
  });

  it("misuse: rejects an API error body or a bad SHA instead of reading it as no pull request", () => {
    expect(() =>
      mergedPullRequest({ message: "Bad credentials", status: "401" }, SHA),
    ).toThrow(/did not return a list of pull requests.*Bad credentials/);
    expect(() => mergedPullRequest([pull(12, true)], "")).toThrow(
      /full commit SHA/,
    );
    expect(() => mergedPullRequest([pull(12, true)], SHA.slice(0, 7))).toThrow(
      /full commit SHA/,
    );
  });

  it("reads the gh api output from a file and fails the step with an ::error:: line", () => {
    const dir = mkdtempSync(join(tmpdir(), "bascik-merged-pr-"));
    try {
      const script = join(repoDir, ".github/scripts/merged-pull-request.mjs");
      const file = join(dir, "pulls.json");
      const run = () =>
        spawnSync(process.execPath, [script, SHA, file], { encoding: "utf8" });
      writeFileSync(file, JSON.stringify([pull(12, true)]));
      const merged = run();
      expect(merged.status).toBe(0);
      expect(merged.stdout).toMatch(/pull request #12/);
      writeFileSync(file, JSON.stringify([pull(7, false)]));
      const direct = run();
      expect(direct.status).toBe(1);
      expect(direct.stderr).toMatch(/^::error::.*333333333333/m);
      writeFileSync(file, "");
      const empty = run();
      expect(empty.status).toBe(1);
      expect(empty.stderr).toMatch(/::error::.*not JSON/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
      worker: "cloudflare-adapter",
      url: "https://feature-cloudflare-adapter.example.workers.dev",
      paths: ["/catalog"],
    },
  ];
  const built = {
    sha: "fc70e85a0123456789abcdef0123456789abcdef",
    branch: "feature/milk-frother",
  };

  it("starts with the marker and lists every Preview URL, the branch, and the commit it was built from", () => {
    const body = commentBody({ ...built, previews, runUrl: "https://run" });
    expect(body.startsWith(MARKER)).toBe(true);
    // A push run builds the branch commit itself, not a merge with main.
    expect(body).toContain(
      "Built from fc70e85a0123 on `feature/milk-frother`.",
    );
    expect(body).not.toContain("merge");
    expect(body).toContain(
      "[/components](https://feature-bascik.example.workers.dev/components)",
    );
    expect(body).toContain(
      "[/catalog](https://feature-cloudflare-adapter.example.workers.dev/catalog)",
    );
    expect(body).toContain("[Deploy run](https://run)");
    // Git allows a backtick in a branch name; it must not end the code span.
    expect(commentBody({ ...built, branch: "odd`name", previews })).toContain(
      "on `odd'name`.",
    );
  });

  it("refuses an empty URL, a non-https URL, a bad SHA, or a missing branch", () => {
    const withUrl = (url: string) => [{ ...previews[0], url }];
    expect(() => commentBody({ ...built, previews: withUrl("") })).toThrow(
      /https/,
    );
    expect(() =>
      commentBody({ ...built, previews: withUrl("http://x.workers.dev") }),
    ).toThrow(/https/);
    expect(() =>
      commentBody({ ...built, previews: withUrl("https://x|y") }),
    ).toThrow(/https/);
    expect(() => commentBody({ ...built, sha: "main", previews })).toThrow(
      /SHA/,
    );
    expect(() => commentBody({ ...built, sha: "", previews })).toThrow(/SHA/);
    expect(() => commentBody({ ...built, branch: " ", previews })).toThrow(
      /branch name/,
    );
    expect(() => commentBody({ ...built, previews: [] })).toThrow(/no Preview/);
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

  /**
   * A fake GitHub API holding `count` unrelated comments on every pull
   * request, plus the sticky one at `stickyAt`, and `pulls` as the open pull
   * requests of any branch.
   */
  function fakeGitHub(
    count: number,
    stickyAt?: number,
    pulls: { number: number; head?: { repo: { full_name: string } } }[] = [],
  ) {
    const calls: { method: string; url: string; body?: string }[] = [];
    const comments = Array.from({ length: count }, (_, i) => ({
      id: i + 1,
      body: i === stickyAt ? `${MARKER}\nold` : "lgtm",
      user: { login: i === stickyAt ? BOT_LOGIN : "reviewer" },
    }));
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body as string | undefined });
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer t0ken",
      );
      const parsed = new URL(url);
      const page = Number(parsed.searchParams.get("page") ?? 1);
      const json =
        method !== "GET"
          ? { id: 999 }
          : parsed.pathname.endsWith("/pulls")
            ? pulls
            : comments.slice((page - 1) * 100, page * 100);
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

  it("finds the branch's open pull requests in this repository only", async () => {
    const { calls, fetchImpl } = fakeGitHub(0, undefined, [
      { number: 120, head: { repo: { full_name: "bascikdev/bascik" } } },
      { number: 113, head: { repo: { full_name: "bascikdev/bascik" } } },
      // GitHub filters by owner already; a stray fork entry is still ignored.
      { number: 7, head: { repo: { full_name: "someone/bascik" } } },
    ]);
    const found = await findOpenPullRequests({
      repository: "bascikdev/bascik",
      branch: "feature/milk frother",
      token: "t0ken",
      fetchImpl,
    });
    expect(found).toEqual([113, 120]);
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/repos/bascikdev/bascik/pulls");
    expect(url.searchParams.get("head")).toBe("bascikdev:feature/milk frother");
    expect(url.searchParams.get("state")).toBe("open");
    await expect(
      findOpenPullRequests({
        repository: "bascikdev/bascik",
        branch: "",
        token: "t0ken",
        fetchImpl,
      }),
    ).rejects.toThrow(/branch name/);
  });

  const env = {
    GITHUB_TOKEN: "t0ken",
    GITHUB_REPOSITORY: "bascikdev/bascik",
    GITHUB_STEP_SUMMARY: "/summary.md",
    BRANCH: "feature/milk-frother",
    // github.sha of a push run: the branch commit CI built and tested.
    SHA: "a18dc30c0123456789abcdef0123456789abcdef",
    RUN_URL: "https://github.com/bascikdev/bascik/actions/runs/1",
    DOCS_PREVIEW_URL: "https://feature-bascik.example.workers.dev",
    DEMO_PREVIEW_URL: "https://feature-cloudflare-adapter.example.workers.dev",
  };

  it("writes both URLs to the job summary and succeeds without posting when the branch has no pull request", async () => {
    const { calls, fetchImpl } = fakeGitHub(0);
    const summary: [string, string][] = [];
    const log: string[] = [];
    const result = await run(env, {
      fetchImpl,
      log: (line) => log.push(line),
      appendSummary: (path, text) => summary.push([path, text]),
    });
    expect(result.comments).toEqual([]);
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
    expect(summary).toHaveLength(1);
    expect(summary[0][0]).toBe("/summary.md");
    expect(summary[0][1]).toContain(env.DOCS_PREVIEW_URL);
    expect(summary[0][1]).toContain(env.DEMO_PREVIEW_URL);
    expect(summary[0][1]).toContain("Built from a18dc30c0123 on");
    expect(log.join("\n")).toMatch(/No open pull request/);
  });

  it("names github.sha as the built commit in the comment on the branch's pull request", async () => {
    const { calls, fetchImpl } = fakeGitHub(3, 1, [
      { number: 113, head: { repo: { full_name: "bascikdev/bascik" } } },
    ]);
    const result = await run(env, {
      fetchImpl,
      log: () => {},
      appendSummary: () => {},
    });
    expect(result.comments).toEqual([{ pr: 113, action: "updated", id: 2 }]);
    const patch = calls.find((call) => call.method === "PATCH")!;
    const { body } = JSON.parse(patch.body!) as { body: string };
    expect(body).toContain(`Built from ${env.SHA.slice(0, 12)} on`);
    expect(body).toBe(result.body);
  });

  it("names the missing variable instead of posting a half-empty comment", async () => {
    for (const name of [
      "SHA",
      "BRANCH",
      "DOCS_PREVIEW_URL",
      "DEMO_PREVIEW_URL",
    ])
      await expect(
        run({ ...env, [name]: "" }, { appendSummary: () => {} }),
        name,
      ).rejects.toThrow(new RegExp(`${name} is not set`));
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

interface CiStep {
  name: string;
  if?: string;
  text: string;
}

interface CiJob {
  stage: number;
  needs: string[];
  body: string[];
  if?: string;
  steps: CiStep[];
}

/** A job's or step's `if:`, joining a folded `>-` block onto one line. */
function readIf(lines: string[], index: number, indent: number): string {
  const value = lines[index].slice(indent + "if:".length).trim();
  if (value !== ">-" && value !== ">") return value;
  const parts: string[] = [];
  for (let next = index + 1; next < lines.length; next++) {
    const line = lines[next];
    if (line.length - line.trimStart().length <= indent) break;
    parts.push(line.trim());
  }
  return parts.join(" ");
}

/** Each job's stage (from the `# ── Stage N:` headers), needs, `if`, steps, and body lines, keyed by job id. */
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
      jobs.set(job[1], (current = { stage, needs: [], body: [], steps: [] }));
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
  for (const job of jobs.values()) {
    const body = job.body;
    let step: CiStep | undefined;
    let inSteps = false;
    for (let index = 0; index < body.length; index++) {
      const line = body[index];
      if (/^ {4}if:/.test(line)) job.if = readIf(body, index, 4);
      if (/^ {4}\S/.test(line)) inSteps = /^ {4}steps:/.test(line);
      if (!inSteps) continue;
      const item = /^ {6}- (.*)$/.exec(line);
      if (item) job.steps.push((step = { name: "", text: "" }));
      if (!step) continue;
      step.text += `${line}\n`;
      const field = /^ {6}(?:- | {2})(name|uses|if):\s*(.*)$/.exec(line);
      if (field?.[1] === "if")
        step.if = readIf(body, index, line.indexOf("if:"));
      else if (field && !step.name) step.name = field[2];
    }
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

type Value = string | boolean | null | readonly string[];

/**
 * Evaluates the subset of the GitHub Actions expression syntax that ci.yml
 * uses: context paths, '…' strings, true/false/null, ==, !=, !, &&, ||,
 * parentheses, and startsWith, format, contains, success, always and cancelled,
 * with `needs.*.result` as a list. A path
 * missing from `context` throws, so a typo'd context name fails the test
 * instead of reading as empty.
 */
function evaluate(expression: string, context: Record<string, Value>): Value {
  let source = expression.trim();
  if (source.startsWith("${{") && source.endsWith("}}"))
    source = source.slice(3, -2).trim();
  const tokens: string[] = [];
  // One sticky pass: each alternative starts with a different character, so
  // tokenizing is linear in the expression length.
  const token =
    /\s*(?:('(?:[^']|'')*')|(==|!=|&&|\|\||[!(),])|([A-Za-z_][\w.*-]*))/y;
  while (token.lastIndex < source.length) {
    const from = token.lastIndex;
    const match = token.exec(source);
    if (!match) throw new Error(`cannot read "${source.slice(from)}"`);
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  let at = 0;
  const peek = () => tokens[at];
  const take = (expected?: string) => {
    const next = tokens[at++];
    if (expected !== undefined && next !== expected)
      throw new Error(`expected ${expected}, got ${next} in ${source}`);
    return next;
  };
  const truthy = (value: Value) =>
    value !== "" && value !== null && value !== false;
  const equal = (a: Value, b: Value) =>
    typeof a === "string" && typeof b === "string"
      ? a.toLowerCase() === b.toLowerCase()
      : a === b;
  const functions: Record<string, (...args: Value[]) => Value> = {
    startsWith: (a, b) =>
      String(a ?? "")
        .toLowerCase()
        .startsWith(String(b ?? "").toLowerCase()),
    format: (pattern, ...args) =>
      String(pattern).replace(/\{(\d+)\}/g, (_, n: string) =>
        String(args[Number(n)] ?? ""),
      ),
    contains: (haystack, needle) =>
      Array.isArray(haystack)
        ? haystack.some((item) => equal(item, needle))
        : String(haystack ?? "")
            .toLowerCase()
            .includes(String(needle ?? "").toLowerCase()),
    success: () => true,
    always: () => true,
    cancelled: () => false,
  };
  const primary = (): Value => {
    const next = take();
    if (next === "(") {
      const value = or();
      take(")");
      return value;
    }
    if (next.startsWith("'")) return next.slice(1, -1).replace(/''/g, "'");
    if (next === "true" || next === "false") return next === "true";
    if (next === "null") return null;
    if (peek() === "(") {
      take("(");
      const args: Value[] = [];
      while (peek() !== ")") {
        args.push(or());
        if (peek() === ",") take(",");
      }
      take(")");
      if (!functions[next]) throw new Error(`unknown function ${next}`);
      return functions[next](...args);
    }
    if (!(next in context)) throw new Error(`unknown context path ${next}`);
    return context[next];
  };
  const unary = (): Value => {
    if (peek() === "!") {
      take();
      return !truthy(unary());
    }
    return primary();
  };
  const comparison = (): Value => {
    const left = unary();
    if (peek() !== "==" && peek() !== "!=") return left;
    const negate = take() === "!=";
    return equal(left, unary()) !== negate;
  };
  const and = (): Value => {
    let value = comparison();
    while (peek() === "&&") {
      take();
      const right = comparison();
      value = truthy(value) ? right : value;
    }
    return value;
  };
  const or = (): Value => {
    let value = and();
    while (peek() === "||") {
      take();
      const right = and();
      value = truthy(value) ? value : right;
    }
    return value;
  };
  const value = or();
  if (at !== tokens.length) throw new Error(`trailing tokens in ${source}`);
  return value;
}

const isTruthy = (value: Value) =>
  value !== "" && value !== null && value !== false;

const REPO = "bascikdev/bascik";

/** The context of one CI run: a push of `ref`, or a pull request from `prRepo`. */
function runContext(
  event: "push" | "pull_request",
  ref: string,
  { repository = REPO, prRepo = null as string | null, newest = "true" } = {},
): Record<string, Value> {
  return {
    "github.event_name": event,
    "github.ref": ref,
    "github.ref_name": ref.replace(/^refs\/(?:heads|tags)\//, ""),
    "github.repository": repository,
    "github.run_id": "4242",
    "github.event.pull_request.head.repo.full_name": prRepo,
    "steps.newest.outputs.newest": newest,
    "needs.deploy-docs.outputs.preview-url": "",
    "needs.deploy-demo.outputs.preview-url": "",
  };
}

/**
 * Which jobs, and which steps of the stage 5 jobs, a run with `context`
 * starts. As on GitHub, a job whose `if` has no status function (success,
 * always, cancelled, failure) runs only when every job it needs succeeded; one
 * whose `if` has a status function is evaluated whatever its needs did, with
 * `needs.*.result` listing their results ("skipped" for a need that did not
 * run). A job in `failed` runs and then fails. A deploy job's `preview-url`
 * output is set when its upload step ran.
 */
function simulate(
  jobs: Map<string, CiJob>,
  context: Record<string, Value>,
  failed: ReadonlySet<string> = new Set(),
) {
  const ran = new Set<string>();
  const results = new Map<string, string>();
  const steps = new Map<string, string[]>();
  const scope: Record<string, Value> = { ...context };
  for (const [id, job] of jobs) {
    const needResults = job.needs.map((need) => results.get(need) ?? "skipped");
    const statusCheck = /\b(?:success|always|cancelled|failure)\(/.test(
      job.if ?? "",
    );
    if (!statusCheck && needResults.some((result) => result !== "success"))
      continue;
    scope["needs.*.result"] = needResults;
    if (!isTruthy(evaluate(job.if ?? "success()", scope))) continue;
    ran.add(id);
    results.set(id, failed.has(id) ? "failure" : "success");
    if (job.stage !== 5) continue;
    const names = job.steps
      .filter((step) => isTruthy(evaluate(step.if ?? "success()", scope)))
      .map((step) => step.name);
    steps.set(id, names);
    if (names.includes("Upload a Preview version"))
      scope[`needs.${id}.outputs.preview-url`] =
        `https://${id}.example.workers.dev`;
  }
  return { ran, steps };
}

const WRANGLER_STEPS = [
  "Upload a Preview version",
  "Smoke-test the Preview",
  "Deploy to production",
  "Smoke-test production",
];
const wranglerSteps = (names: string[] = []) =>
  names.filter((name) => WRANGLER_STEPS.includes(name));

const workflow = readFileSync(
  join(repoDir, ".github/workflows/ci.yml"),
  "utf8",
);

/** The lines of a top-level block such as `on:` or `concurrency:`. */
function topLevelBlock(text: string, key: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => line === `${key}:`);
  if (start < 0) return "";
  const end = lines.findIndex(
    (line, index) => index > start && /^\S/.test(line),
  );
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
}

describe("the GitHub Actions expression evaluator used by these tests", () => {
  const context = runContext("push", "refs/heads/feature/x");

  it("evaluates comparisons, logic, functions and folded conditions like GitHub", () => {
    expect(evaluate("github.event_name == 'PUSH'", context)).toBe(true);
    expect(evaluate("${{ github.ref != 'refs/heads/main' }}", context)).toBe(
      true,
    );
    expect(evaluate("!startsWith(github.ref, 'refs/tags/')", context)).toBe(
      true,
    );
    expect(
      evaluate(
        "github.ref == 'refs/heads/main' && format('a-{0}', github.run_id) || format('b-{0}', github.ref)",
        context,
      ),
    ).toBe("b-refs/heads/feature/x");
    expect(evaluate("(false || 'x') && 'it''s'", context)).toBe("it's");
    expect(
      evaluate(
        "github.event.pull_request.head.repo.full_name != github.repository",
        context,
      ),
    ).toBe(true);
  });

  it("throws on a context path or function it does not know", () => {
    expect(() => evaluate("github.evnt_name == 'push'", context)).toThrow(
      /unknown context path/,
    );
    expect(() => evaluate("endsWith(github.ref, 'x')", context)).toThrow(
      /unknown function/,
    );
    expect(() => evaluate("github.ref ==", context)).toThrow();
  });

  it("reads job and step conditions, including folded ones", () => {
    const parsed = ciStages(
      [
        "jobs:",
        "  # ── Stage 1: a",
        "  a:",
        "    if: >-",
        "      github.event_name == 'push' &&",
        "      github.ref == 'refs/heads/main'",
        "    steps:",
        "      - uses: actions/checkout@v5",
        "      - name: Deploy",
        "        if: github.ref == 'refs/heads/main'",
        "        run: yarn wrangler deploy",
      ].join("\n"),
    );
    const a = parsed.get("a")!;
    expect(a.if).toBe(
      "github.event_name == 'push' && github.ref == 'refs/heads/main'",
    );
    expect(a.steps.map((step) => [step.name, step.if])).toEqual([
      ["actions/checkout@v5", undefined],
      ["Deploy", "github.ref == 'refs/heads/main'"],
    ]);
  });
});

describe("CI stages and the deploy stage", () => {
  const jobs = ciStages(workflow);
  const stage = (n: number) =>
    [...jobs].filter(([, job]) => job.stage === n).map(([id]) => id);

  it("enables Corepack before setup-node in every job, or turns off setup-node's package manager cache", () => {
    // setup-node v5 caches the package manager named in package.json by default. Without Corepack that runs the
    // runner's global Yarn 1, which refuses this repo's "packageManager": "yarn@4…" and fails the job.
    const missing: string[] = [];
    for (const [id, job] of jobs) {
      const setupNode = job.steps.findIndex((s) =>
        /uses:\s*actions\/setup-node@/.test(s.text),
      );
      if (setupNode < 0) continue;
      const corepackFirst = job.steps
        .slice(0, setupNode)
        .some((s) => /corepack enable/.test(s.text));
      const noCache = /package-manager-cache:\s*false/.test(
        job.steps[setupNode].text,
      );
      if (!corepackFirst && !noCache) missing.push(id);
    }
    expect(missing).toEqual([]);
  });

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

  it("runs the VS Code extension's real-editor suite in stage 4, under a virtual display, before anything deploys", () => {
    const job = jobs.get("e2e-extension");
    expect(job, "e2e-extension job").toBeDefined();
    expect(job!.stage).toBe(4);
    // Same gate as the other stage 4 jobs: every stage 3 job.
    expect(job!.needs).toEqual(jobs.get("e2e-create")!.needs);
    expect(job!.if).toBeUndefined();
    const body = job!.body.join("\n");
    expect(body).toMatch(/^ {4}runs-on: ubuntu-latest$/m);
    // VS Code is an Electron app: on Linux it needs a display, so xvfb-run gives it a virtual one.
    expect(body).toMatch(/^ {8}run: xvfb-run -a yarn ext:e2e$/m);
    // The downloaded VS Code is cached; the user-data folder a run writes is not.
    const cache = job!.steps.find((step) =>
      /uses: actions\/cache@/.test(step.text),
    );
    expect(cache?.text).toMatch(
      /path: extensions\/vscode-bascik\/\.vscode-test\/vscode-\*/,
    );
    for (const id of ["deploy-docs", "deploy-demo"])
      expect(jobs.get(id)!.needs, id).toContain("e2e-extension");
  });

  it("misuse: runs every workspace's root e2e script in some CI job, so a suite cannot silently drop out of CI", () => {
    const scripts = Object.keys(
      JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8"))
        .scripts as Record<string, string>,
    ).filter((name) =>
      /^(?:pkg|create|docs|ext|adapter:cf|lsp|skills):e2e$/.test(name),
    );
    expect(scripts).toContain("ext:e2e");
    const runs = [...jobs.values()].flatMap((job) => job.body);
    const missing = scripts.filter(
      (script) =>
        !runs.some((line) =>
          new RegExp(`^ {8}run: .*\\byarn ${script}(?![\\w:-])`).test(line),
        ),
    );
    expect(missing).toEqual([]);
  });

  it("runs on every branch push and on pull requests, never on tags", () => {
    const on = topLevelBlock(workflow, "on");
    expect(on).toMatch(/^ {2}push:\n {4}branches: \["\*\*"\]$/m);
    expect(on).toMatch(/^ {2}pull_request:$/m);
    expect(on).not.toMatch(/tags/);
  });

  it("skips same-repo pull_request runs at stage 1, so the branch's push run is the only test run", () => {
    for (const id of stage(1))
      expect(jobs.get(id)!.if, id).toBe(
        "(github.event_name == 'push' && github.ref != 'refs/heads/main') || (github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository)",
      );
    // Every later job needs stage 1 (directly or not), so the whole run skips.
    const sameRepo = simulate(
      jobs,
      runContext("pull_request", "refs/pull/113/merge", { prRepo: REPO }),
    );
    expect([...sameRepo.ran]).toEqual([]);
  });

  it("tests a fork's pull request in stages 1 to 4 and never deploys it", () => {
    const fork = simulate(
      jobs,
      runContext("pull_request", "refs/pull/7/merge", {
        prRepo: "someone/bascik",
      }),
    );
    for (const n of [1, 2, 3, 4])
      for (const id of stage(n)) expect(fork.ran.has(id), id).toBe(true);
    for (const id of stage(5)) expect(fork.ran.has(id), id).toBe(false);
  });

  it("deploys main to production without running the tests again, and never only previews it", () => {
    const main = simulate(jobs, runContext("push", "refs/heads/main"));
    // A merged pull request was tested on its branch, so main skips stages 1 to 4.
    for (const n of [1, 2, 3, 4])
      for (const id of stage(n)) expect(main.ran.has(id), id).toBe(false);
    for (const id of ["deploy-docs", "deploy-demo"])
      expect(wranglerSteps(main.steps.get(id)), id).toEqual([
        "Deploy to production",
        "Smoke-test production",
      ]);
    expect(main.ran.has("preview-comment")).toBe(false);
  });

  it("previews nothing when any stage 4 job of a branch fails", () => {
    for (const failing of stage(4)) {
      const push = simulate(
        jobs,
        runContext("push", "refs/heads/feature/x"),
        new Set([failing]),
      );
      for (const id of ["deploy-docs", "deploy-demo"])
        expect(push.ran.has(id), `${failing} failed: ${id}`).toBe(false);
      expect(push.ran.has("preview-comment"), failing).toBe(false);
    }
  });

  it("previews both Workers on every other branch push, and publishes the URLs", () => {
    for (const branch of [
      "pre-release-20261026",
      "feature/milk-frother",
      "main-fix",
      "refs/main",
    ]) {
      const push = simulate(jobs, runContext("push", `refs/heads/${branch}`));
      for (const id of ["deploy-docs", "deploy-demo"]) {
        expect(push.steps.get(id), `${branch} ${id}`).toContain(
          "Compute the Preview alias",
        );
        expect(wranglerSteps(push.steps.get(id)), `${branch} ${id}`).toEqual([
          "Upload a Preview version",
          "Smoke-test the Preview",
        ]);
      }
      expect(push.ran.has("preview-comment"), branch).toBe(true);
    }
  });

  it("never uploads or deploys on a tag, a pull_request event, or a fork's own push", () => {
    for (const context of [
      runContext("push", "refs/tags/v1.0.0"),
      runContext("pull_request", "refs/pull/113/merge", { prRepo: REPO }),
      runContext("pull_request", "refs/pull/7/merge", {
        prRepo: "someone/bascik",
      }),
      runContext("push", "refs/heads/main", { repository: "someone/bascik" }),
      runContext("push", "refs/heads/x", { repository: "someone/bascik" }),
    ]) {
      // Pretend stages 1 to 4 ran, so only stage 5's own conditions decide.
      const stage5Only = new Map(
        [...jobs].map(([id, job]) => [
          id,
          job.stage === 5 ? job : { ...job, if: "true", needs: [] },
        ]),
      );
      const result = simulate(stage5Only, context);
      const label = `${context["github.event_name"]} ${context["github.ref"]} in ${context["github.repository"]}`;
      for (const id of stage(5)) expect(result.ran.has(id), label).toBe(false);
    }
  });

  it("runs Wrangler only when the commit is still the newest on its branch", () => {
    for (const ref of ["refs/heads/main", "refs/heads/feature/x"]) {
      const stale = simulate(
        jobs,
        runContext("push", ref, { newest: "false" }),
      );
      for (const id of ["deploy-docs", "deploy-demo"])
        expect(wranglerSteps(stale.steps.get(id)), `${ref} ${id}`).toEqual([]);
      // No URLs, so no summary or comment from the stale run either.
      expect(stale.ran.has("preview-comment"), ref).toBe(false);
    }
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
      const body = lines.join("\n");
      expect(body, id).toContain("REF: ${{ github.ref }}");
      expect(body, id).toContain("SHA: ${{ github.sha }}");
      expect(body, id).toContain("BRANCH: ${{ github.ref_name }}");
      expect(body, id).toMatch(
        /wrangler versions upload .*--preview-alias "\$ALIAS"/,
      );
      expect(body, id).toMatch(/yarn wrangler deploy\b/);
      expect(body, id).toContain("WRANGLER_OUTPUT_FILE_PATH");
      expect(body, id).toMatch(/>> "\$GITHUB_STEP_SUMMARY"/);
    }
    expect(jobs.get("deploy-docs")!.body.join("\n")).toMatch(/fetch-depth: 0/);
  });

  it("deploys main only from a commit a merged pull request put there, checked before any Wrangler step", () => {
    const NAME = "Check the commit came from a merged pull request";
    const main = simulate(jobs, runContext("push", "refs/heads/main"));
    const branch = simulate(jobs, runContext("push", "refs/heads/feature/x"));
    for (const id of ["deploy-docs", "deploy-demo"]) {
      const job = jobs.get(id)!;
      const at = job.steps.findIndex((step) => step.name === NAME);
      expect(at, id).toBeGreaterThan(0);
      const step = job.steps[at];
      expect(step.if, id).toBe("github.ref == 'refs/heads/main'");
      expect(step.text, id).toContain("GH_TOKEN: ${{ github.token }}");
      expect(step.text, id).toContain("REPO: ${{ github.repository }}");
      expect(step.text, id).toContain("SHA: ${{ github.sha }}");
      expect(step.text, id).toMatch(
        /gh api "repos\/\$REPO\/commits\/\$SHA\/pulls" > "\$PULLS"/,
      );
      expect(step.text, id).toMatch(
        /node \.github\/scripts\/merged-pull-request\.mjs "\$SHA" "\$PULLS"/,
      );
      // Before the newest-commit check and every upload, deploy and smoke step.
      const newest = job.steps.findIndex((s) =>
        s.text.includes("newest-commit.mjs"),
      );
      expect(at, id).toBeLessThan(newest);
      for (const [index, other] of job.steps.entries())
        if (WRANGLER_STEPS.includes(other.name))
          expect(at, `${id}: ${other.name}`).toBeLessThan(index);
      // The only permission it adds is reading pull requests.
      expect(job.body.join("\n"), id).toMatch(
        /^ {4}permissions:\n {6}contents: read\n {6}pull-requests: read\n {4}\S/m,
      );
      expect(main.steps.get(id), id).toContain(NAME);
      // Branch Previews are not gated on a pull request.
      expect(branch.steps.get(id), id).not.toContain(NAME);
    }
  });

  /** A step's `run: |` block as the shell receives it. */
  const runBlock = (text: string) => {
    const lines = text.split("\n");
    const start = lines.findIndex((line) => /^ {8}run: \|$/.test(line));
    expect(start, "run: | block").toBeGreaterThan(-1);
    const body: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (line.trim() && !line.startsWith(" ".repeat(10))) break;
      body.push(line.slice(10));
    }
    return body.join("\n");
  };

  it.skipIf(process.platform === "win32")(
    "asks GitHub again while no pull request lists a fresh merge commit, then fails with the merged-pull-request error",
    () => {
      const SHA = "4".repeat(40);
      const merged = JSON.stringify([
        {
          number: 12,
          merged_at: "2026-10-31T12:00:00Z",
          base: { ref: "main" },
        },
      ]);
      for (const id of ["deploy-docs", "deploy-demo"]) {
        const step = jobs
          .get(id)!
          .steps.find(
            (s) =>
              s.name === "Check the commit came from a merged pull request",
          )!;
        const script = runBlock(step.text);
        const dir = mkdtempSync(join(tmpdir(), "bascik-merged-pr-retry-"));
        try {
          // Fake gh answers with the next line of answers.txt (the last one
          // repeats); fake sleep only records that it was called.
          writeFileSync(
            join(dir, "gh"),
            [
              "#!/bin/sh",
              `n=$(cat "${dir}/calls" 2>/dev/null || echo 0); n=$((n + 1)); echo $n > "${dir}/calls"`,
              `line=$(sed -n "\${n}p" "${dir}/answers.txt"); [ -n "$line" ] || line=$(tail -n 1 "${dir}/answers.txt")`,
              'printf "%s\n" "$line"',
            ].join("\n"),
            { mode: 0o755 },
          );
          writeFileSync(
            join(dir, "sleep"),
            `#!/bin/sh\necho "$1" >> "${dir}/sleeps"\n`,
            { mode: 0o755 },
          );
          const run = (answers: string[]) => {
            writeFileSync(join(dir, "answers.txt"), `${answers.join("\n")}\n`);
            rmSync(join(dir, "calls"), { force: true });
            rmSync(join(dir, "sleeps"), { force: true });
            const result = spawnSync(
              "bash",
              ["--noprofile", "--norc", "-eo", "pipefail", "-c", script],
              {
                cwd: repoDir,
                encoding: "utf8",
                env: {
                  ...process.env,
                  PATH: `${dir}:${process.env.PATH}`,
                  REPO: "bascikdev/bascik",
                  SHA,
                  PULLS: join(dir, "pulls.json"),
                },
              },
            );
            const read = (name: string) => {
              try {
                return readFileSync(join(dir, name), "utf8").trim().split("\n");
              } catch {
                return [];
              }
            };
            return {
              ...result,
              calls: read("calls")[0],
              sleeps: read("sleeps"),
            };
          };

          const late = run(["[]", "[]", merged]);
          expect(late.stderr, id).toBe("");
          expect(late.status, id).toBe(0);
          expect(late.stdout, id).toMatch(/pull request #12; deploying/);
          expect(late.calls, id).toBe("3");
          expect(late.sleeps, id).toEqual(["10", "10"]);

          const never = run(["[]"]);
          expect(never.status, id).toBe(1);
          expect(never.stderr, id).toMatch(
            /::error::444444444444 did not come from a pull request merged into main/,
          );
          expect(never.calls, id).toBe("3");
          expect(never.sleeps, id).toEqual(["10", "10"]);

          // A pull request that is listed but not merged is an answer, not a delay.
          const open = run([JSON.stringify([{ number: 7, state: "open" }])]);
          expect(open.status, id).toBe(1);
          expect(open.stderr, id).toMatch(/#7 \(open\)/);
          expect(open.calls, id).toBe("1");
          expect(open.sleeps, id).toEqual([]);

          const prompt = run([merged]);
          expect(prompt.status, id).toBe(0);
          expect(prompt.calls, id).toBe("1");
          expect(prompt.sleeps, id).toEqual([]);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    },
  );

  it("names github.sha, the commit the push run built, in the Preview comment", () => {
    const comment = jobs.get("preview-comment")!.body.join("\n");
    expect(comment).toContain("SHA: ${{ github.sha }}");
    expect(comment).toContain("BRANCH: ${{ github.ref_name }}");
    expect(comment).toContain("needs.deploy-docs.outputs.preview-url != ''");
    expect(comment).toContain("needs.deploy-demo.outputs.preview-url != ''");
    expect(comment).not.toMatch(/github\.event\.pull_request|github\.head_ref/);
  });

  it("cancels an older run of a branch, but never cancels or leaves pending a run or deploy on main", () => {
    const concurrency = topLevelBlock(workflow, "concurrency");
    const group = /^ {2}group: (.*)$/m.exec(concurrency)?.[1] ?? "";
    const cancel =
      /^ {2}cancel-in-progress: (.*)$/m.exec(concurrency)?.[1] ?? "";
    const at = (
      ref: string,
      runId: string,
      event: "push" | "pull_request" = "push",
    ) => {
      const context = { ...runContext(event, ref), "github.run_id": runId };
      return {
        group: evaluate(group, context),
        cancel: isTruthy(evaluate(cancel, context)),
      };
    };
    const branch1 = at("refs/heads/feature/x", "1");
    const branch2 = at("refs/heads/feature/x", "2");
    expect(branch1.group).toBe(branch2.group);
    expect(branch2.cancel).toBe(true);
    expect(at("refs/heads/feature/y", "3").group).not.toBe(branch1.group);
    // Each main run gets its own group: none cancels or queues behind another.
    const main1 = at("refs/heads/main", "1");
    const main2 = at("refs/heads/main", "2");
    expect(main1.group).not.toBe(main2.group);
    expect(main2.cancel).toBe(false);
    // A same-repo pull_request run never shares a group with its branch's push run.
    expect(at("refs/pull/113/merge", "4", "pull_request").group).not.toBe(
      branch1.group,
    );
    // No job has its own group. GitHub keeps only one pending job per group, so on main a shared deploy group would
    // let an older commit's deploy that queued later cancel the newer commit's pending one; the older one's
    // newest-commit check then skips Wrangler, and the newest commit is never deployed.
    for (const [id, job] of jobs) {
      expect(job.body.join("\n"), id).not.toMatch(/^ {4}concurrency:/m);
    }
  });

  it("gives the Cloudflare token only to stage 5 Wrangler steps, and pull-requests: write only to the comment job", () => {
    const leaks: string[] = [];
    for (const [id, job] of jobs) {
      const body = job.body.join("\n");
      if (/^ {4}env:/m.test(body)) leaks.push(`${id}: job-level env`);
      if (/pull-requests: write/.test(body) && id !== "preview-comment")
        leaks.push(`${id}: pull-requests: write`);
      for (const step of job.steps) {
        const mentions = step.text.match(/secrets\.CLOUDFLARE_API_TOKEN[^}]*/g);
        if (!mentions) continue;
        const where = `${id}: ${step.name}`;
        if (job.stage !== 5) leaks.push(`${where}: not stage 5`);
        // The credentials check sees only whether the secret is set.
        if (
          mentions.every(
            (m) => m.trim() === "secrets.CLOUDFLARE_API_TOKEN != ''",
          )
        )
          continue;
        if (!/yarn wrangler (versions upload|deploy)\b/.test(step.text))
          leaks.push(`${where}: token outside a Wrangler step`);
      }
    }
    expect(leaks).toEqual([]);
    const tokenSteps = [...jobs.values()].flatMap((job) =>
      job.steps.filter((step) =>
        step.text.includes(
          "CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}",
        ),
      ),
    );
    expect(tokenSteps).toHaveLength(4);
    expect(jobs.get("preview-comment")!.body.join("\n")).toMatch(
      /permissions:\n {6}contents: read\n {6}pull-requests: write/,
    );
  });
});
