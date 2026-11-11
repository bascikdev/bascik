import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// WHY: the floor is Node 24.21. Node 24 LTS bundles npm 11.6, the first npm
// that installs the starter project (npm 10.9, bundled with Node 22, crashes on
// its peer set), and 24.21 is the first release where `node --check` locates a
// syntax error in a `.js` config (user-config-loader.ts relies on it).
// `bin/bascik.js` enforces the floor before anything loads;
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
    expect(pkg.engines.node).toBe(">=24.21.0");
  });

  // Every published workspace states the floor, so a package manager that
  // enforces engines reports it at install time for any of them.
  it.each([
    "create/package.json",
    "adapters/cloudflare/package.json",
    "lsp/package.json",
  ])("%s declares the same floor in engines", (file) => {
    const other = JSON.parse(
      readFileSync(new URL(`../../${file}`, import.meta.url), "utf8"),
    ) as { engines?: { node?: string } };
    expect(other.engines?.node, `${file} engines.node`).toBe(pkg.engines.node);
  });

  it.each(["24.10.9", "22.22.0", "22.23.4", "20.19.0", "not.a.version"])(
    "refuses Node %s with one located line",
    (version) => {
      const result = runAs(version);
      expect(result.status).toBe(1);
      expect(result.stderr.trim()).toBe(
        `[bascik] Node.js 24.21.0 or newer is required. Detected ${version}.`,
      );
    },
  );

  it.each(["24.21.0", "24.21.1", "24.21.0", "26.1.0"])(
    "accepts Node %s",
    (version) => {
      const result = runAs(version);
      expect(result.stderr).not.toContain("or newer is required");
    },
  );
});
