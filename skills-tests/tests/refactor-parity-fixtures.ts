/**
 * Serves the bascik-refactor parity fixtures (tests/fixtures/refactor-parity/) for the browser tests of the parity
 * checks. Each check has a production page, a target with exactly one defect of its type and a clean target that looks
 * the same as production while its markup differs the way a Bascik build differs (scoped or hashed class names, fewer
 * wrapper elements). The fixtures are copied to a temp directory and served from 127.0.0.1 on a free port, from a
 * worker thread, so every check reads them over HTTP like a real site, also from a child process the test waits for
 * with spawnSync. close() stops the server and the thread and removes the copy.
 */
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

/** The skills-tests workspace root: the checks load Playwright and sharp from here, the way they load them from a reader's project. */
export const packageDir = fileURLToPath(new URL("..", import.meta.url));
export const fixturesDir = fileURLToPath(
  new URL("./fixtures/refactor-parity/", import.meta.url),
);

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".jpg": "image/jpeg",
  ".webm": "video/webm",
};

export interface FixtureServer {
  /** The temp copy of the fixtures folder. */
  root: string;
  /** http://127.0.0.1:<port> */
  origin: string;
  /** The origin of one side of one check's fixture, such as `${origin}/spacing-diff/defect`. */
  site(check: string, side: "prod" | "defect" | "clean"): string;
  /** The Bascik source tree of a target (`<check>/src-defect` or `<check>/src-clean`), holding src/pages and src/components. */
  src(check: string, side: "defect" | "clean"): string;
  /** The legacy source tree of a check (`<check>/legacy`). */
  legacy(check: string): string;
  /** How many requests the server answered whose path starts with `prefix` (such as `/site/prod/`), since the start. */
  requests(prefix: string): Promise<number>;
  close(): Promise<void>;
}

/**
 * The server, as plain JavaScript run in a worker thread. A test that runs a check CLI with spawnSync blocks its own
 * event loop until the child exits; a server on that loop could never answer the child, so it gets its own thread.
 * A request path maps to the path itself, then `<path>.html`, then `<path>/index.html`, inside the root only.
 */
const SERVER_SOURCE = `
const { createServer } = require("node:http");
const { readFileSync, statSync } = require("node:fs");
const { extname, join, normalize, resolve, sep } = require("node:path");
const { parentPort, workerData } = require("node:worker_threads");
const { root, types } = workerData;
function resolveFile(urlPath) {
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^([/\\\\])+/, "");
  const base = resolve(root, rel);
  if (base !== root && !base.startsWith(root + sep)) return undefined;
  for (const candidate of [base, base + ".html", join(base, "index.html")]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return undefined;
}
const counts = new Map();
const server = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  counts.set(path, (counts.get(path) ?? 0) + 1);
  const file = resolveFile(path);
  if (!file) {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    return;
  }
  res
    .writeHead(200, {
      "content-type": types[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    })
    .end(readFileSync(file));
});
server.listen(0, "127.0.0.1", () => parentPort.postMessage({ port: server.address().port }));
parentPort.on("message", (message) => {
  if (message?.type === "requests") {
    let n = 0;
    for (const [path, count] of counts) if (path.startsWith(message.prefix)) n += count;
    parentPort.postMessage({ type: "requests", n });
  }
  if (message === "close") {
    server.closeAllConnections();
    server.close(() => parentPort.postMessage("closed"));
  }
});
`;

export async function serveFixtures(): Promise<FixtureServer> {
  const root = mkdtempSync(join(tmpdir(), "bascik-parity-"));
  cpSync(fixturesDir, root, { recursive: true });
  const worker = new Worker(SERVER_SOURCE, {
    eval: true,
    workerData: { root, types: TYPES },
  });
  const port = await new Promise<number>((done, failed) => {
    worker.once("message", (message: { port: number }) => done(message.port));
    worker.once("error", failed);
  });
  const origin = `http://127.0.0.1:${port}`;
  return {
    root,
    origin,
    site: (check, side) => `${origin}/${check}/${side}`,
    src: (check, side) => join(root, check, `src-${side}`),
    legacy: (check) => join(root, check, "legacy"),
    requests: (prefix) =>
      new Promise<number>((done) => {
        const listen = (message: { type?: string; n?: number }) => {
          if (message?.type !== "requests") return;
          worker.off("message", listen);
          done(message.n ?? 0);
        };
        worker.on("message", listen);
        worker.postMessage({ type: "requests", prefix });
      }),
    close: async () => {
      await new Promise<void>((done) => {
        worker.once("message", () => done());
        worker.postMessage("close");
      });
      await worker.terminate();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
