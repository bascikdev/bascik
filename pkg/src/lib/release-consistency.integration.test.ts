/**
 * Packet L1: cross-artifact release candidate verifier.
 *
 * Requirements:
 * - A test-owned, purely static verifier that validates a built release
 *   candidate's cross-artifact consistency: manifest <-> disk, CSP <-> emitted
 *   HTML, script sidecar <-> placeholders, asset references, and pinned
 *   provenance (project roots, sources, API modules, dependencies, and
 *   reachable symlink targets, not only output folders).
 * - Negative controls: missing referenced asset, missing/stale script sidecar,
 *   incorrect manifest/CSP hash.
 * - Verify actual complete A/B builds, including buffered and streamed scripts.
 * - The verifier never executes arbitrary handlers during static validation and
 *   does not start a production server. A bad asset/CSP candidate must fail this
 *   verifier; production readiness is not assumed to check those artifacts.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  cleanupFixture,
  createFixtureDirs,
  fixtureRoot,
  hashBytes,
  readEmittedFiles,
  runRealBuild,
  writeFixtureFile,
  writeWorkersConfig,
} from "./build-fixtures.ts";
import { computePageCspHashes } from "./csp-hashes.ts";

// ─── Verifier (test-owned, static) ───────────────────────────────────────────

export interface ReleaseCandidate {
  projectRoot: string;
  distDir: string;
  /** dist-relative path -> emitted bytes (includes .bascik metadata). */
  emittedFiles: Record<string, Buffer>;
  /** Declared provenance that must resolve for the release to be pinned. */
  provenance: {
    sources: string[];
    apiModules: string[];
    dependencies: string[];
    symlinkTargets: string[];
  };
}

export interface VerificationResult {
  ok: boolean;
  failures: string[];
}

/** Map an HTTP route key from csp-hashes.json to its emitted HTML file. */
const routeToEmittedFile = (route: string): string => {
  if (route === "/") return "index.html";
  const p = route.replace(/^\//, "");
  if (p.endsWith("/")) return `${p}index.html`;
  return `${p}.html`;
};

const arraysEqual = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** Resolve an HTML src/href reference against the emitting file's directory. */
const normalizeAssetRef = (dir: string, ref: string): string => {
  if (ref.startsWith("/")) return ref.replace(/^\//, "");
  const parts = [...dir.split("/").filter(Boolean), ...ref.split("/")];
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack.join("/");
};

/** Every manifest.files[rel] must exist on disk with matching hash and size. */
const verifyManifestCorrespondence = (candidate: ReleaseCandidate, failures: string[]): void => {
  const manifest = JSON.parse(
    candidate.emittedFiles[".bascik/manifest.json"]?.toString("utf8") ?? "{}",
  ) as { files?: Record<string, { hash: string; size: number }> };
  const files = manifest.files ?? {};
  for (const [rel, entry] of Object.entries(files)) {
    const disk = candidate.emittedFiles[rel];
    if (!disk) {
      failures.push(`manifest references ${rel} but it is missing from disk`);
      continue;
    }
    if (entry.hash !== hashBytes(disk)) {
      failures.push(`manifest hash mismatch for ${rel}`);
    }
    if (entry.size !== disk.length) {
      failures.push(`manifest size mismatch for ${rel}`);
    }
  }
};

/** Every csp-hashes.json route must match the hashes recomputed from emitted HTML. */
const verifyCspCorrespondence = (candidate: ReleaseCandidate, failures: string[]): void => {
  const csp = JSON.parse(
    candidate.emittedFiles[".bascik/csp-hashes.json"]?.toString("utf8") ?? "{}",
  ) as Record<string, { scripts: string[]; styles: string[] }>;
  for (const [route, recorded] of Object.entries(csp)) {
    const emittedRel = routeToEmittedFile(route);
    const html = candidate.emittedFiles[emittedRel]?.toString("utf8");
    if (html === undefined) {
      failures.push(`csp route ${route} has no emitted file ${emittedRel}`);
      continue;
    }
    const computed = computePageCspHashes(html);
    if (!arraysEqual(computed.scripts, recorded.scripts)) {
      failures.push(`csp script hashes mismatch for ${route}`);
    }
    if (!arraysEqual(computed.styles, recorded.styles)) {
      failures.push(`csp style hashes mismatch for ${route}`);
    }
  }
};

/** Every sidecar placeholder must resolve; every sidecar entry must be referenced. */
const verifySidecarCorrespondence = (candidate: ReleaseCandidate, failures: string[]): void => {
  const sidecar = JSON.parse(
    candidate.emittedFiles[".bascik/server-scripts.json"]?.toString("utf8") ?? '{"scripts":{}}',
  ) as { scripts?: Record<string, { mode?: string }> };
  const scripts = sidecar.scripts ?? {};

  const placeholderIds = new Set<string>();
  for (const [rel, buf] of Object.entries(candidate.emittedFiles)) {
    if (!rel.endsWith(".html")) continue;
    const html = buf.toString("utf8");
    const re = /data-bascik-server-id="([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) placeholderIds.add(m[1]);
  }

  for (const id of placeholderIds) {
    const entry = scripts[id];
    if (!entry) {
      failures.push(`placeholder ${id} has no sidecar entry`);
      continue;
    }
    if (entry.mode !== "server" && entry.mode !== "stream") {
      failures.push(`sidecar entry ${id} has invalid mode "${entry.mode}"`);
    }
  }
  for (const id of Object.keys(scripts)) {
    if (!placeholderIds.has(id)) {
      failures.push(`sidecar entry ${id} is not referenced by any placeholder`);
    }
  }
};

/** Every HTML src/href reference must resolve within the release. */
const verifyAssetReferences = (candidate: ReleaseCandidate, failures: string[]): void => {
  for (const [rel, buf] of Object.entries(candidate.emittedFiles)) {
    if (!rel.endsWith(".html")) continue;
    const html = buf.toString("utf8");
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    const refRe = /\b(?:src|href)="([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = refRe.exec(html)) !== null) {
      const ref = m[1];
      if (/^(?:https?:|mailto:|tel:|data:|#)/.test(ref)) continue;
      const resolved = normalizeAssetRef(dir, ref);
      if (!candidate.emittedFiles[resolved]) {
        failures.push(`${rel} references missing asset ${ref}`);
      }
    }
  }
};

/** Declared provenance (roots, sources, API modules, deps, symlink targets) must resolve. */
const verifyPinnedProvenance = (candidate: ReleaseCandidate, failures: string[]): void => {
  const { projectRoot, provenance } = candidate;
  for (const src of provenance.sources) {
    if (!existsSync(resolve(projectRoot, src))) {
      failures.push(`declared source ${src} does not resolve`);
    }
  }
  for (const api of provenance.apiModules) {
    if (!existsSync(resolve(projectRoot, api))) {
      failures.push(`declared api module ${api} does not resolve`);
    }
  }
  for (const dep of provenance.dependencies) {
    if (!existsSync(resolve(projectRoot, "node_modules", dep))) {
      failures.push(`declared dependency ${dep} does not resolve`);
    }
  }
  for (const target of provenance.symlinkTargets) {
    if (!existsSync(resolve(projectRoot, target))) {
      failures.push(`declared symlink target ${target} does not resolve`);
    }
  }
};

/** Orchestrator: collects all failures, never throws mid-way. */
export const verifyReleaseCandidate = (candidate: ReleaseCandidate): VerificationResult => {
  const failures: string[] = [];
  verifyManifestCorrespondence(candidate, failures);
  verifyCspCorrespondence(candidate, failures);
  verifySidecarCorrespondence(candidate, failures);
  verifyAssetReferences(candidate, failures);
  verifyPinnedProvenance(candidate, failures);
  return { ok: failures.length === 0, failures };
};

// ─── Fixture ─────────────────────────────────────────────────────────────────

/**
 * A release fixture with a buffered server script, a streamed server script, an
 * HTML-referenced asset, an API module, a local dependency, and a symlink target.
 */
const writeReleaseFixture = async (root: string): Promise<void> => {
  await createFixtureDirs(root);
  await writeWorkersConfig(root, true);
  await mkdir(join(root, "src/api"), { recursive: true });
  await mkdir(join(root, "node_modules/local-dep"), { recursive: true });

  await writeFixtureFile(
    root,
    "src/components/card.html",
    `<article class="card"><slot></slot></article>`,
  );
  await writeFixtureFile(
    root,
    "src/components/card.style.css",
    `.card { border: 1px solid #ccc; }`,
  );

  // Buffered server script page with an inline style and a referenced asset.
  await writeFixtureFile(
    root,
    "src/pages/index.html",
    `<!DOCTYPE html><html><head><title>Home</title><style>.inline{color:red}</style></head><body>
  <h1 data-testid="home">Home</h1>
  <script data-bascik-server>export default () => new Response('buffered');</script>
  <img src="/assets/logo.txt" alt="logo">
  </body></html>`,
  );

  // Streamed server script page.
  await writeFixtureFile(
    root,
    "src/pages/stream.html",
    `<!DOCTYPE html><html><head><title>Stream</title></head><body>
  <p data-testid="stream">Stream page</p>
  <script data-bascik-stream>export default () => new Response('streamed');</script>
  </body></html>`,
  );

  await writeFixtureFile(root, "src/pages/assets/logo.txt", "raw asset bytes\n");

  // API module (served at runtime; pinned as source provenance, not emitted).
  await writeFixtureFile(root, "src/api/hello.ts", "export const GET = () => new Response('hi');");

  // Local dependency.
  await writeFixtureFile(root, "node_modules/local-dep/index.js", "module.exports = 1;");
  await writeFixtureFile(
    root,
    "node_modules/local-dep/package.json",
    JSON.stringify({ name: "local-dep", version: "1.0.0" }),
  );

  // Reachable symlink target.
  await symlink(join(root, "src/components/card.html"), join(root, "linked-card.html"));
};

const makeCandidate = (projectRoot: string, emitted: Record<string, Buffer>): ReleaseCandidate => ({
  projectRoot,
  distDir: join(projectRoot, "dist"),
  emittedFiles: emitted,
  provenance: {
    sources: ["src/pages", "src/components"],
    apiModules: ["src/api/hello.ts"],
    dependencies: ["local-dep"],
    symlinkTargets: ["linked-card.html"],
  },
});

const cloneEmitted = (emitted: Record<string, Buffer>): Record<string, Buffer> =>
  Object.fromEntries(Object.entries(emitted).map(([k, v]) => [k, Buffer.from(v)]));

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("packet L1: cross-artifact release candidate verifier", () => {
  let baselineRoot: string;
  let baselineEmitted: Record<string, Buffer>;

  beforeAll(async () => {
    baselineRoot = fixtureRoot("l1-baseline");
    await writeReleaseFixture(baselineRoot);
    const result = await runRealBuild({ projectRoot: baselineRoot });
    expect(result.stdout).toContain("Build complete");
    baselineEmitted = await readEmittedFiles(join(baselineRoot, "dist"));
  });

  afterAll(async () => {
    await cleanupFixture(baselineRoot);
  });

  describe("step 1: verifier oracle and negative controls", () => {
    it("accepts the unmodified baseline release (positive oracle)", () => {
      const result = verifyReleaseCandidate(makeCandidate(baselineRoot, cloneEmitted(baselineEmitted)));
      expect(result.ok).toBe(true);
      expect(result.failures).toEqual([]);
    });

    it("rejects a missing referenced asset (negative control)", () => {
      const emitted = cloneEmitted(baselineEmitted);
      delete emitted["assets/logo.txt"];
      const result = verifyReleaseCandidate(makeCandidate(baselineRoot, emitted));
      expect(result.ok).toBe(false);
      expect(result.failures.join("\n")).toMatch(/references missing asset/);
    });

    it("rejects a missing script sidecar entry (negative control)", () => {
      const emitted = cloneEmitted(baselineEmitted);
      const sidecar = JSON.parse(emitted[".bascik/server-scripts.json"].toString("utf8"));
      const firstId = Object.keys(sidecar.scripts)[0];
      delete sidecar.scripts[firstId];
      emitted[".bascik/server-scripts.json"] = Buffer.from(JSON.stringify(sidecar), "utf8");
      const result = verifyReleaseCandidate(makeCandidate(baselineRoot, emitted));
      expect(result.ok).toBe(false);
      expect(result.failures.join("\n")).toMatch(/has no sidecar entry/);
    });

    it("rejects a stale sidecar mode (negative control)", () => {
      const emitted = cloneEmitted(baselineEmitted);
      const sidecar = JSON.parse(emitted[".bascik/server-scripts.json"].toString("utf8"));
      const firstId = Object.keys(sidecar.scripts)[0];
      sidecar.scripts[firstId].mode = "invalid";
      emitted[".bascik/server-scripts.json"] = Buffer.from(JSON.stringify(sidecar), "utf8");
      const result = verifyReleaseCandidate(makeCandidate(baselineRoot, emitted));
      expect(result.ok).toBe(false);
      expect(result.failures.join("\n")).toMatch(/invalid mode/);
    });

    it("rejects an incorrect manifest hash (negative control)", () => {
      const emitted = cloneEmitted(baselineEmitted);
      const manifest = JSON.parse(emitted[".bascik/manifest.json"].toString("utf8"));
      const firstRel = Object.keys(manifest.files)[0];
      manifest.files[firstRel].hash = "deadbeef";
      emitted[".bascik/manifest.json"] = Buffer.from(JSON.stringify(manifest), "utf8");
      const result = verifyReleaseCandidate(makeCandidate(baselineRoot, emitted));
      expect(result.ok).toBe(false);
      expect(result.failures.join("\n")).toMatch(/manifest hash mismatch/);
    });

    it("rejects an incorrect CSP hash (negative control)", () => {
      const emitted = cloneEmitted(baselineEmitted);
      const csp = JSON.parse(emitted[".bascik/csp-hashes.json"].toString("utf8"));
      const firstRoute = Object.keys(csp)[0];
      if (csp[firstRoute].scripts.length > 0) {
        csp[firstRoute].scripts[0] = "sha256-deadbeef";
      } else {
        csp[firstRoute].styles[0] = "sha256-deadbeef";
      }
      emitted[".bascik/csp-hashes.json"] = Buffer.from(JSON.stringify(csp), "utf8");
      const result = verifyReleaseCandidate(makeCandidate(baselineRoot, emitted));
      expect(result.ok).toBe(false);
      expect(result.failures.join("\n")).toMatch(/csp .* hashes mismatch/);
    });

    it("rejects an altered emitted byte (negative control)", () => {
      const emitted = cloneEmitted(baselineEmitted);
      const html = emitted["index.html"].toString("utf8");
      emitted["index.html"] = Buffer.from(`${html}<!-- tampered -->`, "utf8");
      const result = verifyReleaseCandidate(makeCandidate(baselineRoot, emitted));
      expect(result.ok).toBe(false);
      expect(result.failures.join("\n")).toMatch(/manifest hash mismatch/);
    });

    it("rejects missing pinned provenance (negative control)", () => {
      const emitted = cloneEmitted(baselineEmitted);
      const candidate = makeCandidate(baselineRoot, emitted);
      candidate.provenance = {
        ...candidate.provenance,
        apiModules: ["src/api/missing.ts"],
      };
      const result = verifyReleaseCandidate(candidate);
      expect(result.ok).toBe(false);
      expect(result.failures.join("\n")).toMatch(/api module .* does not resolve/);
    });
  });

  describe("step 2: complete A/B builds pass the verifier", () => {
    it("validates two complete builds including buffered and streamed scripts", async () => {
      const rootA = fixtureRoot("l1-release-a");
      const rootB = fixtureRoot("l1-release-b");
      try {
        await writeReleaseFixture(rootA);
        await writeReleaseFixture(rootB);

        const runA = await runRealBuild({ projectRoot: rootA });
        const runB = await runRealBuild({ projectRoot: rootB });
        expect(runA.stdout).toContain("Build complete");
        expect(runB.stdout).toContain("Build complete");

        const emittedA = await readEmittedFiles(join(rootA, "dist"));
        const emittedB = await readEmittedFiles(join(rootB, "dist"));

        const resultA = verifyReleaseCandidate(makeCandidate(rootA, emittedA));
        const resultB = verifyReleaseCandidate(makeCandidate(rootB, emittedB));
        expect(resultA.ok).toBe(true);
        expect(resultA.failures).toEqual([]);
        expect(resultB.ok).toBe(true);
        expect(resultB.failures).toEqual([]);

        // Both sidecars must carry a buffered ("server") and a streamed ("stream") entry.
        for (const emitted of [emittedA, emittedB]) {
          const sidecar = JSON.parse(emitted[".bascik/server-scripts.json"].toString("utf8")) as {
            scripts: Record<string, { mode: string }>;
          };
          const modes = Object.values(sidecar.scripts).map((e) => e.mode);
          expect(modes).toContain("server");
          expect(modes).toContain("stream");
        }
      } finally {
        await cleanupFixture(rootA);
        await cleanupFixture(rootB);
      }
    });
  });
});