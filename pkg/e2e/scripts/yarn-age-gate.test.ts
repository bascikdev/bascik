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
 * uses are read: `key: value` at column 0, and `npmPreapprovedPackages:`
 * followed by indented `  - item` lines. Quotes around a value are removed.
 *
 * Yarn reads full YAML, so the reader fails closed: any other shape that could
 * set these two keys is returned in `problems` instead of being skipped. That
 * covers a flow list (`npmPreapprovedPackages: ["*"]`, which turns the gate off
 * for every package), column-0 list items, quoted or spaced keys, repeated
 * keys, anchors, a second document, and the per-scope and per-registry
 * settings (`npmScopes`, `npmRegistries`) that can carry their own gate.
 */
function readAgeGate(yarnrc: string): {
  gate: string | undefined;
  preapproved: string[];
  problems: string[];
} {
  const unquote = (value: string) => value.trim().replace(/^"(.*)"$/, "$1");
  const ageGateKeys = /npmMinimalAgeGate|npmPreapprovedPackages/;
  let gate: string | undefined;
  const preapproved: string[] = [];
  const problems: string[] = [];
  const seenKeys = new Set<string>();
  let inList = false;
  for (const [index, line] of yarnrc.split(/\r?\n|\r/).entries()) {
    const where = `line ${index + 1} (${line.trim()})`;
    if (/^\s*(#|$)/.test(line)) continue;
    if (/^\s/.test(line)) {
      if (inList) {
        const item = /^\s+-\s+(.+)$/.exec(line);
        if (item) preapproved.push(unquote(item[1]));
        else problems.push(`${where}: expected "  - name@x.y.z"`);
      } else if (ageGateKeys.test(line)) {
        problems.push(`${where}: an age-gate setting nested under another key`);
      }
      continue;
    }
    inList = false;
    const entry = /^([A-Za-z]+):(?:\s+(.*))?$/.exec(line);
    if (!entry) {
      problems.push(`${where}: not a plain "key: value" line`);
      continue;
    }
    const [, key, value = ""] = entry;
    if (seenKeys.has(key)) problems.push(`${where}: ${key} is set twice`);
    seenKeys.add(key);
    if (key === "npmScopes" || key === "npmRegistries") {
      problems.push(
        `${where}: ${key} can set its own age gate; check it here before adding it`,
      );
    }
    if (key === "npmMinimalAgeGate") {
      if (!/^("[^"]*"|[A-Za-z0-9]+)$/.test(value)) {
        problems.push(`${where}: write the gate as a plain or quoted value`);
      }
      gate = unquote(value);
    }
    if (key === "npmPreapprovedPackages") {
      if (value === "") inList = true;
      else problems.push(`${where}: write the list as indented "  - " items`);
    }
  }
  return { gate, preapproved, problems };
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

  it("uses only the shapes the reader checks", () => {
    expect(readAgeGate(yarnrc).problems).toEqual([]);
  });

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
      problems: [],
    });
  });

  it("reports a missing gate as undefined, so the gate test fails", () => {
    expect(readAgeGate("nodeLinker: node-modules\n").gate).toBeUndefined();
  });

  it("reads the file's own shapes with no problems", () => {
    const text = [
      'npmMinimalAgeGate: "7d"',
      "npmPreapprovedPackages:",
      "  - glob@14.0.3",
    ].join("\n");
    expect(readAgeGate(text).problems).toEqual([]);
  });

  it.each([
    ["a flow list", 'npmPreapprovedPackages: ["glob", "*"]'],
    ["an inline value", 'npmPreapprovedPackages: "*"'],
    ["column-0 list items", 'npmPreapprovedPackages:\n- glob\n- "*"'],
    ["a quoted key", '"npmPreapprovedPackages":\n  - "*"'],
    ["a key spaced from its colon", "npmPreapprovedPackages :\n  - '*'"],
    ["a flow mapping", '{npmPreapprovedPackages: ["*"]}'],
    ["a repeated key", "npmPreapprovedPackages:\nnpmPreapprovedPackages:"],
    [
      "an indented line that is not an item",
      "npmPreapprovedPackages:\n  glob: '*'",
    ],
    ["a per-scope gate", "npmScopes:\n  isaacs:\n    npmMinimalAgeGate: 0"],
    ["an inline per-scope gate", "npmScopes: {isaacs: {npmMinimalAgeGate: 0}}"],
    [
      "a per-registry setting",
      "npmRegistries:\n  //registry.npmjs.org:\n    npmAuthToken: x",
    ],
    ["a gate behind an anchor", "npmMinimalAgeGate: &gate 0"],
    ["a second document", 'npmMinimalAgeGate: "7d"\n---\nnpmMinimalAgeGate: 0'],
  ])("reports %s as a problem instead of skipping it", (_shape, text) => {
    expect(readAgeGate(text).problems.length).toBeGreaterThan(0);
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
