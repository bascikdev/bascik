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

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, symlink, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
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

const PKG_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "../index.ts");

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

// ─── L2: rejected candidate, activation, drain, rollback ────────────────────

let l2PortCounter = 10800 + (process.pid % 100);
const nextL2Port = (): number => l2PortCounter++;

interface RunningProdChild {
  child: ChildProcess;
  port: number;
  url: string;
  output: () => string;
  exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/**
 * Spawn a real production child (`bascik --server`) against a built fixture.
 * Waits for the "Server running at" line before resolving. The child is the
 * test's responsibility to terminate; callers must kill it in `finally`.
 */
const spawnProdChild = async (
  root: string,
  options: { tls?: boolean } = {},
): Promise<RunningProdChild> => {
  const port = nextL2Port();
  const child = spawn(process.execPath, [PKG_ENTRY, "--server"], {
    cwd: root,
    env: {
      ...process.env,
      BASCIK_SERVER_PORT: String(port),
      BASCIK_BUILD: "0",
      BASCIK_SERVER: "1",
      VITEST: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  const onData = (d: Buffer) => {
    output += d.toString();
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);

  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit) => {
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    },
  );

  await new Promise<void>((res, rej) => {
    const timer = setTimeout(() => {
      rej(new Error(`Prod server failed to boot within 15s. Output:\n${output}`));
    }, 15000);
    const check = () => {
      if (output.includes("Server running at")) {
        clearTimeout(timer);
        res();
      } else if (child.exitCode !== null) {
        clearTimeout(timer);
        rej(new Error(`Prod server exited early with code ${child.exitCode}. Output:\n${output}`));
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });

  const scheme = options.tls ? "https" : "http";
  return { child, port, url: `${scheme}://localhost:${port}`, output: () => output, exitPromise };
};

/** Poll `/_health/ready` until it returns the expected status (200 ready, 503 otherwise). */
const waitForHealth = async (
  url: string,
  expectedStatus: number,
  _tls: boolean,
  timeoutMs = 15000,
): Promise<void> => {
  const start = Date.now();
  const target = new URL(url);
  const isHttps = target.protocol === "https:";
  const client = isHttps ? https : http;
  while (Date.now() - start < timeoutMs) {
    const status = await new Promise<number>((resolveStatus) => {
      const req = client.request(
        {
          host: target.hostname,
          port: target.port,
          path: "/_health/ready",
          method: "GET",
          rejectUnauthorized: false,
        } as http.RequestOptions,
        (res) => {
          res.resume();
          resolveStatus(res.statusCode ?? 0);
        },
      );
      req.on("error", () => resolveStatus(0));
      req.end();
    });
    if (status === expectedStatus) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Health check on ${url} never reached status ${expectedStatus}`);
};

/** HTTP/1.1 GET helper returning status + body. */
const httpGet = (url: string, path: string): Promise<{ status: number; body: string }> =>
  new Promise((resolveReq, reject) => {
    const target = new URL(url);
    const req = http.request(
      { host: target.hostname, port: target.port, path, method: "GET" },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () =>
          resolveReq({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });

/** True HTTP/2 GET helper returning status + body. */
const http2Get = (url: string, path: string): Promise<{ status: number; body: string }> =>
  new Promise((resolveReq, reject) => {
    const target = new URL(url);
    const client = http2.connect(`https://${target.hostname}:${target.port}`, {
      rejectUnauthorized: false,
    });
    client.on("error", reject);
    const req = client.request({ ":path": path, ":method": "GET" });
    const chunks: Buffer[] = [];
    req.on("response", (headers) => {
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        client.close();
        resolveReq({ status: Number(headers[":status"] ?? 0), body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    req.on("error", (err) => {
      client.close();
      reject(err);
    });
    req.end();
  });

/**
 * A release fixture whose buffered server script blocks on a gate file. The
 * test writes/removes `<root>/gate` to hold or release an accepted request.
 * The gate is test-owned: the child reads it from disk, so no IPC is needed.
 */
const writeGatedReleaseFixture = async (root: string): Promise<void> => {
  await createFixtureDirs(root);
  await writeWorkersConfig(root, true);
  await mkdir(join(root, "src/api"), { recursive: true });
  await mkdir(join(root, "node_modules/local-dep"), { recursive: true });
  await writeFixtureFile(
    root,
    "src/components/card.html",
    `<article class="card"><slot></slot></article>`,
  );
  await writeFixtureFile(root, "src/api/hello.ts", "export const GET = () => new Response('hi');");
  await writeFixtureFile(root, "node_modules/local-dep/index.js", "module.exports = 1;");
  await writeFixtureFile(
    root,
    "node_modules/local-dep/package.json",
    JSON.stringify({ name: "local-dep", version: "1.0.0" }),
  );
  await symlink(join(root, "src/components/card.html"), join(root, "linked-card.html"));
  await writeFixtureFile(
    root,
    "src/pages/index.html",
    `<!DOCTYPE html><html><head><title>Gated</title></head><body>
  <h1 data-testid="gated">Gated release</h1>
  <script data-bascik-server>
  import { readFile } from "node:fs/promises";
  import { join } from "node:path";
  export default async () => {
    while (true) {
      try {
        const gate = await readFile(join(process.cwd(), "gate"), "utf8");
        return gate.trim();
      } catch {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
  };
  </script>
  </body></html>`,
  );
};

/** Build a release and return its emitted inventory. */
const buildRelease = async (root: string): Promise<Record<string, Buffer>> => {
  const result = await runRealBuild({ projectRoot: root });
  expect(result.stdout).toContain("Build complete");
  return readEmittedFiles(join(root, "dist"));
};

describe("packet L2: rejected candidate, activation, drain, rollback", () => {
  const children: RunningProdChild[] = [];

  const track = (c: RunningProdChild): RunningProdChild => {
    children.push(c);
    return c;
  };

  afterEach(async () => {
    for (const c of children) {
      if (c.child.exitCode === null) {
        c.child.kill("SIGKILL");
        await c.exitPromise;
      }
    }
    children.length = 0;
  });

  describe("step 1: rejected candidate and admission failure", () => {
    it("keeps A serving while B fails verification and is never routed to", async () => {
      const rootA = fixtureRoot("l2-reject-a");
      const rootB = fixtureRoot("l2-reject-b");
      try {
        await writeGatedReleaseFixture(rootA);
        await writeGatedReleaseFixture(rootB);
        await writeFile(join(rootA, "gate"), "A-RESPONSE", "utf8");
        await writeFile(join(rootB, "gate"), "B-RELEASED", "utf8");
        const emittedA = await buildRelease(rootA);
        const emittedB = await buildRelease(rootB);

        // B is a bad candidate: corrupt a manifest hash so the verifier rejects it.
        const manifest = JSON.parse(emittedB[".bascik/manifest.json"].toString("utf8"));
        const firstRel = Object.keys(manifest.files)[0];
        manifest.files[firstRel].hash = "deadbeef";
        emittedB[".bascik/manifest.json"] = Buffer.from(JSON.stringify(manifest), "utf8");
        const verdict = verifyReleaseCandidate(makeCandidate(rootB, emittedB));
        expect(verdict.ok).toBe(false);
        expect(verdict.failures.join("\n")).toMatch(/manifest hash mismatch/);

        // A is valid and serves.
        const verdictA = verifyReleaseCandidate(makeCandidate(rootA, emittedA));
        expect(verdictA.ok).toBe(true);

        const a = track(await spawnProdChild(rootA));
        await waitForHealth(a.url, 200, false);
        const res = await httpGet(a.url, "/");
        expect(res.status).toBe(200);
        expect(res.body).toContain("Gated release");

        // The test-owned router never routes to B because B failed verification.
        expect(verdict.ok).toBe(false);
      } finally {
        await cleanupFixture(rootA);
        await cleanupFixture(rootB);
      }
    }, 30000);

    it("rejects a candidate at admission: B's child exits before binding, A stays healthy", async () => {
      const rootA = fixtureRoot("l2-admit-a");
      const rootB = fixtureRoot("l2-admit-b");
      try {
        await writeGatedReleaseFixture(rootA);
        await writeGatedReleaseFixture(rootB);
        await writeFile(join(rootA, "gate"), "A-RESPONSE", "utf8");
        await buildRelease(rootA);
        await buildRelease(rootB);

        // Corrupt B's sidecar so production admission rejects it before binding.
        const sidecarPath = join(rootB, "dist", ".bascik", "server-scripts.json");
        await writeFile(sidecarPath, "{corrupt", "utf8");

        const a = track(await spawnProdChild(rootA));
        await waitForHealth(a.url, 200, false);

        // B's child must fail to boot (admission rejects before the socket binds).
        const b = spawn(process.execPath, [PKG_ENTRY, "--server"], {
          cwd: rootB,
          env: {
            ...process.env,
            BASCIK_SERVER_PORT: String(nextL2Port()),
            BASCIK_BUILD: "0",
            BASCIK_SERVER: "1",
            VITEST: "",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let bOutput = "";
        b.stdout?.on("data", (d) => (bOutput += d.toString()));
        b.stderr?.on("data", (d) => (bOutput += d.toString()));
        const bExit = await Promise.race([
          new Promise<number | null>((r) => b.once("exit", (code) => r(code))),
          new Promise<number | null>((r) => setTimeout(() => r(null), 10000)),
        ]);
        if (bExit === null) {
          b.kill("SIGKILL");
          throw new Error(`B child did not exit on corrupt sidecar. Output:\n${bOutput}`);
        }
        expect(bExit).not.toBe(0);
        expect(bOutput).toMatch(/Failed to load server scripts sidecar/);

        // A remains healthy after B's admission failure.
        const res = await httpGet(a.url, "/");
        expect(res.status).toBe(200);
        expect(res.body).toContain("Gated release");
      } finally {
        await cleanupFixture(rootA);
        await cleanupFixture(rootB);
      }
    }, 30000);
  });

  describe("step 2: HTTP/1.1 activation, drain, rollback", () => {
    it("holds an accepted A request, drains A, releases it, then routes to validated B", async () => {
      const rootA = fixtureRoot("l2-drain-a");
      const rootB = fixtureRoot("l2-drain-b");
      try {
        await writeGatedReleaseFixture(rootA);
        await writeGatedReleaseFixture(rootB);
        await writeFile(join(rootA, "gate"), "A-RESPONSE", "utf8");
        await writeFile(join(rootB, "gate"), "B-RESPONSE", "utf8");
        await buildRelease(rootA);
        await buildRelease(rootB);

        const a = track(await spawnProdChild(rootA));
        await waitForHealth(a.url, 200, false);

        // Hold the gate closed so an accepted A request blocks.
        await rm(join(rootA, "gate"), { force: true });
        const heldReq = httpGet(a.url, "/");
        await new Promise((r) => setTimeout(r, 300));

        // Initiate drain on A. The child must observe drain entry while the
        // accepted request is still held. After SIGTERM the server stops
        // accepting new connections, so readiness is observed via the child's
        // drain entry (the "shutting down gracefully" line) rather than a fresh
        // health poll, which would be refused by server.close().
        a.child.kill("SIGTERM");
        await new Promise<void>((resolveDrain) => {
          const start = Date.now();
          const check = () => {
            if (a.output().includes("shutting down gracefully")) {
              resolveDrain();
            } else if (Date.now() - start > 10000) {
              throw new Error(`A never entered drain. Output:\n${a.output()}`);
            } else {
              setTimeout(check, 50);
            }
          };
          check();
        });

        // The accepted request is still held while A is draining.
        let heldSettled = false;
        void heldReq.then(() => {
          heldSettled = true;
        });
        await new Promise((r) => setTimeout(r, 200));
        expect(heldSettled).toBe(false);

        // Release the gate; the held request completes with the exact response.
        await writeFile(join(rootA, "gate"), "A-RESPONSE", "utf8");
        const held = await heldReq;
        expect(held.status).toBe(200);
        expect(held.body).toContain("A-RESPONSE");

        // A exits cleanly after drain.
        const { code } = await a.exitPromise;
        expect(code).toBe(0);

        // Route to validated B only after readiness.
        const b = track(await spawnProdChild(rootB));
        await waitForHealth(b.url, 200, false);
        const resB = await httpGet(b.url, "/");
        expect(resB.status).toBe(200);
        expect(resB.body).toContain("B-RESPONSE");
      } finally {
        await cleanupFixture(rootA);
        await cleanupFixture(rootB);
      }
    }, 30000);

    it("rolls back to a validated A process after B is rejected", async () => {
      const rootA = fixtureRoot("l2-rollback-a");
      const rootB = fixtureRoot("l2-rollback-b");
      try {
        await writeGatedReleaseFixture(rootA);
        await writeGatedReleaseFixture(rootB);
        await writeFile(join(rootA, "gate"), "A-RESPONSE", "utf8");
        await writeFile(join(rootB, "gate"), "B-RESPONSE", "utf8");
        await buildRelease(rootA);
        await buildRelease(rootB);

        const a = track(await spawnProdChild(rootA));
        await waitForHealth(a.url, 200, false);

        // B fails verification; the router keeps A.
        const emittedB = await readEmittedFiles(join(rootB, "dist"));
        const manifest = JSON.parse(emittedB[".bascik/manifest.json"].toString("utf8"));
        const firstRel = Object.keys(manifest.files)[0];
        manifest.files[firstRel].hash = "deadbeef";
        emittedB[".bascik/manifest.json"] = Buffer.from(JSON.stringify(manifest), "utf8");
        const verdict = verifyReleaseCandidate(makeCandidate(rootB, emittedB));
        expect(verdict.ok).toBe(false);

        // A still answers (rollback = reuse the validated A process).
        const res = await httpGet(a.url, "/");
        expect(res.status).toBe(200);
        expect(res.body).toContain("A-RESPONSE");
      } finally {
        await cleanupFixture(rootA);
        await cleanupFixture(rootB);
      }
    }, 30000);
  });

  describe("step 3: true HTTP/2 activation, drain, rollback", () => {
    it("drains an HTTP/2 child and routes to a validated B over true HTTP/2", async () => {
      const rootA = fixtureRoot("l2-h2-a");
      const rootB = fixtureRoot("l2-h2-b");
      try {
        await writeGatedReleaseFixture(rootA);
        await writeGatedReleaseFixture(rootB);
        await writeFile(join(rootA, "gate"), "A-H2", "utf8");
        await writeFile(join(rootB, "gate"), "B-H2", "utf8");
        await buildRelease(rootA);
        await buildRelease(rootB);

        // Enable TLS so the production child negotiates true HTTP/2.
        await writeFixtureFile(
          rootA,
          "bascik.config.js",
          `module.exports = {
  directory: { components: ["src/components"] },
  pipeline: { workers: true },
  generate: { manifest: true, cspHashes: true, sitemap: false, robots: false },
  minify: { identifiers: false },
  http: { tls: { enabled: true } },
};`,
        );
        await writeFixtureFile(
          rootB,
          "bascik.config.js",
          `module.exports = {
  directory: { components: ["src/components"] },
  pipeline: { workers: true },
  generate: { manifest: true, cspHashes: true, sitemap: false, robots: false },
  minify: { identifiers: false },
  http: { tls: { enabled: true } },
};`,
        );
        await buildRelease(rootA);
        await buildRelease(rootB);

        const a = track(await spawnProdChild(rootA, { tls: true }));
        await waitForHealth(a.url, 200, true);

        // Hold the gate closed so an accepted A request blocks.
        await rm(join(rootA, "gate"), { force: true });
        const heldReq = http2Get(a.url, "/");
        await new Promise((r) => setTimeout(r, 300));

        // Initiate drain on A. The child must observe drain entry while the
        // accepted request is still held. After SIGTERM the server stops
        // accepting new connections, so readiness is observed via the child's
        // drain entry rather than a fresh health poll.
        a.child.kill("SIGTERM");
        await new Promise<void>((resolveDrain) => {
          const start = Date.now();
          const check = () => {
            if (a.output().includes("shutting down gracefully")) {
              resolveDrain();
            } else if (Date.now() - start > 10000) {
              throw new Error(`A never entered drain. Output:\n${a.output()}`);
            } else {
              setTimeout(check, 50);
            }
          };
          check();
        });

        // The accepted request is still held while A is draining.
        let heldSettled = false;
        void heldReq.then(() => {
          heldSettled = true;
        });
        await new Promise((r) => setTimeout(r, 200));
        expect(heldSettled).toBe(false);

        await writeFile(join(rootA, "gate"), "A-H2", "utf8");
        const held = await heldReq;
        expect(held.status).toBe(200);
        expect(held.body).toContain("A-H2");

        const { code } = await a.exitPromise;
        expect(code).toBe(0);

        // Route to validated B over true HTTP/2.
        const b = track(await spawnProdChild(rootB, { tls: true }));
        await waitForHealth(b.url, 200, true);
        const resB = await http2Get(b.url, "/");
        expect(resB.status).toBe(200);
        expect(resB.body).toContain("B-H2");
      } finally {
        await cleanupFixture(rootA);
        await cleanupFixture(rootB);
      }
    }, 30000);
  });

  describe("step 4: staging vs post-rename failure (partial-publication contract)", () => {
    it("a staging failure leaves the previous valid artifact set untouched", async () => {
      const root = fixtureRoot("l2-stage-fail");
      try {
        await writeGatedReleaseFixture(root);
        await buildRelease(root);
        const priorManifest = await readEmittedFiles(join(root, "dist"));

        // Force a staging failure: make the .bascik dir read-only so the temp
        // sibling write fails before any rename.
        if (process.platform !== "win32") {
          await (await import("node:fs/promises")).chmod(join(root, "dist", ".bascik"), 0o500);
        }
        let threw = false;
        try {
          await buildRelease(root);
        } catch {
          threw = true;
        } finally {
          if (process.platform !== "win32") {
            await (await import("node:fs/promises")).chmod(join(root, "dist", ".bascik"), 0o700);
          }
        }
        expect(threw).toBe(true);

        // The prior valid artifact set is untouched (partial-publication contract).
        const after = await readEmittedFiles(join(root, "dist"));
        expect(after[".bascik/manifest.json"].toString("utf8")).toBe(
          priorManifest[".bascik/manifest.json"].toString("utf8"),
        );
      } finally {
        await cleanupFixture(root);
      }
    }, 30000);
  });
});