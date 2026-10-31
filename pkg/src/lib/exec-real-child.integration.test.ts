// Exec entries run as real child processes: where a relative script resolves,
// what a missing working directory reports, and what a timeout leaves behind.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { runScript, resetActiveExecChildrenForTests } from "./exec.ts";

let project: string;

beforeEach(async () => {
  project = realpathSync(
    await mkdtemp(join(tmpdir(), "bascik-exec-real-child-")),
  );
  vi.spyOn(process, "cwd").mockReturnValue(project);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetActiveExecChildrenForTests();
  await rm(project, { recursive: true, force: true });
});

describe("exec script resolution with a cwd", () => {
  it("runs a project-root relative script inside the entry's cwd", async () => {
    await mkdir(join(project, "scripts"));
    await mkdir(join(project, "packages", "site"), { recursive: true });
    await writeFile(
      join(project, "scripts", "sync.mjs"),
      `import { writeFileSync } from "node:fs";
writeFileSync("ran.txt", process.cwd());
`,
    );

    await runScript({ script: "scripts/sync.mjs", cwd: "packages/site" });

    // The script was found at the project root and started in packages/site.
    const ranIn = await readFile(
      join(project, "packages", "site", "ran.txt"),
      "utf8",
    );
    expect(realpathSync(ranIn)).toBe(join(project, "packages", "site"));
  });

  it("names a typo'd working directory instead of the Node binary", async () => {
    await mkdir(join(project, "scripts"));
    await writeFile(join(project, "scripts", "sync.mjs"), "");

    const run = runScript({ script: "scripts/sync.mjs", cwd: "packagez/site" });
    await expect(run).rejects.toThrow(
      'exec "scripts/sync.mjs": working directory "packagez/site" does not exist',
    );
  });
});
