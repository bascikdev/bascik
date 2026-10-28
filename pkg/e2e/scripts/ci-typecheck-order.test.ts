/**
 * `yarn pkg:typecheck` includes e2e/bascik.config.ts, which imports
 * `@bascik/bascik/config` the way a user's config does. That specifier
 * resolves through the package's `exports` to dist/lib/defineConfig.d.ts, so
 * the typecheck needs a built package (the adapter and docs typechecks import
 * `@bascik/bascik/*` the same way). The Node 22.18 floor job ran
 * `yarn typecheck:all` before `yarn pkg:build` and failed with TS2307 on that
 * import; this pins the order in every CI job.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoDir = fileURLToPath(new URL("../../..", import.meta.url));

/** Each job's body lines (comments dropped), keyed by job id. */
function jobBodies(workflow: string): Map<string, string[]> {
  const jobs = new Map<string, string[]>();
  const lines = workflow.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  let current: string[] | undefined;
  for (const line of start < 0 ? [] : lines.slice(start + 1)) {
    if (/^\S/.test(line)) break; // the next top-level key ends `jobs:`
    const job = /^ {2}([\w-]+):\s*$/.exec(line);
    if (job) jobs.set(job[1], (current = []));
    else if (current && line.trim() && !line.trim().startsWith("#"))
      current.push(line);
  }
  return jobs;
}

/** Index of the first body line that runs `yarn <script>` (not a longer script name). */
const firstRun = (body: string[], script: string): number =>
  body.findIndex((line) =>
    new RegExp(`\\byarn ${script}(?=$|[\\s;&|"'])`).test(line),
  );

const TYPECHECKS = ["typecheck:all", "pkg:typecheck"];

describe("CI typechecks after the package is built", () => {
  it("finds jobs and runs in a workflow, ignoring comments and longer script names", () => {
    const jobs = jobBodies(
      [
        "jobs:",
        "  a:",
        "    steps:",
        "      # yarn typecheck:all would be wrong here",
        "      - run: yarn pkg:build:x",
        "      - run: yarn typecheck:all",
        "      - run: yarn pkg:build",
        "  b:",
        "    steps:",
        "      - run: |",
        "          yarn pkg:build && yarn typecheck:all",
        "env: {}",
        "  c:",
      ].join("\r\n"),
    );
    expect([...jobs.keys()]).toEqual(["a", "b"]);
    expect(firstRun(jobs.get("a")!, "typecheck:all")).toBe(2);
    expect(firstRun(jobs.get("a")!, "pkg:build")).toBe(3);
    expect(firstRun(jobs.get("b")!, "pkg:build")).toBe(2);
    expect(firstRun(jobs.get("b")!, "typecheck:all")).toBe(2);
  });

  it("every job that typechecks the workspace runs yarn pkg:build in an earlier step", () => {
    const jobs = jobBodies(
      readFileSync(join(repoDir, ".github/workflows/ci.yml"), "utf8"),
    );
    const typecheckJobs: string[] = [];
    const misordered: string[] = [];
    for (const [job, body] of jobs) {
      const checks = TYPECHECKS.map((script) => firstRun(body, script)).filter(
        (index) => index >= 0,
      );
      if (checks.length === 0) continue;
      typecheckJobs.push(job);
      const built = firstRun(body, "pkg:build");
      if (built < 0 || built >= Math.min(...checks)) misordered.push(job);
    }
    // Workspace Typechecks and the Node 22.18 floor: if this drops, the
    // parser stopped seeing them and the order check proves nothing.
    expect(typecheckJobs.length, typecheckJobs.join(", ")).toBeGreaterThan(1);
    expect(misordered).toEqual([]);
  });
});
