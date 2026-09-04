import { describe, it, expect } from "vitest";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const runnerPath = fileURLToPath(new URL("./build-script-runner.ts", import.meta.url));

describe("build-script-runner", () => {
  it("executes script files and captures stdout as a Node CLI runner", async () => {
    const file1 = join(tmpdir(), `test-runner-1-${Date.now()}.mjs`);
    const file2 = join(tmpdir(), `test-runner-2-${Date.now()}.mjs`);

    await writeFile(file1, "console.log('Hello from 1');", "utf8");
    await writeFile(file2, "process.stdout.write('Hello from 2');", "utf8");

    try {
      const { stdout } = await execFileAsync(process.execPath, [runnerPath, file1, file2]);
      const results = JSON.parse(stdout);
      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({
        id: 0,
        ok: true,
        stdout: "Hello from 1\n",
        stderr: "",
      });
      expect(results[1]).toEqual({
        id: 1,
        ok: true,
        stdout: "Hello from 2",
        stderr: "",
      });
    } finally {
      await Promise.all([
        unlink(file1).catch(() => { }),
        unlink(file2).catch(() => { }),
      ]);
    }
  });

  it("sets BASCIK_SOURCE_FILE independently for each CLI batch task", async () => {
    const file1 = join(tmpdir(), `test-runner-source-1-${Date.now()}.mjs`);
    const file2 = join(tmpdir(), `test-runner-source-2-${Date.now()}.mjs`);
    await writeFile(file1, "console.log(process.env.BASCIK_SOURCE_FILE);", "utf8");
    await writeFile(file2, "console.log(process.env.BASCIK_SOURCE_FILE);", "utf8");

    try {
      const tasks = [
        JSON.stringify({ file: file1, sourceFile: "src/pages/index.html" }),
        JSON.stringify({ file: file2, sourceFile: "src/components/page-badge.html" }),
      ];
      const { stdout } = await execFileAsync(process.execPath, [runnerPath, ...tasks]);
      const results = JSON.parse(stdout);
      expect(results.map((result: { stdout: string }) => result.stdout)).toEqual([
        "src/pages/index.html\n",
        "src/components/page-badge.html\n",
      ]);
    } finally {
      await Promise.all([
        unlink(file1).catch(() => { }),
        unlink(file2).catch(() => { }),
      ]);
    }
  });

  it("captures errors and stderr correctly as a Node CLI runner", async () => {
    const file = join(tmpdir(), `test-runner-err-${Date.now()}.mjs`);
    await writeFile(file, "console.error('some warning'); throw new Error('fail');", "utf8");

    try {
      const { stdout } = await execFileAsync(process.execPath, [runnerPath, file]);
      const results = JSON.parse(stdout);
      expect(results).toHaveLength(1);
      expect(results[0].ok).toBe(false);
      expect(results[0].stderr).toContain("some warning\n");
      expect(results[0].error).toContain("fail");
    } finally {
      await unlink(file).catch(() => { });
    }
  });
});

