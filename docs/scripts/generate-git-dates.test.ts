import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureFullHistory } from "./generate-git-dates.ts";

/**
 * The docs date pages from git history, so a shallow clone (actions/checkout's default, and Cloudflare's)
 * must be completed first. That used to happen only when CF_PAGES=1; now the script asks git whether the
 * clone is shallow, on any CI. A local build never fetches: it must not change a developer's checkout.
 */
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).trim();

const isShallow = (cwd: string) =>
  git(cwd, "rev-parse", "--is-shallow-repository") === "true";

const commitCount = (cwd: string) =>
  Number(git(cwd, "rev-list", "--count", "HEAD"));

const recordingLog = () => {
  const lines: string[] = [];
  return {
    lines,
    log: {
      log: (line: string) => lines.push(`log: ${line}`),
      warn: (line: string) => lines.push(`warn: ${line}`),
    },
  };
};

describe("generate-git-dates ensureFullHistory", () => {
  let origin: string;
  const clones: string[] = [];

  const shallowClone = async () => {
    const clone = await mkdtemp(join(tmpdir(), "git-dates-clone-"));
    clones.push(clone);
    git(tmpdir(), "clone", "-q", "--depth=1", `file://${origin}`, clone);
    expect(isShallow(clone)).toBe(true);
    expect(commitCount(clone)).toBe(1);
    return clone;
  };

  beforeAll(async () => {
    origin = await mkdtemp(join(tmpdir(), "git-dates-origin-"));
    git(origin, "init", "-q");
    for (const text of ["one", "two", "three"]) {
      await writeFile(join(origin, "page.md"), text);
      git(origin, "add", "-A");
      git(origin, "commit", "-q", "-m", text);
    }
  });

  afterAll(async () => {
    await rm(origin, { recursive: true, force: true });
    for (const clone of clones)
      await rm(clone, { recursive: true, force: true });
  });

  const FETCH_LOG = [
    "log: [sitemap-lastmod] shallow clone on CI, fetching full history...",
    "log: [sitemap-lastmod] full history fetched.",
  ];

  it("fetches full history for a shallow clone on CI hosts whose clone depth the repo cannot set", async () => {
    for (const env of [
      { CI: "1" }, // any other CI
      { CI: "true", GITHUB_ACTIONS: "false" },
      { WORKERS_CI: "1" }, // Cloudflare Workers Builds
      { CF_PAGES: "1" }, // Cloudflare Pages
    ]) {
      const clone = await shallowClone();
      const { lines, log } = recordingLog();
      expect(
        await ensureFullHistory(clone, { env, log }),
        JSON.stringify(env),
      ).toBe(true);
      expect(isShallow(clone)).toBe(false);
      expect(commitCount(clone)).toBe(3);
      expect(lines).toEqual(FETCH_LOG);
    }
  });

  it("leaves the clone depth to the workflow on GitHub Actions, and says how to get full history", async () => {
    // The deploy jobs check out with fetch-depth: 0. The test builds (docs E2E, Lighthouse) keep the default depth
    // and must not start a fetch inside the Playwright web server's build.
    for (const env of [
      { CI: "true", GITHUB_ACTIONS: "true" },
      { GITHUB_ACTIONS: "true" },
    ]) {
      const clone = await shallowClone();
      const { lines, log } = recordingLog();
      expect(
        await ensureFullHistory(clone, { env, log }),
        JSON.stringify(env),
      ).toBe(false);
      expect(isShallow(clone)).toBe(true);
      expect(commitCount(clone)).toBe(1);
      expect(lines).toEqual([
        "log: [sitemap-lastmod] shallow clone on GitHub Actions, not fetching history. Check out with fetch-depth: 0 to date every page.",
      ]);
    }
    // A GitHub Actions job with full history, like the deploy jobs, stays silent.
    const { lines, log } = recordingLog();
    expect(
      await ensureFullHistory(origin, {
        env: { CI: "true", GITHUB_ACTIONS: "true" },
        log,
      }),
    ).toBe(true);
    expect(lines).toEqual([]);
  });

  it("never fetches in a local build, so a developer's checkout is left as it is", async () => {
    for (const env of [
      {},
      { CI: "" },
      { CI: "false" },
      { CI: "0" },
      { CF_PAGES: "0" },
      { WORKERS_CI: "0" },
    ]) {
      const clone = await shallowClone();
      const { lines, log } = recordingLog();
      expect(
        await ensureFullHistory(clone, { env, log }),
        JSON.stringify(env),
      ).toBe(false);
      expect(isShallow(clone)).toBe(true);
      expect(commitCount(clone)).toBe(1);
      // The build still prints its shallow-clone hint later, when pages go undated.
      expect(lines).toEqual([]);
    }
  });

  it("is a silent no-op on a full clone, even on CI", async () => {
    // A full clone with no remote would warn if a fetch were attempted, so silence proves none ran.
    const { lines, log } = recordingLog();
    expect(await ensureFullHistory(origin, { env: { CI: "true" }, log })).toBe(
      true,
    );
    expect(lines).toEqual([]);
    expect(commitCount(origin)).toBe(3);
  });

  it("warns and continues with what it has when the fetch fails", async () => {
    const clone = await shallowClone();
    git(clone, "remote", "set-url", "origin", join(clone, "does-not-exist"));
    const { lines, log } = recordingLog();
    expect(
      await ensureFullHistory(clone, {
        env: { CI: "true" },
        log,
        timeoutMs: 10_000,
      }),
    ).toBe(false);
    expect(isShallow(clone)).toBe(true);
    expect(lines).toEqual([
      FETCH_LOG[0],
      "warn: [sitemap-lastmod] could not fetch full history, continuing with what is available.",
    ]);
  });

  it("does nothing outside a git repository", async () => {
    const plain = await mkdtemp(join(tmpdir(), "git-dates-plain-"));
    clones.push(plain);
    const { lines, log } = recordingLog();
    expect(await ensureFullHistory(plain, { env: { CI: "true" }, log })).toBe(
      true,
    );
    expect(lines).toEqual([]);
  });
});
