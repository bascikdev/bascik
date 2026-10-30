/**
 * `http.timeouts.request`, `.headers` and `.keepAlive` reach the real servers.
 *
 * They were typed, validated and documented but never passed to Node, so a
 * slow-headers client held a socket for Node's 60 s default and an HTTP/2
 * session never closed. Small configured values make each one observable:
 *
 * - headers: a client that stops mid-headers gets 408 and a closed socket,
 *   on plain HTTP/1.1 and on the HTTP/1.1 fallback of the TLS server.
 * - request: a body that trickles past it is cut off the same way.
 * - keepAlive: an idle keep-alive socket closes after it; a second request
 *   sent before it is served on the same socket. An HTTP/2 session with no
 *   open stream closes after it.
 * - Safety: request covers receiving the request, not the response, so a
 *   response that streams for longer than request still arrives whole, and
 *   an HTTP/2 session with a silent open stream (SSE) is never closed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type httpTypes from "node:http";
import http2 from "node:http2";
import net from "node:net";
import tls from "node:tls";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

const REQUEST_MS = 1000;
const HEADERS_MS = 400;
const KEEP_ALIVE_MS = 400;
/** Longer than REQUEST_MS and KEEP_ALIVE_MS, so neither may cut it short. */
const SLOW_RESPONSE_MS = 1500;
/**
 * Upper bound for a cut-off: the timeout, the deadline check interval, and
 * Node's keepAliveTimeoutBuffer (1 s on Node 24), with room for a loaded
 * machine. Node's own defaults (60 s headers, never for HTTP/2) are far over.
 */
const CUTOFF_BUDGET_MS = 5_000;

const { configState, createdServers } = vi.hoisted(() => ({
  configState: {
    base: "/",
    http: {
      hostname: "127.0.0.1",
      port: 0,
      httpCache: false,
      compression: false,
      rateLimit: false,
      tls: { enabled: false, keyFile: "", certFile: "" },
      trustProxy: false,
      maxBodySize: 1048576,
      apiTimeout: 15000,
      timeouts: { request: 1000, headers: 400, keepAlive: 400 },
    },
    scripts: { timeout: 30000, onServerScriptError: "error" },
    logging: { level: "silent", requests: false },
    isProdServer: true,
    directory: {
      pages: "src/pages",
      components: ["src/components"],
      api: "src/api",
      out: "",
    },
    minify: { identifiers: false },
  },
  createdServers: [] as net.Server[],
}));

vi.mock("./config.js", () => ({
  shouldLog: () => false,
  BascikConfig: configState,
}));

// Real servers, recorded so afterAll can close them and their sockets.
vi.mock("node:http", async (importOriginal) => {
  const actual: any = await importOriginal();
  const createServer = (...args: unknown[]) => {
    const server = (actual.default.createServer as any)(...args);
    createdServers.push(server);
    return server;
  };
  return {
    ...actual,
    createServer,
    default: { ...actual.default, createServer },
  };
});
vi.mock("node:http2", async (importOriginal) => {
  const actual: any = await importOriginal();
  const createSecureServer = (...args: unknown[]) => {
    const server = (actual.default.createSecureServer as any)(...args);
    createdServers.push(server);
    return server;
  };
  return {
    ...actual,
    createSecureServer,
    default: { ...actual.default, createSecureServer },
  };
});

import { startHttpServer } from "./http.ts";
import { startHttp2Server } from "./http2.ts";
import { apiRouteRegistry } from "./server-api.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

interface Exchange {
  text: string;
  /** ms from connect until the server closed the socket. */
  closedAfterMs: number;
  timedOut: boolean;
}

/**
 * Takes a connecting socket, runs `send`, then waits for the server to close the socket (or
 * the budget to pass) and reports what came back.
 */
function exchange(
  socket: net.Socket,
  send: (socket: net.Socket) => Promise<void>,
): Promise<Exchange> {
  return new Promise((resolve) => {
    const started = Date.now();
    let text = "";
    let done = false;
    const finish = (timedOut: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(budget);
      socket.destroy();
      resolve({ text, closedAfterMs: Date.now() - started, timedOut });
    };
    const budget = setTimeout(() => finish(true), CUTOFF_BUDGET_MS);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (text += chunk));
    socket.on("error", () => {});
    socket.on("close", () => finish(false));
    const ready = socket instanceof tls.TLSSocket ? "secureConnect" : "connect";
    socket.once(ready, () => {
      send(socket).catch(() => {});
    });
  });
}

const statusLines = (text: string): string[] =>
  text.match(/^HTTP\/1\.1 \d{3}/gm) ?? [];

// Each cut-off may take up to CUTOFF_BUDGET_MS, past vitest's 5 s default.
describe("http.timeouts reach the Node servers", { timeout: 15_000 }, () => {
  let httpPort: number;
  let tlsPort: number;
  let testDir: string;
  let trustTestCert: { ca: string; servername: string };
  const originalRoutes = (apiRouteRegistry as any).routes;
  const openSockets = new Set<net.Socket>();

  const plain = () => net.connect(httpPort, "127.0.0.1");
  const overTls = () =>
    tls.connect({
      port: tlsPort,
      host: "127.0.0.1",
      ...trustTestCert,
      ALPNProtocols: ["http/1.1"],
    });
  const connectH2 = () =>
    http2.connect(`https://127.0.0.1:${tlsPort}`, trustTestCert);

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), "bascik-http-timeouts-"));
    const distDir = join(testDir, "dist");
    await mkdir(distDir, { recursive: true });
    await writeFile(join(distDir, "index.html"), "<html>Home</html>");
    configState.directory.out = distDir;

    (apiRouteRegistry as any).routes = ["fast", "slow", "upload"].map(
      (name) => ({
        path: `/api/${name}`,
        filePath: join(testDir, `api-${name}.ts`),
        paramNames: [],
        isDynamic: false,
      }),
    );
    vi.spyOn(apiRouteRegistry, "init").mockResolvedValue(undefined as any);

    const { scriptRegistry } = await import("./script-registry.ts");
    vi.spyOn(scriptRegistry, "load").mockImplementation(async (filePath) => {
      if (filePath.includes("slow")) {
        // A stream that is silent for longer than request and keepAlive,
        // as an SSE response or a long stream script is.
        return {
          filePath,
          version: 0,
          module: {
            GET: async () =>
              new Response(
                new ReadableStream({
                  async start(controller) {
                    controller.enqueue(new TextEncoder().encode("first;"));
                    await sleep(SLOW_RESPONSE_MS);
                    controller.enqueue(new TextEncoder().encode("last"));
                    controller.close();
                  },
                }),
                { headers: { "content-type": "text/plain" } },
              ),
          },
        };
      }
      if (filePath.includes("upload")) {
        return {
          filePath,
          version: 0,
          module: {
            POST: async (req: Request) =>
              new Response(`got ${(await req.text()).length}`),
          },
        };
      }
      return {
        filePath,
        version: 0,
        module: { GET: async () => new Response("fast") },
      };
    });

    const keyPath = join(testDir, "key.pem");
    const certPath = join(testDir, "cert.pem");
    await execFile("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ]);
    configState.http.tls.keyFile = keyPath;
    configState.http.tls.certFile = certPath;
    trustTestCert = {
      ca: await readFile(certPath, "utf8"),
      servername: "localhost",
    };

    configState.http.port = await freePort();
    await startHttpServer();
    httpPort = configState.http.port;

    configState.http.port = await freePort();
    await startHttp2Server();
    tlsPort = configState.http.port;

    for (const server of createdServers) {
      for (const event of ["connection", "secureConnection"]) {
        server.on(event, (s: net.Socket) => {
          openSockets.add(s);
          s.once("close", () => openSockets.delete(s));
        });
      }
    }
  }, 30_000);

  afterAll(async () => {
    (apiRouteRegistry as any).routes = originalRoutes;
    for (const s of openSockets) s.destroy();
    await Promise.all(
      createdServers.map(
        (server) =>
          new Promise<void>((r) => {
            (server as httpTypes.Server).closeAllConnections?.();
            server.close(() => r());
          }),
      ),
    );
    await rm(testDir, { recursive: true, force: true });
  });

  it.each([
    ["plain HTTP/1.1", () => plain()],
    ["HTTP/1.1 over TLS", () => overTls()],
  ])(
    "%s: a client that stalls mid-headers gets 408 at headers",
    async (_name, connect) => {
      const res = await exchange(connect(), async (s) => {
        s.write("GET /api/fast HTTP/1.1\r\nHost: 127.0.0.1\r\n");
      });
      expect(res.timedOut).toBe(false);
      expect(statusLines(res.text)).toEqual(["HTTP/1.1 408"]);
      expect(res.closedAfterMs).toBeGreaterThanOrEqual(HEADERS_MS - 50);
    },
  );

  it("a body that trickles past request is cut off", async () => {
    const res = await exchange(plain(), async (s) => {
      s.write(
        "POST /api/upload HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100\r\n\r\n",
      );
      for (let i = 0; i < 20 && !s.destroyed; i++) {
        s.write("x");
        await sleep(150);
      }
    });
    expect(res.timedOut).toBe(false);
    expect(res.text).not.toContain("got ");
    expect(res.closedAfterMs).toBeGreaterThanOrEqual(REQUEST_MS - 50);
  });

  it("an idle keep-alive socket closes after keepAlive", async () => {
    const res = await exchange(plain(), async (s) => {
      s.write("GET /api/fast HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    });
    expect(res.timedOut).toBe(false);
    expect(statusLines(res.text)).toEqual(["HTTP/1.1 200"]);
    expect(res.text).toContain("fast");
    expect(res.closedAfterMs).toBeGreaterThanOrEqual(KEEP_ALIVE_MS - 50);
  });

  it("a keep-alive socket that sends again within keepAlive is reused", async () => {
    const res = await exchange(plain(), async (s) => {
      s.write("GET /api/fast HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
      await sleep(KEEP_ALIVE_MS / 4);
      s.write("GET /api/fast HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    });
    expect(statusLines(res.text)).toEqual(["HTTP/1.1 200", "HTTP/1.1 200"]);
  });

  it("request bounds receiving the request: a response longer than it arrives whole", async () => {
    const res = await exchange(plain(), async (s) => {
      s.write(
        "GET /api/slow HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
      );
    });
    expect(res.timedOut).toBe(false);
    expect(statusLines(res.text)).toEqual(["HTTP/1.1 200"]);
    expect(res.text).toContain("first;");
    expect(res.text).toContain("last");
    expect(res.closedAfterMs).toBeGreaterThanOrEqual(SLOW_RESPONSE_MS - 50);
  });

  it("HTTP/2: a session with no open stream closes after keepAlive", async () => {
    const session = connectH2();
    const started = Date.now();
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const req = session.request({ ":path": "/api/fast" });
        let text = "";
        req.setEncoding("utf8");
        req.on("data", (c: string) => (text += c));
        req.on("end", () => resolve(text));
        req.on("error", reject);
        req.end();
      });
      expect(body).toBe("fast");
      const closedAfterMs = await new Promise<number>((resolve) => {
        const budget = setTimeout(() => resolve(-1), CUTOFF_BUDGET_MS);
        session.once("close", () => {
          clearTimeout(budget);
          resolve(Date.now() - started);
        });
      });
      expect(closedAfterMs, "session never closed").toBeGreaterThan(0);
      expect(closedAfterMs).toBeGreaterThanOrEqual(KEEP_ALIVE_MS - 50);
    } finally {
      session.destroy();
    }
  });

  it("HTTP/2: a silent open stream (SSE) holds its session past keepAlive", async () => {
    const session = connectH2();
    let closedEarly = false;
    session.once("close", () => (closedEarly = true));
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const req = session.request({ ":path": "/api/slow" });
        let text = "";
        req.setEncoding("utf8");
        req.on("data", (c: string) => (text += c));
        req.on("end", () => resolve(text));
        req.on("error", reject);
        req.end();
      });
      expect(body).toBe("first;last");
      expect(closedEarly).toBe(false);
    } finally {
      session.destroy();
    }
  });
});
