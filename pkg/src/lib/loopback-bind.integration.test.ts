/**
 * Audit 159 findings 46, 86 and 143: with the default `hostname: "localhost"`
 * Node binds only the first address the resolver returns (`::1` on macOS
 * with Node 24), so `http://127.0.0.1:<port>` was refused, and a program
 * already on `127.0.0.1:<port>` went unnoticed while Bascik announced
 * `http://localhost:<port>`. `localhost` now means both loopbacks.
 *
 * Real sockets on ports 44060-44079.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import net from "node:net";

// WHY: each case opens real listeners on both loopbacks and, for the
// port-conflict cases, closes and reopens them on the next port. The Node
// floor runner on CI took over the default 5 s for that under load (the
// socket close is what waits, not Bascik), while the same case takes a few
// milliseconds alone.
vi.setConfig({ testTimeout: 30_000 });

const { configState } = vi.hoisted(() => ({
  configState: {
    base: "/",
    http: {
      hostname: "localhost",
      port: 0,
      httpCache: false,
      compression: false,
      rateLimit: false,
      tls: { enabled: false },
      timeouts: { drain: 2000 },
    },
    scripts: { timeout: 30000 },
    logging: { level: "silent", requests: false },
    isProdServer: false,
    directory: {
      pages: "src/pages",
      components: ["src/components"],
      out: "dist",
    },
  },
}));

vi.mock("./config.js", () => ({
  shouldLog: () => false,
  BascikConfig: configState,
}));

import { startServerInstance } from "./server.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  configState.http.hostname = "localhost";
  configState.isProdServer = false;
});

const savedEnvPort = process.env.BASCIK_SERVER_PORT;
const savedPort = process.env.PORT;
delete process.env.BASCIK_SERVER_PORT;
delete process.env.PORT;
afterEach(() => {
  if (savedEnvPort !== undefined) process.env.BASCIK_SERVER_PORT = savedEnvPort;
  if (savedPort !== undefined) process.env.PORT = savedPort;
});

const closeServer = (server: net.Server) =>
  new Promise<void>((resolve) => {
    (server as http.Server).closeAllConnections?.();
    server.close(() => resolve());
  });

const start = async (port: number) => {
  configState.http.port = port;
  const server = http.createServer((req, res) =>
    res.end(`bascik via ${req.socket.localAddress}`),
  );
  const origin = await startServerInstance(server, "http");
  cleanup.push(() => closeServer(server));
  return { server, origin };
};

const blocker = async (host: string, port: number) => {
  const server = net.createServer((socket) =>
    socket.end("HTTP/1.1 200 OK\r\nContent-Length: 7\r\n\r\nBLOCKER"),
  );
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
  return server;
};

const fetchFrom = (host: string, port: number) =>
  new Promise<string>((resolve) => {
    const req = http.get({ host, port, path: "/", agent: false }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve(body));
    });
    req.on("error", (error: NodeJS.ErrnoException) =>
      resolve(`error ${error.code}`),
    );
  });

const bindable = (host: string, port: number) =>
  new Promise<boolean>((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });

describe("hostname localhost listens on both loopbacks", () => {
  it("answers on 127.0.0.1 and on [::1] (findings 46 and 86)", async () => {
    const { origin } = await start(44060);
    expect(origin).toBe("http://localhost:44060");
    expect(await fetchFrom("127.0.0.1", 44060)).toBe("bascik via 127.0.0.1");
    expect(await fetchFrom("::1", 44060)).toBe("bascik via ::1");
  });

  it("dev moves to the next port when another program holds 127.0.0.1 (finding 143)", async () => {
    await blocker("127.0.0.1", 44062);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { origin } = await start(44062);
      expect(origin).toBe("http://localhost:44063");
      expect(warn).toHaveBeenCalledWith("Port 44062 is in use, trying 44063…");
      expect(await fetchFrom("127.0.0.1", 44063)).toBe("bascik via 127.0.0.1");
      expect(await fetchFrom("::1", 44063)).toBe("bascik via ::1");
      // The port it gave up is left whole on ::1 for the next run.
      expect(await bindable("::1", 44062)).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("dev moves to the next port when another program holds [::1]", async () => {
    await blocker("::1", 44065);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { origin } = await start(44065);
      expect(origin).toBe("http://localhost:44066");
      expect(await fetchFrom("127.0.0.1", 44066)).toBe("bascik via 127.0.0.1");
    } finally {
      warn.mockRestore();
    }
  });

  it("--server refuses a port another program holds on 127.0.0.1", async () => {
    configState.isProdServer = true;
    await blocker("127.0.0.1", 44068);
    configState.http.port = 44068;
    const server = http.createServer();
    await expect(startServerInstance(server, "http")).rejects.toThrow(
      /Port 44068 is already in use/,
    );
    expect(server.listening).toBe(false);
    expect(await bindable("::1", 44068)).toBe(true);
  });

  it("close() releases both loopbacks and waits for both", async () => {
    const { server } = await start(44070);
    let closed = false;
    await new Promise<void>((resolve) =>
      server.close(() => {
        closed = true;
        resolve();
      }),
    );
    expect(closed).toBe(true);
    expect(await bindable("127.0.0.1", 44070)).toBe(true);
    expect(await bindable("::1", 44070)).toBe(true);
    cleanup.pop();
  });

  it("an explicit 127.0.0.1 binds only IPv4", async () => {
    configState.http.hostname = "127.0.0.1";
    const { origin } = await start(44072);
    expect(origin).toBe("http://127.0.0.1:44072");
    expect(await fetchFrom("127.0.0.1", 44072)).toBe("bascik via 127.0.0.1");
    expect(await fetchFrom("::1", 44072)).toMatch(/^error ECONNREFUSED/);
  });
});
