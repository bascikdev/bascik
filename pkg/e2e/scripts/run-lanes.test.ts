/**
 * Pins the contract that lets the four main Playwright lanes (static, dev,
 * prod http1, prod http2) run at the same time on one machine, and the
 * argument handling of the lane runner (scripts/run-lanes.ts).
 *
 * Runs under the pkg `unit` Vitest project (see pkg/vite.config.js).
 *
 * Runner contract exercised here with a stub instead of Playwright:
 *   node e2e/scripts/run-lanes.ts [lane ...] [playwright args ...]
 * - Leading bare words are lane names (static, dev, http1, http2); the first
 *   argument that is not a bare word (a path, a flag) starts the pass-through
 *   arguments, which go to every lane it starts. No lane names: all four.
 * - An unknown lane name exits nonzero before starting anything and names
 *   the bad lane plus the valid ones.
 * - Each lane's output line is prefixed with `[<lane>]`.
 * - After all lanes exit it prints one unprefixed summary line per lane with
 *   passed/failed/skipped counts and wall time, and exits nonzero if any
 *   lane failed.
 * - A port a selected lane needs that is already bound fails the run before
 *   any lane starts, naming the lane and the port.
 * - BASCIK_RUN_LANES_STUB=<file> replaces `playwright` with
 *   `node <file> test --config <abs config> --reporter=line ...passthrough`.
 */
import { describe, expect, it, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  join,
  posix,
  relative,
  resolve,
  win32,
} from "node:path";
import { fileURLToPath } from "node:url";

const e2eDir = fileURLToPath(new URL("..", import.meta.url));
const pkgDir = join(e2eDir, "..");
const repoDir = join(pkgDir, "..");
const testsDir = join(e2eDir, "tests");
const runnerPath = join(e2eDir, "scripts/run-lanes.ts");

const MAIN_LANES = {
  static: "playwright.config.ts",
  dev: "playwright.dev.config.ts",
  http1: "playwright.server.config.ts",
  http2: "playwright.server-http2.config.ts",
} as const;
type Lane = keyof typeof MAIN_LANES;
const LANE_NAMES = Object.keys(MAIN_LANES) as Lane[];

// Exec lanes run serially among themselves (e2e:dev:exec chains them), so
// they count as one group: ports may repeat inside it, never outside it.
const EXEC_LANE_CONFIGS = [
  "playwright.dev-exec.config.ts",
  "playwright.dev-exec-gated.config.ts",
  "playwright.exec-policy.config.ts",
  "playwright.exec-build.config.ts",
];

interface WebServerLike {
  command?: string;
  url?: string;
}
interface PlaywrightConfigLike {
  metadata?: { childServerPorts?: number[] };
  use?: { baseURL?: string };
  projects?: { use?: { baseURL?: string } }[];
  webServer?: WebServerLike | WebServerLike[];
}

/** Ports a config binds or connects to. BASCIK_SITE_URL is only a string the build embeds, never bound. */
function portsOf(config: PlaywrightConfigLike): Set<number> {
  const ports = new Set<number>();
  const fromUrl = (url: string | undefined) => {
    if (!url) return;
    const parsed = new URL(url);
    ports.add(Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)));
  };
  fromUrl(config.use?.baseURL);
  for (const port of config.metadata?.childServerPorts ?? []) ports.add(port);
  for (const project of config.projects ?? []) fromUrl(project.use?.baseURL);
  const servers = config.webServer
    ? Array.isArray(config.webServer)
      ? config.webServer
      : [config.webServer]
    : [];
  for (const server of servers) {
    fromUrl(server.url);
    const command = (server.command ?? "").replace(/BASCIK_SITE_URL=\S+/g, "");
    for (const match of command.matchAll(/BASCIK_SERVER_PORT=(\d+)/g))
      ports.add(Number(match[1]));
    for (const match of command.matchAll(/server\.ts\s+(\d+)/g))
      ports.add(Number(match[1]));
  }
  return ports;
}

/** Imports a lane config with BASCIK_E2E_OUT cleared and returns its ports and the out dir it selects. */
async function loadLane(file: string) {
  const saved = process.env.BASCIK_E2E_OUT;
  delete process.env.BASCIK_E2E_OUT;
  // Re-evaluate the config on every call: its top-level `??=` is what sets
  // BASCIK_E2E_OUT, and a cached module from an earlier test would not run it.
  vi.resetModules();
  try {
    const mod = (await import(join(e2eDir, file))) as {
      default: PlaywrightConfigLike;
    };
    const servers = mod.default.webServer;
    return {
      ports: portsOf(mod.default),
      out: process.env.BASCIK_E2E_OUT,
      serverUrls: (Array.isArray(servers) ? servers : servers ? [servers] : [])
        .map((server) => server.url)
        .filter((url): url is string => url !== undefined),
    };
  } finally {
    if (saved === undefined) delete process.env.BASCIK_E2E_OUT;
    else process.env.BASCIK_E2E_OUT = saved;
  }
}

async function docsAndAdapterPorts(): Promise<Record<string, number>> {
  const docs = await readFile(
    join(repoDir, "docs/e2e/playwright.config.ts"),
    "utf8",
  );
  const adapter = await readFile(
    join(repoDir, "adapters/cloudflare/e2e/playwright.config.ts"),
    "utf8",
  );
  const docsPort = docs.match(/BASCIK_E2E_PORT\s*\?\?\s*"(\d+)"/)?.[1];
  const adapterPort = adapter.match(/\bPORT\s*=\s*(\d+)/)?.[1];
  expect(docsPort, "docs e2e default port not found").toBeDefined();
  expect(adapterPort, "adapter e2e port not found").toBeDefined();
  return { docs: Number(docsPort), adapter: Number(adapterPort) };
}

describe("lane isolation", () => {
  it("binds a disjoint set of ports in every lane group, docs e2e and adapter e2e included", async () => {
    const owners = new Map<number, string[]>();
    const claim = (group: string, ports: Iterable<number>) => {
      for (const port of ports) {
        const list = owners.get(port) ?? [];
        if (!list.includes(group)) list.push(group);
        owners.set(port, list);
      }
    };
    for (const lane of LANE_NAMES)
      claim(lane, (await loadLane(MAIN_LANES[lane])).ports);
    const execPorts = new Set<number>();
    for (const file of EXEC_LANE_CONFIGS)
      for (const port of (await loadLane(file)).ports) execPorts.add(port);
    claim("exec", execPorts);
    const external = await docsAndAdapterPorts();
    claim("docs-e2e", [external.docs]);
    claim("adapter-e2e", [external.adapter]);

    const collisions = [...owners]
      .filter(([, groups]) => groups.length > 1)
      .map(([port, groups]) => `${port}: ${groups.join(", ")}`);
    expect(collisions).toEqual([]);
  });

  it("lists every port a spec binds for its own server in a lane's metadata.childServerPorts", async () => {
    const declared = new Set<number>();
    for (const file of [...Object.values(MAIN_LANES), ...EXEC_LANE_CONFIGS]) {
      vi.resetModules();
      const mod = (await import(join(e2eDir, file))) as {
        default: PlaywrightConfigLike;
      };
      for (const port of mod.default.metadata?.childServerPorts ?? [])
        declared.add(port);
    }
    const undeclared: string[] = [];
    for (const file of await specFiles()) {
      const code = stripComments(await readFile(file, "utf8"));
      for (const match of code.matchAll(
        /(?:BASCIK_SERVER_PORT:\s*|\bport\s*=\s*)["'](\d+)["']/g,
      ))
        if (!declared.has(Number(match[1])))
          undeclared.push(`${basename(file)}: ${match[1]}`);
    }
    expect(undeclared).toEqual([]);
  });

  it("gives each main lane its own BASCIK_E2E_OUT, none of them the shared default", async () => {
    const outs: Record<string, string | undefined> = {};
    for (const lane of LANE_NAMES)
      outs[lane] = (await loadLane(MAIN_LANES[lane])).out;
    expect(outs).toEqual({
      static: "dist-static",
      dev: "dist-dev",
      http1: "dist-http1",
      http2: "dist-http2",
    });
  });

  it("names only loopback server URLs in every main lane, the hosts the runner's readiness probe accepts a self-signed certificate from", async () => {
    // run-lanes.ts waits for these URLs before starting the dev lane, and
    // skips certificate checks only for loopback hosts (the http2 lane's
    // certificate is self-signed). A lane pointed elsewhere would be probed
    // with verification on and never count as ready, so pin the hosts here.
    const offenders: string[] = [];
    for (const lane of LANE_NAMES) {
      const { serverUrls } = await loadLane(MAIN_LANES[lane]);
      expect(serverUrls.length, lane).toBeGreaterThan(0);
      for (const url of serverUrls)
        if (
          !["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)
        )
          offenders.push(`${lane}: ${url}`);
    }
    expect(offenders).toEqual([]);
    expect(await readFile(runnerPath, "utf8")).toMatch(
      /rejectUnauthorized:\s*!LOOPBACK_HOSTS\.has\(parsed\.hostname\)/,
    );
  });

  it("routes both shared fixtures' directory.out through BASCIK_E2E_OUT", async () => {
    for (const file of ["bascik.config.ts", "base-fixture/bascik.config.ts"]) {
      const source = await readFile(join(e2eDir, file), "utf8");
      expect(source, file).toMatch(
        /out:\s*process\.env\.BASCIK_E2E_OUT\s*\?\?\s*["']dist["']/,
      );
    }
  });

  it("writes the exec manifest into BASCIK_OUT_DIR, not a hardcoded dist", async () => {
    const source = await readFile(
      join(e2eDir, "scripts/generate-manifest.ts"),
      "utf8",
    );
    expect(source).toContain("process.env.BASCIK_OUT_DIR");
    expect(source).not.toMatch(/["'`]dist(?:\/|["'`])/);
  });

  it("ignores per-lane output directories in git", () => {
    const candidates = [
      "pkg/e2e/dist-static",
      "pkg/e2e/dist-dev/index.html",
      "pkg/e2e/base-fixture/dist-http1",
      "pkg/e2e/base-fixture/dist-http2/sub/index.html",
    ];
    const result = spawnSync(
      "git",
      ["check-ignore", "--no-index", ...candidates],
      { cwd: repoDir, encoding: "utf8" },
    );
    const ignored = result.stdout.trim().split("\n").filter(Boolean);
    expect(ignored).toEqual(candidates);
  });
});

/** Strips line and block comments so docblocks that mention dist/ do not count. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

/**
 * Every string literal (or a quoted path inside a template literal, such as a
 * script written into a temporary project) that names a build output dir.
 * The bascik CLI entry (`dist/index.js` of the package) is not output.
 */
function hardcodedDistPaths(source: string): string[] {
  const hits: string[] = [];
  const literal = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
  const isOutputPath = (text: string) =>
    /^(?:\.\.\/)*dist(?:\/|$)/.test(text) && !/dist\/index\.js$/.test(text);
  for (const match of stripComments(source).matchAll(literal)) {
    const content = match[2];
    if (isOutputPath(content)) hits.push(content);
    if (match[1] === "`")
      for (const inner of content.matchAll(/['"]((?:\.\.\/)*dist[^'"]*)['"]/g))
        if (isOutputPath(inner[1])) hits.push(inner[1]);
  }
  return hits;
}

async function specFiles(): Promise<string[]> {
  const entries = await readdir(testsDir, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => !file.includes(`${join("tests", "helpers")}`));
}

const WRITE_API =
  /^(?:writeFile|appendFile|rm|rmdir|unlink|rename|cp|copyFile|symlink|link|utimes|lutimes|mkdir|mkdtemp|truncate|open|createWriteStream|chmod|chown|write|writev)(?:Sync)?$/;
const FS_MODULE = /^(?:node:)?fs(?:\/promises)?$/;
const CHILD_PROCESS = /^(?:node:)?child_process$/;

/**
 * Why a spec (or a local module it imports, followed transitively) can write
 * files: a write API imported from fs, an fs namespace or default import, or
 * any child_process import (a spawned CLI writes). Empty when it only reads.
 */
async function writeCapabilities(
  file: string,
  seen = new Set<string>(),
): Promise<string[]> {
  if (seen.has(file)) return [];
  seen.add(file);
  const code = stripComments(await readFile(file, "utf8"));
  const reasons: string[] = [];
  const imports = /import\s+(?:type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
  for (const [, clause, from] of code.matchAll(imports)) {
    if (CHILD_PROCESS.test(from)) reasons.push(`imports ${from}`);
    else if (FS_MODULE.test(from)) {
      const named = clause.match(/\{([\s\S]*)\}/)?.[1] ?? "";
      const outside = clause
        .replace(/\{[\s\S]*\}/, "")
        .replace(/,/g, "")
        .trim();
      if (outside) reasons.push(`imports all of ${from}`);
      for (const part of named.split(",")) {
        const name = part
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)[0];
        if (WRITE_API.test(name)) reasons.push(name);
      }
    } else if (from.startsWith(".")) {
      const target = resolve(dirname(file), from);
      const candidates = [target, `${target}.ts`];
      for (const candidate of candidates)
        if (existsSync(candidate) && candidate.endsWith(".ts")) {
          for (const reason of await writeCapabilities(candidate, seen))
            reasons.push(`${from}: ${reason}`);
          break;
        }
    }
  }
  return reasons;
}

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

describe("spec hygiene", () => {
  it("has the out-dir helper", () => {
    expect(existsSync(join(testsDir, "helpers/out-dir.ts"))).toBe(true);
  });

  it("resolves build output only through the out-dir helper", async () => {
    const offenders: string[] = [];
    for (const file of await specFiles()) {
      const hits = hardcodedDistPaths(await readFile(file, "utf8"));
      for (const hit of hits)
        offenders.push(`${relative(e2eDir, file)}: ${hit}`);
    }
    expect(offenders).toEqual([]);
  });

  it("does not hardcode a server origin in a spec (site-URL assertions excepted)", async () => {
    // These assert the BASCIK_SITE_URL string the build embedded, not a server they talk to.
    const siteUrlAssertions = new Set([
      "build-scripts.test.ts",
      "sitemap.test.ts",
      "base-serving.test.ts",
    ]);
    const offenders: string[] = [];
    for (const file of await specFiles()) {
      if (siteUrlAssertions.has(basename(file))) continue;
      const code = stripComments(await readFile(file, "utf8"));
      for (const match of code.matchAll(/localhost:\d+/g))
        offenders.push(`${relative(e2eDir, file)}: ${match[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps every spec that writes files out of the parallel dev-readonly project", async () => {
    // Writes only into temporary projects the spec itself creates, never into
    // anything the dev server watches.
    const tempProjectWriters = new Set([
      "base-path.test.ts",
      "exec-build-lifecycle.test.ts",
    ]);
    vi.resetModules();
    const dev = (await import(join(e2eDir, MAIN_LANES.dev))) as {
      default: { projects?: { name?: string; testIgnore?: string[] }[] };
    };
    const readonly = dev.default.projects?.find(
      (project) => project.name === "dev-readonly",
    );
    expect(readonly, "dev lane has no dev-readonly project").toBeDefined();
    const ignored = new Set(readonly!.testIgnore ?? []);
    const missing: string[] = [];
    for (const file of await specFiles()) {
      const name = basename(file);
      if (tempProjectWriters.has(name) || ignored.has(`**/${name}`)) continue;
      const reasons = await writeCapabilities(file);
      if (reasons.length > 0) missing.push(`${name} (${reasons.join(", ")})`);
    }
    expect(missing).toEqual([]);
  });

  it("the write detector sees sync, mkdir, child_process, namespace and helper-module writes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bascik-write-detector-"));
    const cases: Record<string, string> = {
      "sync.ts": `import { readFileSync, writeFileSync } from "node:fs";`,
      "mkdir.ts": `import { mkdir } from "fs/promises";`,
      "exec.ts": `import { execSync } from "node:child_process";`,
      "ns.ts": `import * as fs from "node:fs";`,
      "default.ts": `import fs from "node:fs/promises";`,
      "via-helper.ts": `import { touch } from "./helper-writes.ts";`,
      "helper-writes.ts": `import { rmSync as remove } from "node:fs";`,
      "reads.ts": `import { readFile, stat } from "node:fs/promises";\nimport { existsSync } from "node:fs";\nconst m = /x/.exec("x");`,
    };
    for (const [file, source] of Object.entries(cases))
      await writeFile(join(dir, file), source);
    const flagged: string[] = [];
    for (const file of Object.keys(cases))
      if ((await writeCapabilities(join(dir, file))).length > 0)
        flagged.push(file);
    expect(flagged.sort()).toEqual(
      [
        "default.ts",
        "exec.ts",
        "helper-writes.ts",
        "mkdir.ts",
        "ns.ts",
        "sync.ts",
        "via-helper.ts",
      ].sort(),
    );
  });

  it("never edits, from a dev-mutating spec, a module the production lanes import at request time", async () => {
    // Production servers import API handlers and server-script dependencies
    // from the shared pkg/e2e/src tree on first request, so a dev-mutating
    // edit of one could be picked up by a prod lane running alongside.
    const { devSourceEditingSpecs } = (await import(
      join(e2eDir, MAIN_LANES.dev)
    )) as { devSourceEditingSpecs: string[] };
    const mutating = new Set(
      devSourceEditingSpecs.map((glob) => glob.replace(/^\*\*\//, "")),
    );
    const serverSideSources = (await sourceFiles(join(e2eDir, "src"))).filter(
      (file) => file.endsWith(".html"),
    );
    const serverScriptText: string[] = [];
    for (const file of serverSideSources) {
      const html = await readFile(file, "utf8");
      if (/data-bascik-server/.test(html)) serverScriptText.push(html);
    }
    const otherSpecsText: string[] = [];
    for (const file of await specFiles())
      if (!mutating.has(basename(file)))
        otherSpecsText.push(await readFile(file, "utf8"));
    const offenders: string[] = [];
    for (const name of mutating) {
      const code = stripComments(await readFile(join(testsDir, name), "utf8"));
      for (const match of code.matchAll(
        /["'`]src\/(api|lib)\/([^"'`]+)\.ts["'`]/g,
      )) {
        const [, kind, rest] = match;
        if (kind === "api") {
          const route = `/api/${rest}`;
          if (otherSpecsText.some((text) => text.includes(`"${route}"`)))
            offenders.push(
              `${name}: src/api/${rest}.ts serves ${route}, which other specs request`,
            );
        } else if (
          serverScriptText.some((html) => html.includes(`lib/${rest}.ts`))
        ) {
          offenders.push(
            `${name}: src/lib/${rest}.ts is imported by a server script`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the hardcoded-dist detector flags output paths and spares the CLI entry", () => {
    expect(
      hardcodedDistPaths(`join(dir, "dist/a.html"); join(x, "..", "dist");`),
    ).toEqual(["dist/a.html", "dist"]);
    expect(hardcodedDistPaths("const s = `await mkdir('dist', {});`;")).toEqual(
      ["dist"],
    );
    expect(
      hardcodedDistPaths(
        `join(pkgDir, "dist/index.js"); new URL("../../dist/index.js", u); test("served from dist/", f); // "dist/x"`,
      ),
    ).toEqual([]);
  });
});

/**
 * The lane a stub run belongs to, from the `--config` path the runner passes.
 * The runner builds that path with node:path, so on Windows it is
 * backslash-separated (D:\\a\\...\\playwright.dev.config.ts): splitting on "/"
 * alone named no lane there, the stub ignored STUB_FAIL_LANES, and "exits
 * nonzero when one fails" saw exit 0. Serialized into STUB below, so it must
 * stay self-contained (no imports, no outer references).
 */
function stubLaneOf(configPath: string): string | undefined {
  const file = configPath.split(/[\\/]/).pop() ?? "";
  return (
    {
      "playwright.config.ts": "static",
      "playwright.dev.config.ts": "dev",
      "playwright.server.config.ts": "http1",
      "playwright.server-http2.config.ts": "http2",
    } as Record<string, string>
  )[file];
}

const STUB = `
const stubLaneOf = ${stubLaneOf.toString()};
const args = process.argv.slice(2);
const config = args[args.indexOf("--config") + 1] ?? "";
const lane = stubLaneOf(config);
// A config the stub cannot place would make every lane-specific STUB_* knob
// a silent no-op, so the run fails loudly instead of passing by accident.
if (lane === undefined) {
  console.error("stub: no lane for --config " + JSON.stringify(config));
  process.exit(3);
}
const fail = (process.env.STUB_FAIL_LANES ?? "").split(",").includes(lane);
const delay = Number(process.env["STUB_DELAY_" + lane] ?? 0);
console.log("ARGS " + JSON.stringify(args));
console.log("E2E_OUT " + (process.env.BASCIK_E2E_OUT ?? "unset"));
setTimeout(() => {
  console.log("Running 3 tests using 1 worker");
  if (fail) { console.log("  1 failed"); console.log("  1 passed (0.2s)"); console.log("  1 skipped"); process.exit(1); }
  console.log("  2 passed (0.2s)"); console.log("  1 skipped");
}, delay);
`;

interface RunResult {
  code: number | null;
  output: string;
}

async function runRunner(
  args: string[],
  env: Record<string, string> = {},
): Promise<RunResult> {
  const dir = await mkdtemp(join(tmpdir(), "bascik-run-lanes-"));
  const stub = join(dir, "stub.mjs");
  await writeFile(stub, STUB);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runnerPath, ...args], {
      cwd: pkgDir,
      env: { ...process.env, ...env, BASCIK_RUN_LANES_STUB: stub },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => (output += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}

/** Lanes the stub was started for, read from its prefixed `ARGS` lines. */
function startedLanes(output: string): Map<string, string[]> {
  const started = new Map<string, string[]>();
  for (const match of output.matchAll(/^\[(\w+)\s*\]\s+ARGS (.*)$/gm))
    started.set(match[1], JSON.parse(match[2]) as string[]);
  return started;
}

function summaryLine(output: string, lane: string): string {
  const lines = output
    .split("\n")
    .filter(
      (line) =>
        !line.startsWith("[") &&
        new RegExp(`\\b${lane}\\b`).test(line) &&
        /passed/.test(line),
    );
  expect(lines, `no summary line for ${lane} in:\n${output}`).toHaveLength(1);
  return lines[0];
}

describe("run-lanes runner", () => {
  it("exists", () => {
    expect(existsSync(runnerPath)).toBe(true);
  });

  it("the stub names the lane from a POSIX or a Windows --config path, and nothing for an unknown config", () => {
    for (const [lane, file] of Object.entries(MAIN_LANES)) {
      expect(stubLaneOf(posix.join("/repo/pkg/e2e", file))).toBe(lane);
      expect(stubLaneOf(win32.join("D:\\a\\bascik\\pkg\\e2e", file))).toBe(
        lane,
      );
    }
    expect(stubLaneOf("D:\\a\\pkg\\e2e\\playwright.dev-exec.config.ts")).toBe(
      undefined,
    );
    expect(stubLaneOf("")).toBe(undefined);
  });

  it("runs all four lanes when no lane is named, prefixing each line", async () => {
    const { code, output } = await runRunner([]);
    expect(code, output).toBe(0);
    const started = startedLanes(output);
    expect([...started.keys()].sort()).toEqual([...LANE_NAMES].sort());
    for (const lane of LANE_NAMES) {
      const args = started.get(lane)!;
      expect(args[0]).toBe("test");
      expect(basename(args[args.indexOf("--config") + 1])).toBe(
        MAIN_LANES[lane],
      );
      expect(output).toMatch(
        new RegExp(`^\\[${lane}\\s*\\]\\s+Running 3 tests`, "m"),
      );
    }
  });

  it("runs only the named subset and passes extra Playwright args to each", async () => {
    const { code, output } = await runRunner([
      "dev",
      "http1",
      "tests/props.test.ts",
      "--grep",
      "usage 1",
    ]);
    expect(code, output).toBe(0);
    const started = startedLanes(output);
    expect([...started.keys()].sort()).toEqual(["dev", "http1"]);
    for (const args of started.values())
      expect(args.slice(-3)).toEqual([
        "tests/props.test.ts",
        "--grep",
        "usage 1",
      ]);
  });

  it("passes flags through to all lanes when no lane is named", async () => {
    const { code, output } = await runRunner(["--grep", "scoping"]);
    expect(code, output).toBe(0);
    const started = startedLanes(output);
    expect(started.size).toBe(4);
    for (const args of started.values())
      expect(args.slice(-2)).toEqual(["--grep", "scoping"]);
  });

  it("rejects an unknown lane name before starting any lane", async () => {
    const { code, output } = await runRunner(["dev", "htp1"]);
    expect(code).not.toBe(0);
    expect(output).toContain("htp1");
    for (const lane of LANE_NAMES) expect(output).toContain(lane);
    expect(startedLanes(output).size).toBe(0);
  });

  it("prints a per-lane summary with counts and wall time", async () => {
    const { code, output } = await runRunner(["static", "http2"]);
    expect(code, output).toBe(0);
    for (const lane of ["static", "http2"]) {
      const line = summaryLine(output, lane);
      expect(line).toMatch(/2 passed|passed:?\s*2\b/);
      expect(line).toMatch(/0 failed|failed:?\s*0\b/);
      expect(line).toMatch(/1 skipped|skipped:?\s*1\b/);
      expect(line).toMatch(/\d+(?:\.\d+)?\s?(?:ms|s|m)\b/);
    }
  });

  it("waits for every lane and exits nonzero when one fails", async () => {
    const { code, output } = await runRunner(["dev", "http1"], {
      STUB_FAIL_LANES: "dev",
      STUB_DELAY_http1: "400",
    });
    expect(code).not.toBe(0);
    expect(summaryLine(output, "dev")).toMatch(/1 failed|failed:?\s*1\b/);
    expect(summaryLine(output, "http1")).toMatch(/2 passed|passed:?\s*2\b/);
  });

  it("misuse: an exported BASCIK_E2E_OUT reaches no lane, and the notice names the variable without echoing its value", async () => {
    // Every lane config picks its own output directory only when
    // BASCIK_E2E_OUT is unset; a value left in the shell would put all four
    // lanes in one directory. The notice leaves the value out because it is
    // read from the environment, which is not this runner's to print
    // (CodeQL js/clear-text-logging); the user can echo it themselves.
    const { code, output } = await runRunner(["static", "http1"], {
      BASCIK_E2E_OUT: "dist-left-in-the-shell",
    });
    expect(code, output).toBe(0);
    expect(output).toMatch(/ignoring BASCIK_E2E_OUT\b.*own output directory/);
    expect(output).not.toContain("dist-left-in-the-shell");
    for (const lane of ["static", "http1"])
      expect(output).toMatch(
        new RegExp(`^\\[${lane}\\s*\\]\\s+E2E_OUT unset$`, "m"),
      );
  });

  it("refuses to start when a port a selected lane needs is already bound", async () => {
    // An ephemeral port stands in for the lane's real ports, which may be in
    // use by lanes running elsewhere on the machine.
    const server = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, () => {
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : 0);
      });
    });
    expect(port).toBeGreaterThan(0);
    try {
      const { code, output } = await runRunner(["http2"], {
        BASCIK_RUN_LANES_STUB_PORTS: JSON.stringify({ http2: [port] }),
      });
      expect(code).not.toBe(0);
      expect(output).toContain(String(port));
      expect(output).toContain("http2");
      expect(startedLanes(output).size).toBe(0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("root scripts", () => {
  it("pkg:e2e:all runs the lanes in parallel and pkg:e2e:all:serial keeps the chain", async () => {
    const pkg = JSON.parse(
      await readFile(join(repoDir, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const all = pkg.scripts["pkg:e2e:all"] ?? "";
    expect(all).toContain("run-lanes");
    expect(pkg.scripts["pkg:e2e:all:serial"]).toBe(
      "yarn pkg:e2e && yarn pkg:e2e:dev && yarn pkg:e2e:prod",
    );
  });
});
