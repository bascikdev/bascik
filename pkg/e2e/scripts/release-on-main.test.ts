/**
 * Packages release only from tags on commits that are on main (RELEASING.md).
 * Every publish job in .github/workflows/release.yml checks out the full
 * history and then runs .github/scripts/release-on-main.mjs, which fails the
 * job before anything is built or published when the tagged commit is not on
 * origin/main. These tests cover the script (with a fake git and against a
 * real throwaway repository) and the shape of release.yml.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  releaseOnMain,
  type GitResult,
} from "../../../.github/scripts/release-on-main.mjs";

const repoDir = fileURLToPath(new URL("../../..", import.meta.url));
const script = join(repoDir, ".github/scripts/release-on-main.mjs");
const ON_MAIN = "a".repeat(40);
const OFF_MAIN = "b".repeat(40);

/** A fake git: origin/main exists unless `noMain`, and only ON_MAIN is its ancestor. */
function fakeGit({ noMain = false, unknownCommit = false } = {}) {
  const calls: string[][] = [];
  const git = (args: string[]): GitResult => {
    calls.push(args);
    const ok = (stdout = ""): GitResult => ({ status: 0, stdout, stderr: "" });
    if (args[0] === "rev-parse") {
      const rev = args[args.length - 1];
      if (rev.startsWith("refs/remotes/origin/main"))
        return noMain
          ? { status: 1, stdout: "", stderr: "" }
          : ok("c".repeat(40));
      if (unknownCommit) return { status: 1, stdout: "", stderr: "" };
      return ok(`${rev.slice(0, 40)}\n`);
    }
    if (args[0] === "merge-base")
      return args[2] === ON_MAIN ? ok() : { status: 1, stdout: "", stderr: "" };
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  return { git, calls };
}

describe("release-on-main", () => {
  it("passes a tag whose commit is on origin/main", () => {
    const { git, calls } = fakeGit();
    expect(releaseOnMain("v1.0.0", ON_MAIN, git)).toMatch(
      /v1\.0\.0 points at a{12}, which is on main/,
    );
    expect(calls.at(-1)).toEqual([
      "merge-base",
      "--is-ancestor",
      ON_MAIN,
      "refs/remotes/origin/main",
    ]);
  });

  it("fails a tag on a commit that is not on main, naming the tag, the commit and the fix", () => {
    const { git } = fakeGit();
    expect(() => releaseOnMain("create-v1.0.3", OFF_MAIN, git)).toThrow(
      new RegExp(
        `create-v1\\.0\\.3 points at commit ${OFF_MAIN}, which is not on main.*git push origin :refs/tags/create-v1\\.0\\.3`,
        "s",
      ),
    );
  });

  it("misuse: a checkout without main's history is an error that names fetch-depth, not a verdict", () => {
    const { git } = fakeGit({ noMain: true });
    expect(() => releaseOnMain("v1.0.0", ON_MAIN, git)).toThrow(
      /origin\/main is not in this checkout.*fetch-depth: 0/s,
    );
  });

  it("misuse: rejects a missing tag, a short or typo'd SHA, and a commit the checkout does not have", () => {
    const { git } = fakeGit();
    expect(() => releaseOnMain("", ON_MAIN, git)).toThrow(/no tag name/);
    expect(() => releaseOnMain("v1.0.0", "", git)).toThrow(/full commit SHA/);
    expect(() => releaseOnMain("v1.0.0", ON_MAIN.slice(0, 12), git)).toThrow(
      /full commit SHA/,
    );
    expect(() => releaseOnMain("v1.0.0", "g".repeat(40), git)).toThrow(
      /full commit SHA/,
    );
    expect(() =>
      releaseOnMain("v1.0.0", ON_MAIN, fakeGit({ unknownCommit: true }).git),
    ).toThrow(/is not in this checkout/);
  });

  it("reports a git failure instead of reading it as not on main", () => {
    const git = (args: string[]): GitResult =>
      args[0] === "merge-base"
        ? { status: 128, stdout: "", stderr: "fatal: bad object\n" }
        : { status: 0, stdout: `${ON_MAIN}\n`, stderr: "" };
    expect(() => releaseOnMain("v1.0.0", ON_MAIN, git)).toThrow(
      /git merge-base failed \(exit 128\): fatal: bad object/,
    );
  });

  describe("against a real repository", () => {
    let dir = "";
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "Release Test",
      GIT_AUTHOR_EMAIL: "release-test@example.com",
      GIT_COMMITTER_NAME: "Release Test",
      GIT_COMMITTER_EMAIL: "release-test@example.com",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    };
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, {
        cwd: dir,
        env,
        encoding: "utf8",
      });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    const run = (tag: string, sha: string) =>
      spawnSync(process.execPath, [script, tag, sha], {
        cwd: dir,
        env,
        encoding: "utf8",
      });
    let onMain = "";
    let offMain = "";

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "bascik-release-on-main-"));
      git("init", "-q");
      const tree = git("hash-object", "-t", "tree", "-w", "--stdin");
      onMain = git("commit-tree", tree, "-m", "on main");
      offMain = git("commit-tree", tree, "-p", onMain, "-m", "on a branch");
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("fails before origin/main is fetched, then passes only the commit on main", () => {
      const unfetched = run("v1.0.0", onMain);
      expect(unfetched.status).toBe(1);
      expect(unfetched.stderr).toMatch(/fetch-depth: 0/);

      git("update-ref", "refs/remotes/origin/main", onMain);
      const passed = run("v1.0.0", onMain);
      expect(passed.stderr).toBe("");
      expect(passed.status).toBe(0);
      expect(passed.stdout).toMatch(/which is on main/);

      const failed = run("v1.0.1", offMain);
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain(
        `::error::Tag v1.0.1 points at commit ${offMain}, which is not on main`,
      );
    });

    it("dereferences an annotated tag object to the commit it tags", () => {
      git("update-ref", "refs/remotes/origin/main", onMain);
      git("tag", "-a", "-m", "release", "v2.0.0", offMain);
      const tagObject = git("rev-parse", "v2.0.0");
      expect(tagObject).not.toBe(offMain);
      const failed = run("v2.0.0", tagObject);
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain(`points at commit ${offMain}`);
    });
  });
});

/** Each job's steps (their text), keyed by job id, from a workflow's `jobs:` block. */
function jobSteps(workflow: string): Map<string, string[]> {
  const jobs = new Map<string, string[]>();
  const lines = workflow.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  let steps: string[] | undefined;
  let inSteps = false;
  for (const line of start < 0 ? [] : lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const job = /^ {2}([\w-]+):\s*$/.exec(line);
    if (job) {
      jobs.set(job[1], (steps = []));
      inSteps = false;
      continue;
    }
    if (!steps || line.trim().startsWith("#")) continue;
    if (/^ {4}\S/.test(line)) inSteps = /^ {4}steps:/.test(line);
    if (!inSteps) continue;
    if (/^ {6}- /.test(line)) steps.push("");
    if (steps.length) steps[steps.length - 1] += `${line}\n`;
  }
  return jobs;
}

const GUARD =
  /^ {8}run: node \.github\/scripts\/release-on-main\.mjs "\$GITHUB_REF_NAME" "\$GITHUB_SHA"$/m;
const PUBLISH = /publish-(?:npm|vsce)\.sh/;

/** Jobs that publish without first checking out full history and running the guard. */
function unguardedJobs(workflow: string): string[] {
  const bad: string[] = [];
  for (const [id, steps] of jobSteps(workflow)) {
    const publish = steps.findIndex((step) => PUBLISH.test(step));
    if (publish < 0) continue;
    const checkout = steps.findIndex((step) =>
      /uses: actions\/checkout@/.test(step),
    );
    const guard = steps.findIndex((step) => GUARD.test(step));
    if (checkout < 0 || !/^ {10}fetch-depth: 0$/m.test(steps[checkout]))
      bad.push(`${id}: checkout without fetch-depth: 0`);
    if (guard !== checkout + 1)
      bad.push(`${id}: release-on-main is not the step right after checkout`);
    else if (/^ {8}if:/m.test(steps[guard]))
      bad.push(`${id}: release-on-main has an if`);
  }
  return bad;
}

describe("release.yml publishes only commits on main", () => {
  const workflow = readFileSync(
    join(repoDir, ".github/workflows/release.yml"),
    "utf8",
  );

  it("runs release-on-main right after a full-history checkout in every publish job", () => {
    const jobs = jobSteps(workflow);
    expect([...jobs.keys()]).toEqual([
      "release",
      "release-create",
      "release-adapter-cloudflare",
      "release-language-server",
      "release-extension",
    ]);
    for (const [id, steps] of jobs)
      expect(
        steps.some((step) => PUBLISH.test(step)),
        `${id} publishes`,
      ).toBe(true);
    expect(unguardedJobs(workflow)).toEqual([]);
  });

  it("misuse: flags a publish job added without the guard, with a shallow checkout, or with a conditional guard", () => {
    const job = (id: string, checkout: string[], guard: string[]) =>
      [
        `  ${id}:`,
        "    runs-on: ubuntu-latest",
        "    steps:",
        ...checkout,
        ...guard,
        "      - name: Publish to npm",
        "        run: ./publish-npm.sh v",
      ].join("\n");
    const full = [
      "      - uses: actions/checkout@v5",
      "        with:",
      "          fetch-depth: 0",
    ];
    const guard = [
      "      - name: Check the tagged commit is on main",
      '        run: node .github/scripts/release-on-main.mjs "$GITHUB_REF_NAME" "$GITHUB_SHA"',
    ];
    const text = [
      "jobs:",
      job("good", full, guard),
      job("no-guard", full, []),
      job("shallow", ["      - uses: actions/checkout@v5"], guard),
      job("conditional", full, [...guard, "        if: github.ref_name != ''"]),
    ].join("\n");
    expect(unguardedJobs(text)).toEqual([
      "no-guard: release-on-main is not the step right after checkout",
      "shallow: checkout without fetch-depth: 0",
      "conditional: release-on-main has an if",
    ]);
  });

  it("states the rule in RELEASING.md and the CI / CD page", () => {
    for (const doc of ["RELEASING.md", "docs/content/internals/ci-cd.md"])
      expect(readFileSync(join(repoDir, doc), "utf8"), doc).toContain(
        ".github/scripts/release-on-main.mjs",
      );
  });
});
