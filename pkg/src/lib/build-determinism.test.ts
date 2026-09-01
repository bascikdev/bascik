import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";

function getAllFiles(dir: string, baseDir: string = dir): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const relPath = fullPath.slice(baseDir.length + 1);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      Object.assign(result, getAllFiles(fullPath, baseDir));
    } else {
      result[relPath] = readFileSync(fullPath, "utf-8");
    }
  }
  return result;
}

describe("Build determinism", () => {
  it("building pkg/e2e twice produces byte-identical output", () => {
    const rootDir = process.cwd().endsWith("pkg") ? dirname(process.cwd()) : process.cwd();
    const e2eDir = join(rootDir, "pkg/e2e");
    const distDir = join(e2eDir, "dist");

    // Build first time
    execSync("yarn --cwd pkg/e2e build", { stdio: "pipe", cwd: rootDir });
    const firstBuild = getAllFiles(distDir);

    // Build second time
    execSync("yarn --cwd pkg/e2e build", { stdio: "pipe", cwd: rootDir });
    const secondBuild = getAllFiles(distDir);

    expect(Object.keys(firstBuild).sort()).toEqual(Object.keys(secondBuild).sort());
    for (const file of Object.keys(firstBuild)) {
      expect(secondBuild[file]).toBe(firstBuild[file]);
    }
  });
});
