/**
 * Runs the four main Playwright lanes (static, dev, prod http1, prod http2)
 * at the same time and reports one summary line per lane.
 *
 *   node e2e/scripts/run-lanes.ts [lane ...] [playwright args ...]
 *   yarn pkg:e2e:all                         # all four lanes
 *   yarn pkg:e2e:all dev http1               # a subset
 *   yarn pkg:e2e:all tests/props.test.ts     # one spec in every lane
 *   yarn pkg:e2e:all http2 --grep scoping    # a subset, filtered
 *
 * Leading bare words are lane names. The first argument that is not one (a
 * path, a flag, or anything after `--`) starts the arguments passed to every
 * lane's `playwright test`. The lanes can share a machine because each binds
 * its own ports and builds into its own BASCIK_E2E_OUT directory (set by its
 * config). The exec lanes (e2e:dev:exec, e2e:exec:policy) are not run here.
 *
 * The dev lane edits files under pkg/e2e/src and base-fixture/src while it
 * runs, and the other lanes build from those same sources, so the dev lane
 * starts only once every other selected lane's servers answer (its build is
 * done) or that lane has exited.
 *
 * Before starting anything it fails, naming the lane and port, if a port a
 * selected lane needs is already in use (usually a lane left running).
 *
 * Ports checked: every lane's baseURL and webServer ports, plus the dev
 * config's metadata.childServerPorts (servers its specs start themselves).
 *
 * BASCIK_RUN_LANES_STUB=<file> runs `node <file>` in place of the Playwright
 * CLI with the same arguments; the runner's unit tests use it. Under the stub
 * the bound-port check probes only BASCIK_RUN_LANES_STUB_PORTS
 * ({"<lane>": [port, ...]}), so the tests pass while real lanes are running.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createRequire } from "node:module";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

const LANES = {
  static: "playwright.config.ts",
  dev: "playwright.dev.config.ts",
  http1: "playwright.server.config.ts",
  http2: "playwright.server-http2.config.ts",
} as const;
type Lane = keyof typeof LANES;
const LANE_NAMES = Object.keys(LANES) as Lane[];
/** Lanes that edit fixture sources the others build from; started after those builds. */
const SOURCE_EDITING_LANES: ReadonlySet<Lane> = new Set(["dev"]);
const BUILD_WAIT_LIMIT_MS = 10 * 60_000;

const e2eDir = fileURLToPath(new URL("..", import.meta.url));
const pkgDir = join(e2eDir, "..");

interface WebServerLike {
  command?: string;
  url?: string;
}
interface LaneConfig {
  metadata?: { childServerPorts?: number[] };
  use?: { baseURL?: string };
  projects?: { use?: { baseURL?: string } }[];
  webServer?: WebServerLike | WebServerLike[];
}
interface LanePlan {
  lane: Lane;
  configPath: string;
  ports: number[];
  serverUrls: string[];
}
interface LaneResult {
  lane: Lane;
  code: number | null;
  signal: NodeJS.Signals | null;
  ms: number;
  counts: Record<string, number>;
}

const fail = (message: string): never => {
  console.error(`[run-lanes] ${message}`);
  process.exit(2);
};

const portOf = (url: string): number => {
  const parsed = new URL(url);
  return Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
};

/** Splits argv into lane names and pass-through Playwright arguments. */
function parseArgs(argv: string[]): { lanes: Lane[]; passthrough: string[] } {
  const lanes: Lane[] = [];
  let index = 0;
  for (; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--") {
      index++;
      break;
    }
    if (!/^[A-Za-z][\w-]*$/.test(arg)) break; // a path or a flag
    if (!(LANE_NAMES as string[]).includes(arg)) {
      fail(
        `unknown lane "${arg}". Lanes: ${LANE_NAMES.join(", ")}. ` +
          `To pass a bare word to Playwright, put it after "--".`,
      );
    }
    if (!lanes.includes(arg as Lane)) lanes.push(arg as Lane);
  }
  return {
    lanes: lanes.length > 0 ? lanes : [...LANE_NAMES],
    passthrough: argv.slice(index),
  };
}

/** Imports a lane config without letting the env it sets leak into the runner (and so every lane). */
async function loadPlan(lane: Lane): Promise<LanePlan> {
  const configPath = join(e2eDir, LANES[lane]);
  const savedEnv = { ...process.env };
  let config: LaneConfig;
  try {
    config = (
      (await import(pathToFileURL(configPath).href)) as {
        default: LaneConfig;
      }
    ).default;
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
  const ports = new Set<number>();
  const serverUrls: string[] = [];
  if (config.use?.baseURL) ports.add(portOf(config.use.baseURL));
  for (const project of config.projects ?? [])
    if (project.use?.baseURL) ports.add(portOf(project.use.baseURL));
  const servers = config.webServer
    ? Array.isArray(config.webServer)
      ? config.webServer
      : [config.webServer]
    : [];
  for (const server of servers) {
    if (!server.url) continue;
    serverUrls.push(server.url);
    ports.add(portOf(server.url));
  }
  // Servers a spec starts itself (dev-server-reload's cold-start servers).
  for (const port of config.metadata?.childServerPorts ?? []) ports.add(port);
  return { lane, configPath, ports: [...ports], serverUrls };
}

const canConnect = (port: number, host: string): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect({ port, host });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });

const canListen = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, () => server.close(() => resolve(true)));
  });

async function portInUse(port: number): Promise<boolean> {
  if (await canConnect(port, "127.0.0.1")) return true;
  if (await canConnect(port, "::1")) return true;
  return !(await canListen(port));
}

/** Fails before any lane starts if two lanes share a port or one is already bound. */
async function preflight(
  plans: LanePlan[],
  stub: string | undefined,
): Promise<void> {
  const owners = new Map<number, Lane[]>();
  for (const plan of plans)
    for (const port of plan.ports)
      owners.set(port, [...(owners.get(port) ?? []), plan.lane]);
  const shared = [...owners].filter(([, lanes]) => lanes.length > 1);
  if (shared.length > 0) {
    fail(
      `lanes share a port, so they cannot run together: ${shared
        .map(([port, lanes]) => `${port} (${lanes.join(", ")})`)
        .join("; ")}. Give each lane config its own ports.`,
    );
  }
  // Under the stub the real lane ports are not this run's to check (a lane
  // may legitimately be up elsewhere on the machine); the unit tests name the
  // ports to probe instead, as {"<lane>": [port, ...]}.
  const probe: [number, Lane][] = stub
    ? Object.entries(
        JSON.parse(process.env.BASCIK_RUN_LANES_STUB_PORTS ?? "{}") as Record<
          string,
          number[]
        >,
      ).flatMap(([lane, ports]) =>
        ports.map((port): [number, Lane] => [port, lane as Lane]),
      )
    : [...owners].map(([port, [lane]]): [number, Lane] => [port, lane]);
  const busy: string[] = [];
  await Promise.all(
    probe.map(async ([port, lane]) => {
      if (await portInUse(port)) busy.push(`${port} (needed by ${lane})`);
    }),
  );
  if (busy.length > 0) {
    fail(
      `port already in use: ${busy.sort().join(", ")}. A lane or server from an ` +
        `earlier run is probably still up; stop it (lsof -i :<port>) and run again. No lane was started.`,
    );
  }
}

/** Hosts whose self-signed certificate the readiness probe accepts. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
]);

/**
 * True once the URL answers with any HTTP status. The http2 lane serves a
 * self-signed certificate on loopback, so certificate checks are skipped for
 * loopback hosts only; the probe reads the status line, never the body. Any
 * other host keeps verification on.
 */
const answers = (url: string): Promise<boolean> =>
  new Promise((resolve) => {
    const parsed = new URL(url);
    const send = parsed.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(
      parsed,
      {
        method: "GET",
        rejectUnauthorized: !LOOPBACK_HOSTS.has(parsed.hostname),
        timeout: 2000,
      },
      (res) => {
        res.resume();
        resolve(true);
      },
    );
    req.once("timeout", () => req.destroy());
    req.once("error", () => resolve(false));
    req.end();
  });

const formatMs = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
};

const COUNT_LINE =
  /^\s*(\d+) (passed|failed|flaky|skipped|did not run|interrupted)\b/;

async function main(): Promise<void> {
  const { lanes, passthrough } = parseArgs(process.argv.slice(2));
  const plans = await Promise.all(lanes.map(loadPlan));
  const stub = process.env.BASCIK_RUN_LANES_STUB;
  await preflight(plans, stub);

  const childEnv = { ...process.env };
  if (childEnv.BASCIK_E2E_OUT !== undefined) {
    // Names the variable, not its value: the value comes from the user's
    // environment, which this runner does not print (they can echo it).
    console.log(
      "[run-lanes] ignoring BASCIK_E2E_OUT: each lane uses its own output directory when run together",
    );
    delete childEnv.BASCIK_E2E_OUT;
  }
  const cli =
    stub ?? createRequire(import.meta.url).resolve("@playwright/test/cli");
  const width = Math.max(...lanes.map((lane) => lane.length));
  const children = new Map<Lane, ChildProcess>();
  const exited = new Set<Lane>();

  const pipeLines = (
    lane: Lane,
    stream: NodeJS.ReadableStream,
    sink: NodeJS.WriteStream,
    onLine: (line: string) => void,
  ) => {
    const prefix = `[${lane.padEnd(width)}] `;
    let pending = "";
    stream.setEncoding("utf8");
    const emit = (line: string) => {
      const clean = line.replace(/\r$/, "");
      onLine(stripVTControlCharacters(clean));
      sink.write(prefix + clean + "\n");
    };
    stream.on("data", (chunk: string) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) emit(line);
    });
    stream.on("end", () => {
      if (pending) emit(pending);
    });
  };

  const runLane = (plan: LanePlan): Promise<LaneResult> =>
    new Promise((resolve) => {
      const started = Date.now();
      const counts: Record<string, number> = {};
      const child = spawn(
        process.execPath,
        [
          cli,
          "test",
          "--config",
          plan.configPath,
          "--reporter=line",
          ...passthrough,
        ],
        { cwd: pkgDir, env: childEnv, stdio: ["ignore", "pipe", "pipe"] },
      );
      children.set(plan.lane, child);
      const count = (line: string) => {
        const match = COUNT_LINE.exec(line);
        if (match) counts[match[2]] = Number(match[1]);
      };
      pipeLines(plan.lane, child.stdout!, process.stdout, count);
      pipeLines(plan.lane, child.stderr!, process.stderr, count);
      child.once("error", (error) => {
        process.stderr.write(
          `[${plan.lane}] failed to start: ${error.message}\n`,
        );
      });
      child.once("close", (code, signal) => {
        exited.add(plan.lane);
        resolve({
          lane: plan.lane,
          code,
          signal,
          ms: Date.now() - started,
          counts,
        });
      });
    });

  /** Resolves once every listed lane's servers answer or the lane has exited. */
  const buildsSettled = async (waitFor: LanePlan[]): Promise<void> => {
    const deadline = Date.now() + BUILD_WAIT_LIMIT_MS;
    const ready = new Set<Lane>();
    while (Date.now() < deadline) {
      for (const plan of waitFor) {
        if (ready.has(plan.lane)) continue;
        if (exited.has(plan.lane)) {
          ready.add(plan.lane);
          continue;
        }
        const up = await Promise.all(plan.serverUrls.map(answers));
        if (up.every(Boolean)) ready.add(plan.lane);
      }
      if (ready.size === waitFor.length) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    console.log(
      `[run-lanes] builds still running after ${formatMs(BUILD_WAIT_LIMIT_MS)}; starting the remaining lanes anyway`,
    );
  };

  const stopAll = (signal: NodeJS.Signals) => {
    for (const child of children.values())
      if (child.exitCode === null) child.kill(signal);
  };
  process.once("SIGINT", () => stopAll("SIGINT"));
  process.once("SIGTERM", () => stopAll("SIGTERM"));

  const runStarted = Date.now();
  const firstWave = plans.filter(
    (plan) => !SOURCE_EDITING_LANES.has(plan.lane),
  );
  const secondWave = plans.filter((plan) =>
    SOURCE_EDITING_LANES.has(plan.lane),
  );
  const startSecondWave = async (): Promise<LaneResult[]> => {
    if (secondWave.length === 0) return [];
    if (firstWave.length > 0) {
      console.log(
        `[run-lanes] ${secondWave.map((plan) => plan.lane).join(", ")} starts after the ` +
          `${firstWave.map((plan) => plan.lane).join(", ")} builds finish (it edits the sources they build from)`,
      );
      await buildsSettled(firstWave);
    }
    return Promise.all(secondWave.map(runLane));
  };
  const [firstResults, secondResults] = await Promise.all([
    Promise.all(firstWave.map(runLane)),
    startSecondWave(),
  ]);
  const results = [...firstResults, ...secondResults];
  results.sort((a, b) => lanes.indexOf(a.lane) - lanes.indexOf(b.lane));

  console.log("");
  for (const result of results) {
    const ok = result.code === 0;
    const c = result.counts;
    const extra = [
      c.flaky ? `${c.flaky} flaky` : "",
      c["did not run"] ? `${c["did not run"]} did not run` : "",
      c.interrupted ? `${c.interrupted} interrupted` : "",
      ok ? "" : `exit ${result.code ?? result.signal}`,
    ].filter(Boolean);
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${result.lane.padEnd(width)}  ` +
        `${c.passed ?? 0} passed, ${c.failed ?? 0} failed, ${c.skipped ?? 0} skipped` +
        `${extra.length ? `, ${extra.join(", ")}` : ""}  ${formatMs(result.ms)}`,
    );
  }
  const failed = results.filter((result) => result.code !== 0);
  console.log(
    `${failed.length === 0 ? "all lanes green" : `${failed.length} of ${results.length} lanes red`} in ${formatMs(Date.now() - runStarted)}`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
