/**
 * The root .yarnrc.yml keeps a 7-day age gate on every package Yarn resolves
 * (`npmMinimalAgeGate`) and exempts a short list of exact versions from it
 * (`npmPreapprovedPackages`), for security patches needed before they age in.
 * A bare name or a range in that list would exempt every later release of the
 * package too, and an entry that names nothing in yarn.lock (a typo, or one
 * left behind after the gate opened) exempts nothing and should be removed.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoDir = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Reads the two age-gate settings from .yarnrc.yml. Only the shapes the file
 * uses are read: `key: value` on one line, and `key:` followed by `  - item`
 * lines. Quotes around a value are removed.
 */
function readAgeGate(yarnrc: string): {
  gate: string | undefined;
  preapproved: string[];
} {
  const unquote = (value: string) => value.trim().replace(/^"(.*)"$/, "$1");
  let gate: string | undefined;
  const preapproved: string[] = [];
  let inList = false;
  for (const line of yarnrc.split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const item = /^\s+-\s+(.+)$/.exec(line);
    if (item) {
      if (inList) preapproved.push(unquote(item[1]));
      continue;
    }
    inList = false;
    const entry = /^([A-Za-z]+):\s*(.*)$/.exec(line);
    if (!entry) continue;
    if (entry[1] === "npmMinimalAgeGate") gate = unquote(entry[2]);
    if (entry[1] === "npmPreapprovedPackages") inList = entry[2] === "";
  }
  return { gate, preapproved };
}

/** Returns why a preapproved entry is unsafe or stale, or `undefined`. */
function preapprovalProblem(
  entry: string,
  lockfile: string,
): string | undefined {
  const match = /^((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)@(\d+\.\d+\.\d+)$/.exec(
    entry,
  );
  if (!match) {
    return `"${entry}" is not an exact version like "glob@14.0.3"; a name, range or pattern exempts later releases too`;
  }
  const resolution = `resolution: "${match[1]}@npm:${match[2]}"`;
  if (!lockfile.includes(resolution)) {
    return `"${entry}" is not in yarn.lock; remove it, or fix the name or version`;
  }
  return undefined;
}

describe(".yarnrc.yml age gate", () => {
  const yarnrc = readFileSync(join(repoDir, ".yarnrc.yml"), "utf8");
  const lockfile = readFileSync(join(repoDir, "yarn.lock"), "utf8");

  it("keeps the 7-day gate for every package", () => {
    expect(readAgeGate(yarnrc).gate).toBe("7d");
  });

  it("preapproves only exact versions that yarn.lock resolves", () => {
    const problems = readAgeGate(yarnrc)
      .preapproved.map((entry) => preapprovalProblem(entry, lockfile))
      .filter((problem) => problem !== undefined);
    expect(problems).toEqual([]);
  });
});

describe("readAgeGate", () => {
  it("reads quoted and bare list items, CRLF lines and comments", () => {
    const text = [
      'npmMinimalAgeGate: "7d"',
      "# a comment",
      "npmPreapprovedPackages:",
      "  - glob@14.0.3",
      '  - "@isaacs/nonrecursive-glob-match@1.0.3"',
      "nodeLinker: node-modules",
      "  - not-in-the-list@1.0.0",
    ].join("\r\n");
    expect(readAgeGate(text)).toEqual({
      gate: "7d",
      preapproved: ["glob@14.0.3", "@isaacs/nonrecursive-glob-match@1.0.3"],
    });
  });

  it("reports a missing gate as undefined, so the gate test fails", () => {
    expect(readAgeGate("nodeLinker: node-modules\n").gate).toBeUndefined();
  });
});

describe("preapprovalProblem", () => {
  const lockfile = [
    '"glob@npm:^14.0.3":',
    "  version: 14.0.3",
    '  resolution: "glob@npm:14.0.3"',
    '"@isaacs/nonrecursive-glob-match@npm:^1.0.3":',
    '  resolution: "@isaacs/nonrecursive-glob-match@npm:1.0.3"',
  ].join("\n");

  it("accepts exact versions of plain and scoped packages in yarn.lock", () => {
    expect(preapprovalProblem("glob@14.0.3", lockfile)).toBeUndefined();
    expect(
      preapprovalProblem("@isaacs/nonrecursive-glob-match@1.0.3", lockfile),
    ).toBeUndefined();
  });

  it.each([
    "glob",
    "glob@^14.0.3",
    "glob@14",
    "glob@*",
    "@isaacs/*",
    "glob@14.0.x",
  ])("rejects %s, which would exempt later releases", (entry) => {
    expect(preapprovalProblem(entry, lockfile)).toMatch(/not an exact version/);
  });

  it.each(["glbo@14.0.3", "glob@14.0.2", "minimatch@11.0.3"])(
    "flags %s, which yarn.lock does not resolve",
    (entry) => {
      expect(preapprovalProblem(entry, lockfile)).toMatch(/not in yarn\.lock/);
    },
  );
});
