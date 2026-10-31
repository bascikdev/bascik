/**
 * Release-time consistency the publish jobs in .github/workflows/release.yml
 * rely on but never check themselves: the manifests `npm publish` uploads
 * (pkg, create, the Cloudflare adapter, the language server) and the
 * workflow's own instructions for pushing release tags.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoDir = fileURLToPath(new URL("../../..", import.meta.url));

type Manifest = {
  name: string;
  version: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

const manifest = (dir: string): Manifest =>
  JSON.parse(readFileSync(join(repoDir, dir, "package.json"), "utf8"));

const PUBLISHED = ["pkg", "create", "adapters/cloudflare", "lsp"];
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

type Version = { core: [number, number, number]; pre: string[] };

const parseVersion = (text: string): Version => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(text);
  if (!match) throw new Error(`Not a semver version: "${text}"`);
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split(".") : [],
  };
};

const compareVersions = (a: Version, b: Version): number => {
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i];
  }
  if (a.pre.length === 0 || b.pre.length === 0) {
    return b.pre.length - a.pre.length;
  }
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) - Number(y);
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
};

/**
 * npm's rule for whether `version` satisfies a `>=X` or `^X` range, including
 * the prerelease rule: a prerelease version only matches a range whose
 * comparator is a prerelease of the same major.minor.patch. Other range
 * forms throw, so a change of style updates this test instead of passing it.
 */
const satisfies = (version: string, range: string): boolean => {
  const match = /^(>=|\^)(\S+)$/.exec(range.trim());
  if (!match)
    throw new Error(`Unsupported range form in this check: "${range}"`);
  const [, operator, floorText] = match;
  const v = parseVersion(version);
  const floor = parseVersion(floorText);
  if (compareVersions(v, floor) < 0) return false;
  if (v.pre.length > 0) {
    const sameCore = v.core.every((part, i) => part === floor.core[i]);
    if (!sameCore || floor.pre.length === 0) return false;
  }
  if (operator === "^") {
    const [major, minor, patch] = floor.core;
    const ceiling: Version =
      major > 0
        ? { core: [major + 1, 0, 0], pre: ["0"] }
        : minor > 0
          ? { core: [0, minor + 1, 0], pre: ["0"] }
          : { core: [0, 0, patch + 1], pre: ["0"] };
    if (compareVersions(v, ceiling) >= 0) return false;
  }
  return true;
};

describe("the range check used below", () => {
  it("applies npm's prerelease rule", () => {
    expect(satisfies("0.1.0-rc.6", ">=0.1.0-rc.6")).toBe(true);
    expect(satisfies("0.1.0-rc.7", ">=0.1.0-rc.6")).toBe(true);
    expect(satisfies("0.1.0", ">=0.1.0-rc.6")).toBe(true);
    expect(satisfies("0.2.0", ">=0.1.0-rc.6")).toBe(true);
    // The stale-peer case: a bumped prerelease of another patch tuple.
    expect(satisfies("0.2.0-rc.1", ">=0.1.0-rc.6")).toBe(false);
    expect(satisfies("0.1.1-rc.1", ">=0.1.0-rc.6")).toBe(false);
    expect(satisfies("0.1.0-rc.5", ">=0.1.0-rc.6")).toBe(false);
    expect(satisfies("1.0.0-rc.11", "^1.0.0-rc.10")).toBe(true);
    expect(satisfies("1.4.2", "^1.0.0-rc.10")).toBe(true);
    expect(satisfies("2.0.0", "^1.0.0-rc.10")).toBe(false);
    expect(satisfies("0.2.0", "^0.1.0-rc.6")).toBe(false);
  });

  it("misuse: refuses a range form it does not implement", () => {
    expect(() => satisfies("1.0.0", "1.x || 2.x")).toThrow(/Unsupported/);
    expect(() => satisfies("latest", ">=1.0.0")).toThrow(/Not a semver/);
  });
});

describe("published package manifests", () => {
  // npm publish does not rewrite Yarn's workspace: protocol, so the registry
  // copy would carry it and any npm install inside the package fails with
  // EUNSUPPORTEDPROTOCOL.
  it("use no workspace: specs, which npm publish would upload as-is", () => {
    const offenders: string[] = [];
    for (const dir of PUBLISHED) {
      const pkg = manifest(dir);
      expect(pkg.private, dir).not.toBe(true);
      for (const field of DEPENDENCY_FIELDS) {
        for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
          if (spec.startsWith("workspace:")) {
            offenders.push(`${dir} ${field}.${name}: ${spec}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // With a semver range instead of workspace:*, Yarn links the workspace only
  // while the range includes pkg's version; past that it would install
  // @bascik/bascik from the registry and the adapter's tests would run
  // against the wrong compiler.
  it("the adapter's dev dependency on @bascik/bascik matches its peer and pkg's version", () => {
    const adapter = manifest("adapters/cloudflare");
    const pkg = manifest("pkg");
    const dev = adapter.devDependencies?.["@bascik/bascik"];
    expect(dev).toBe(adapter.peerDependencies?.["@bascik/bascik"]);
    expect(satisfies(pkg.version, dev!), `${pkg.version} vs ${dev}`).toBe(true);
  });

  // Bumping lsp/package.json to another patch tuple's prerelease (0.2.0-rc.1)
  // while pkg's peer stays >=0.1.0-rc.6 makes every scaffolded project warn
  // about an invalid peer.
  it("pkg's optional peer range on @bascik/language-server includes the lsp version", () => {
    const pkg = manifest("pkg");
    const lsp = manifest("lsp");
    const range = pkg.peerDependencies?.["@bascik/language-server"];
    expect(range).toBeDefined();
    expect(satisfies(lsp.version, range!), `${lsp.version} vs ${range}`).toBe(
      true,
    );
  });
});

describe("release.yml instructions", () => {
  const workflow = readFileSync(
    join(repoDir, ".github/workflows/release.yml"),
    "utf8",
  );

  // RELEASING.md: push tags by name, so only the intended tags trigger jobs.
  // `git push --tags` pushes every local tag, stale dry-run tags included,
  // and can start a publish job out of the documented order.
  it("never tells a releaser to push every tag at once", () => {
    expect(workflow).not.toMatch(/git push[^\n]*--tags/);
  });

  it("misuse: no release doc tells a releaser to push every tag at once", () => {
    for (const doc of ["RELEASING.md", "docs/content/internals/ci-cd.md"]) {
      const text = readFileSync(join(repoDir, doc), "utf8");
      const pushAll = text
        .split("\n")
        .filter((line) => /^\s*git push\b.*--tags/.test(line));
      expect(pushAll, doc).toEqual([]);
    }
  });

  it("pushes each documented tag by name to origin", () => {
    const commands = [...workflow.matchAll(/^#.*git tag (\S+) && (.*)$/gm)];
    expect(commands.length).toBeGreaterThanOrEqual(6);
    for (const [, tag, push] of commands) {
      expect(push.trim().split(/\s{2,}/)[0]).toBe(`git push origin ${tag}`);
    }
  });
});
