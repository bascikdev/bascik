import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// WHY: chokidar 6 (the dev watcher) needs Node 22.22, so the published floor
// moved from 22.18. `bin/bascik.js` enforces the floor before anything loads;
// these cases pin the boundary and the message an author on an old Node sees.
const bin = fileURLToPath(new URL("../bin/bascik.js", import.meta.url));
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { engines: { node: string } };

/** Run the bin with `process.versions.node` reporting `version`. */
const runAs = (version: string) => {
  const preload = `Object.defineProperty(process, "versions", { value: { ...process.versions, node: ${JSON.stringify(version)} } });`;
  return spawnSync(
    process.execPath,
    [
      "--import",
      `data:text/javascript,${encodeURIComponent(preload)}`,
      bin,
      "--version",
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
};

describe("bin/bascik.js Node floor", () => {
  it("declares the same floor in engines", () => {
    expect(pkg.engines.node).toBe(">=22.22.0");
  });

  it.each(["22.21.9", "22.18.0", "20.19.0", "not.a.version"])(
    "refuses Node %s with one located line",
    (version) => {
      const result = runAs(version);
      expect(result.status).toBe(1);
      expect(result.stderr.trim()).toBe(
        `[bascik] Node.js 22.22.0 or newer is required. Detected ${version}.`,
      );
    },
  );

  it.each(["22.22.0", "22.23.1", "24.0.0", "26.1.0"])(
    "accepts Node %s",
    (version) => {
      const result = runAs(version);
      expect(result.stderr).not.toContain("or newer is required");
    },
  );
});
