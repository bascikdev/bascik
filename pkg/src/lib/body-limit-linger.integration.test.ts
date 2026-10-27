/**
 * Over-limit request bodies: the 413 must reach the client intact.
 *
 * A client that POSTs more than `http.maxBodySize` is answered 413 while it is
 * still uploading. If the server closes the connection the moment the 413 is
 * written, the client's next write hits a closed socket and it reports
 * EPIPE/ECONNRESET instead of the 413 (the pkg e2e "413 on oversized body"
 * flake in the prod http2 lane). The fix is a lingering close: after the 413,
 * keep reading and discarding the rest of the body, bounded by a byte cap and
 * a time cap, and only then close.
 *
 * Ground rules:
 * - The real `startHttpServer` (plain HTTP/1.1) and `startHttp2Server` (TLS,
 *   HTTP/2 with the `allowHTTP1` fallback that Playwright's APIRequestContext
 *   negotiates) run the real request handler; only `createServer` and
 *   `createSecureServer` are wrapped so the test can close what it started.
 * - Clients are raw `node:net` / `node:tls` sockets and the `node:http2`
 *   client, writing the body in chunks with pauses so the server answers
 *   mid-upload, the way a real client does.
 * - The limit is the 1 MiB default and the upload is 2 MiB, matching e2e.
 * - Misuse: a client that never stops sending, a lying Content-Length in both
 *   directions, chunked bodies, an aborted upload, a keep-alive client that
 *   pipelines a second request, unlimited bodies (maxBodySize 0), and HTTP/2.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type httpTypes from "node:http";
import http2 from "node:http2";
import net from "node:net";
import tls from "node:tls";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

const MiB = 1024 * 1024;
/** The shipped default (config.ts), so this suite exercises what e2e hits. */
const LIMIT = MiB;
/** Twice the limit, as the e2e test sends. */
const OVERSIZE = 2 * MiB;
/** Small enough that the server answers 413 long before the upload ends. */
const CHUNK = 64 * 1024;
/** Long enough between chunks that the 413 lands mid-upload every run. */
const PAUSE_MS = 3;
/**
 * Upper bound for the server to cut off a client that stalls or floods. The
 * lingering-close idle cap (LINGER_IDLE_MS) must sit well under this, so a
 * server that drains forever fails here instead of hanging the suite.
 */
const CUTOFF_BUDGET_MS = 10_000;
/**
 * Upper bound for a client that keeps trickling, which only the total cap
 * (LINGER_MAX_MS) stops: that cap plus room for a loaded machine.
 */
const TRICKLE_BUDGET_MS = LINGER_MAX_MS + 10_000;
/** A response the server sends without waiting on the body arrives this fast. */
const PROMPT_MS = 1_000;

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
import { LINGER_IDLE_MS, LINGER_MAX_MS } from "./request-body-linger.ts";

// ── Raw client ────────────────────────────────────────────────────────────

interface ParsedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** False when the bytes ended before the declared body did. */
  complete: boolean;
}

interface UploadResult {
  raw: Buffer;
  /** Every HTTP/1.x response found on the wire, in order. */
  responses: ParsedResponse[];
  /** EPIPE/ECONNRESET and friends, from the socket or a write callback. */
  error?: NodeJS.ErrnoException;
  bytesWritten: number;
  /** ms from connect until the socket closed. */
  elapsedMs: number;
  /** ms from connect until the first response byte, if any arrived. */
  firstByteMs?: number;
  /** The client gave up waiting (the server never closed). */
  timedOut: boolean;
}

interface Writer {
  /** Resolves false once the socket can no longer be written. */
  write(buf: Buffer | string): Promise<boolean>;
  /** Resolves true once `text` has arrived from the server, false on close or timeout. */
  waitFor(text: string, ms?: number): Promise<boolean>;
  /** Half-closes: the client is done sending, as curl is after a final response to its Expect. */
  end(): void;
  readonly closed: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Decodes a chunked body; returns null if the terminating chunk is missing. */
function decodeChunked(buf: Buffer): { body: Buffer; used: number } | null {
  const parts: Buffer[] = [];
  let at = 0;
  for (;;) {
    const lineEnd = buf.indexOf("\r\n", at);
    if (lineEnd < 0) return null;
    const size = parseInt(buf.subarray(at, lineEnd).toString("latin1"), 16);
    if (Number.isNaN(size)) return null;
    at = lineEnd + 2;
    if (size === 0) {
      const trailerEnd = buf.indexOf("\r\n", at);
      if (trailerEnd < 0) return null;
      return { body: Buffer.concat(parts), used: trailerEnd + 2 };
    }
    if (at + size + 2 > buf.length) return null;
    parts.push(buf.subarray(at, at + size));
    at += size + 2;
  }
}

/** Splits raw bytes into consecutive HTTP/1.x responses. */
function parseResponses(raw: Buffer): ParsedResponse[] {
  const out: ParsedResponse[] = [];
  let rest = raw;
  while (rest.length > 0) {
    const headEnd = rest.indexOf("\r\n\r\n");
    if (headEnd < 0) {
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(rest.toString("latin1"));
      out.push({
        status: status ? Number(status[1]) : 0,
        headers: {},
        body: "",
        complete: false,
      });
      break;
    }
    const lines = rest.subarray(0, headEnd).toString("latin1").split("\r\n");
    const status = /^HTTP\/1\.[01] (\d{3})/.exec(lines[0] ?? "");
    const headers: Record<string, string> = {};
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(":");
      if (colon > 0) {
        headers[line.slice(0, colon).trim().toLowerCase()] = line
          .slice(colon + 1)
          .trim();
      }
    }
    const afterHead = rest.subarray(headEnd + 4);
    let body: Buffer = Buffer.alloc(0);
    let used = 0;
    let complete = true;
    if (headers["transfer-encoding"]?.includes("chunked")) {
      const decoded = decodeChunked(afterHead);
      if (decoded) {
        body = decoded.body;
        used = decoded.used;
      } else {
        complete = false;
        used = afterHead.length;
      }
    } else if (headers["content-length"] !== undefined) {
      const len = Number(headers["content-length"]);
      complete = afterHead.length >= len;
      body = afterHead.subarray(0, len);
      used = Math.min(len, afterHead.length);
    } else {
      // Close-delimited: the body is whatever came before the close.
      body = afterHead;
      used = afterHead.length;
    }
    out.push({
      status: status ? Number(status[1]) : 0,
      headers,
      body: body.toString("utf8"),
      complete,
    });
    rest = afterHead.subarray(used);
  }
  return out;
}

/**
 * Opens a socket, runs `send` to write the request, then waits for the server
 * to close the connection (or `waitMs` to pass) and reports what came back.
 */
function rawExchange(
  connect: () => net.Socket,
  send: (w: Writer) => Promise<void>,
  waitMs = CUTOFF_BUDGET_MS,
): Promise<UploadResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let error: NodeJS.ErrnoException | undefined;
    let bytesWritten = 0;
    let closed = false;
    let timedOut = false;
    let firstByteMs: number | undefined;
    const started = Date.now();
    const socket = connect();
    const writer: Writer = {
      get closed() {
        return closed || socket.destroyed || !socket.writable;
      },
      end() {
        if (!writer.closed) socket.end();
      },
      async waitFor(text, ms = CUTOFF_BUDGET_MS) {
        const until = Date.now() + ms;
        while (Date.now() < until) {
          if (Buffer.concat(chunks).toString("latin1").includes(text))
            return true;
          if (closed) return false;
          await sleep(5);
        }
        return false;
      },
      write(buf) {
        if (writer.closed) return Promise.resolve(false);
        return new Promise((done) => {
          socket.write(buf, (err) => {
            if (err) {
              error ??= err;
              done(false);
              return;
            }
            bytesWritten += typeof buf === "string" ? buf.length : buf.length;
            done(true);
          });
        });
      },
    };
    socket.on("data", (c: Buffer) => {
      firstByteMs ??= Date.now() - started;
      chunks.push(c);
    });
    socket.on("error", (err: NodeJS.ErrnoException) => {
      error ??= err;
    });
    const guard = setTimeout(() => {
      timedOut = true;
      socket.destroy();
    }, waitMs);
    socket.on("close", () => {
      closed = true;
      clearTimeout(guard);
      const raw = Buffer.concat(chunks);
      resolve({
        raw,
        responses: parseResponses(raw),
        error,
        bytesWritten,
        elapsedMs: Date.now() - started,
        firstByteMs,
        timedOut,
      });
    });
    const ready = socket instanceof tls.TLSSocket ? "secureConnect" : "connect";
    socket.once(ready, () => {
      send(writer).catch((err) => {
        error ??= err;
      });
    });
  });
}

/** Writes `total` bytes in CHUNK-sized pieces with a pause after each. */
async function writeBody(
  w: Writer,
  total: number,
  opts: { chunked?: boolean; pauseMs?: number } = {},
): Promise<boolean> {
  const piece = Buffer.alloc(CHUNK, 0x61);
  let sent = 0;
  while (sent < total) {
    const n = Math.min(CHUNK, total - sent);
    const data = n === CHUNK ? piece : piece.subarray(0, n);
    const ok = opts.chunked
      ? await w.write(
          Buffer.concat([
            Buffer.from(`${n.toString(16)}\r\n`),
            data,
            Buffer.from("\r\n"),
          ]),
        )
      : await w.write(data);
    if (!ok) return false;
    sent += n;
    await sleep(opts.pauseMs ?? PAUSE_MS);
  }
  if (opts.chunked) return w.write("0\r\n\r\n");
  return true;
}

const uploadHead = (
  framing: string,
  connection = "close",
  path = "/api/upload",
) =>
  `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\n${framing}\r\n` +
  `Content-Type: application/octet-stream\r\nConnection: ${connection}\r\n\r\n`;

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

/** The 413 the API runtime produces, delivered whole. */
function expectComplete413(res: UploadResult, context: string): void {
  expect(
    res.error,
    `${context}: client must not see a transport error`,
  ).toBeUndefined();
  expect(res.timedOut, `${context}: server must close the connection`).toBe(
    false,
  );
  expect(res.responses.length, `${context}: one response`).toBe(1);
  const [first] = res.responses;
  expect(first.status, context).toBe(413);
  expect(first.complete, `${context}: 413 body complete`).toBe(true);
  expect(first.body, context).toBe("Payload Too Large");
  expect(first.headers["connection"], context).toBe("close");
}

/**
 * The server kept reading until the client finished its upload instead of
 * closing under it. A client that gives up writing because the server sent
 * FIN mid-body is the same bug as EPIPE, just a politer client.
 */
function expectUploadFinished(
  res: UploadResult,
  bodyBytes: number,
  context: string,
): void {
  expect(
    res.bytesWritten,
    `${context}: client must be able to send its whole body`,
  ).toBeGreaterThanOrEqual(bodyBytes);
}

describe("over-limit bodies get a complete 413 (lingering close)", () => {
  let httpPort: number;
  let tlsPort: number;
  let testDir: string;
  /** Handler runs that read the whole body; a 413 must never add one. */
  let sideEffects = 0;
  const originalRoutes = (apiRouteRegistry as any).routes;
  const openSockets = new Set<net.Socket>();

  const plain = () => net.connect(httpPort, "127.0.0.1");
  const overTls = () =>
    tls.connect({
      port: tlsPort,
      host: "127.0.0.1",
      rejectUnauthorized: false,
      ALPNProtocols: ["http/1.1"],
    });

  async function assertHealthy(context: string): Promise<void> {
    const res = await rawExchange(plain, async (w) => {
      await w.write(
        "GET /api/healthy HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
      );
    });
    expect(res.responses[0]?.status, `${context}: healthy after`).toBe(200);
  }

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), "bascik-413-linger-"));
    const distDir = join(testDir, "dist");
    await mkdir(distDir, { recursive: true });
    await writeFile(join(distDir, "index.html"), "<html>Home</html>");
    configState.directory.out = distDir;

    (apiRouteRegistry as any).routes = [
      {
        path: "/api/healthy",
        filePath: join(testDir, "api-healthy.ts"),
        paramNames: [],
        isDynamic: false,
      },
      {
        path: "/api/upload",
        filePath: join(testDir, "api-upload.ts"),
        paramNames: [],
        isDynamic: false,
      },
      {
        path: "/api/echo",
        filePath: join(testDir, "api-echo.ts"),
        paramNames: [],
        isDynamic: false,
      },
    ];
    // init() would rescan the (empty) api directory and drop these routes.
    vi.spyOn(apiRouteRegistry, "init").mockResolvedValue(undefined as any);

    const { scriptRegistry } = await import("./script-registry.ts");
    vi.spyOn(scriptRegistry, "load").mockImplementation(async (filePath) => {
      if (filePath.includes("echo")) {
        // Streams the request body back, so the body is read only while the
        // response is pulled: the limit trips after the 200 is committed.
        return {
          filePath,
          version: 0,
          module: {
            POST: async (req: Request) =>
              new Response(req.body, {
                status: 200,
                headers: { "content-type": "application/octet-stream" },
              }),
          },
        };
      }
      if (filePath.includes("healthy")) {
        return {
          filePath,
          version: 0,
          module: {
            GET: async () =>
              new Response(JSON.stringify({ healthy: true }), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
          },
        };
      }
      return {
        filePath,
        version: 0,
        module: {
          POST: async (req: Request) => {
            let received = 0;
            if (req.body) {
              const reader = req.body.getReader();
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                received += value.byteLength;
              }
            }
            sideEffects++;
            return new Response(JSON.stringify({ received }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          },
        },
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

    configState.http.port = await freePort();
    await startHttpServer();
    httpPort = configState.http.port;

    configState.http.port = await freePort();
    await startHttp2Server();
    tlsPort = configState.http.port;

    for (const server of createdServers) {
      server.on("connection", (s: net.Socket) => {
        openSockets.add(s);
        s.once("close", () => openSockets.delete(s));
      });
      server.on("secureConnection", (s: net.Socket) => {
        openSockets.add(s);
        s.once("close", () => openSockets.delete(s));
      });
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

  // ── The reported bug ────────────────────────────────────────────────────
  describe("2 MiB POST against the 1 MiB default (a declared length takes the early 413, chunked trips mid-read)", () => {
    it("HTTP/1.1 plain: complete 413, no EPIPE/ECONNRESET", async () => {
      const before = sideEffects;
      const res = await rawExchange(plain, async (w) => {
        await w.write(uploadHead(`Content-Length: ${OVERSIZE}`));
        await writeBody(w, OVERSIZE);
      });
      expectComplete413(res, "http1 plain");
      expectUploadFinished(res, OVERSIZE, "http1 plain");
      expect(sideEffects).toBe(before);
      await assertHealthy("http1 plain");
    });

    it("HTTP/1.1 over TLS (allowHTTP1, what Playwright negotiates): complete 413", async () => {
      const before = sideEffects;
      const res = await rawExchange(overTls, async (w) => {
        await w.write(uploadHead(`Content-Length: ${OVERSIZE}`));
        await writeBody(w, OVERSIZE);
      });
      expectComplete413(res, "http1 over tls");
      expectUploadFinished(res, OVERSIZE, "http1 over tls");
      expect(sideEffects).toBe(before);
    });

    it("chunked body with no length: complete 413", async () => {
      const res = await rawExchange(plain, async (w) => {
        await w.write(uploadHead("Transfer-Encoding: chunked"));
        await writeBody(w, OVERSIZE, { chunked: true });
      });
      expectComplete413(res, "chunked");
      expectUploadFinished(res, OVERSIZE, "chunked");
      await assertHealthy("chunked");
    });

    it(
      "HTTP/2: complete 413 on the stream, session stays usable",
      async () => {
        const before = sideEffects;
        const client = http2.connect(`https://127.0.0.1:${tlsPort}`, {
          rejectUnauthorized: false,
        });
        try {
          const result = await new Promise<{
            status: number;
            body: string;
            error?: Error;
            rstCode?: number;
            timedOut?: boolean;
          }>((resolve) => {
            const req = client.request({
              ":method": "POST",
              ":path": "/api/upload",
              "content-type": "application/octet-stream",
              "content-length": String(OVERSIZE),
            });
            let status = 0;
            let body = "";
            let error: Error | undefined;
            const guard = setTimeout(() => {
              resolve({ status, body, error, timedOut: true });
              req.close(http2.constants.NGHTTP2_CANCEL);
            }, CUTOFF_BUDGET_MS);
            req.on("close", () => clearTimeout(guard));
            req.on("response", (h) => (status = Number(h[":status"])));
            req.on("data", (c: Buffer) => (body += c.toString("utf8")));
            req.on("error", (e) => (error ??= e));
            req.on("close", () =>
              resolve({ status, body, error, rstCode: req.rstCode }),
            );
            void (async () => {
              const piece = Buffer.alloc(CHUNK, 0x61);
              for (let sent = 0; sent < OVERSIZE; sent += CHUNK) {
                if (req.destroyed || req.closed) return;
                await new Promise<void>((r) => req.write(piece, () => r()));
                await sleep(PAUSE_MS);
              }
              if (!req.destroyed) req.end();
            })();
          });
          expect(result.timedOut, "h2 stream must settle").toBeUndefined();
          expect(result.error, "h2 stream must not error").toBeUndefined();
          expect(result.status).toBe(413);
          expect(result.body).toBe("Payload Too Large");
          // NO_ERROR: either the body was drained or the server told the client
          // to stop sending (RFC 9113 8.1), never a hard stream failure.
          expect(result.rstCode).toBe(http2.constants.NGHTTP2_NO_ERROR);
          expect(sideEffects).toBe(before);

          const healthy = await new Promise<number>((resolve, reject) => {
            const req = client.request({ ":path": "/api/healthy" });
            req.on("response", (h) => resolve(Number(h[":status"])));
            req.on("error", reject);
            req.resume();
          });
          expect(healthy, "same h2 session after 413").toBe(200);
        } finally {
          client.close();
        }
      },
      CUTOFF_BUDGET_MS * 2,
    );
  });

  // ── Misuse ──────────────────────────────────────────────────────────────
  describe("misuse", () => {
    it(
      "a client that never stops sending is cut off within the caps",
      async () => {
        // Declares far more than any byte cap and sends as fast as it can.
        const res = await rawExchange(plain, async (w) => {
          await w.write(uploadHead(`Content-Length: ${1024 * MiB}`));
          const piece = Buffer.alloc(CHUNK, 0x61);
          while (await w.write(piece)) {
            // a firehose: no pause
          }
        });
        expect(res.timedOut, "server must cut the firehose off").toBe(false);
        expect(res.elapsedMs).toBeLessThan(CUTOFF_BUDGET_MS);
        expect(res.responses[0]?.status).toBe(413);
        expect(res.bytesWritten).toBeLessThan(1024 * MiB);
        await assertHealthy("firehose");
      },
      CUTOFF_BUDGET_MS * 2,
    );

    it(
      "a slowloris that trickles after the limit is cut off by the total cap (Content-Length and chunked)",
      async () => {
        // One byte every 200 ms: never idle long enough for LINGER_IDLE_MS,
        // never near the byte cap, so only the total cap can end it. Both
        // framings run at once: Content-Length takes the early 413, chunked
        // trips the limit mid-read.
        const trickle = (framing: string, chunked: boolean) =>
          rawExchange(
            plain,
            async (w) => {
              await w.write(uploadHead(framing));
              const piece = Buffer.alloc(CHUNK, 0x61);
              for (let sent = 0; sent <= LIMIT; sent += CHUNK) {
                const ok = chunked
                  ? await w.write(
                      Buffer.concat([
                        Buffer.from(`${CHUNK.toString(16)}\r\n`),
                        piece,
                        Buffer.from("\r\n"),
                      ]),
                    )
                  : await w.write(piece);
                if (!ok) return;
              }
              while (await w.write(chunked ? "1\r\na\r\n" : "a"))
                await sleep(200);
            },
            TRICKLE_BUDGET_MS,
          );
        const results = await Promise.all([
          trickle(`Content-Length: ${OVERSIZE * 4}`, false),
          trickle("Transfer-Encoding: chunked", true),
        ]);
        for (const [i, res] of results.entries()) {
          const context = i === 0 ? "content-length" : "chunked";
          expect(
            res.timedOut,
            `${context}: server must cut the trickle off`,
          ).toBe(false);
          // Held past the idle cap: each byte restarted it.
          expect(res.elapsedMs, context).toBeGreaterThan(
            LINGER_IDLE_MS + 1_000,
          );
          expect(res.elapsedMs, context).toBeLessThan(TRICKLE_BUDGET_MS);
          expect(res.responses[0]?.status, context).toBe(413);
          expect(res.responses[0]?.complete, context).toBe(true);
        }
        await assertHealthy("slowloris");
      },
      TRICKLE_BUDGET_MS * 2,
    );

    it(
      "a chunked client that floods past the limit is cut off by the byte cap",
      async () => {
        // No length to answer early from: the limit trips mid-read and the
        // drain runs to LINGER_MAX_BYTES.
        const res = await rawExchange(plain, async (w) => {
          await w.write(uploadHead("Transfer-Encoding: chunked"));
          const piece = Buffer.concat([
            Buffer.from(`${CHUNK.toString(16)}\r\n`),
            Buffer.alloc(CHUNK, 0x61),
            Buffer.from("\r\n"),
          ]);
          while (await w.write(piece)) {
            // a firehose: no pause
          }
        });
        expect(res.timedOut, "server must cut the firehose off").toBe(false);
        expect(res.elapsedMs).toBeLessThan(CUTOFF_BUDGET_MS);
        expect(res.responses[0]?.status).toBe(413);
        expect(res.responses[0]?.complete).toBe(true);
        await assertHealthy("chunked firehose");
      },
      CUTOFF_BUDGET_MS * 2,
    );

    it(
      "a chunked body that stalls after the limit is closed by the idle cap",
      async () => {
        const res = await rawExchange(plain, async (w) => {
          await w.write(uploadHead("Transfer-Encoding: chunked"));
          const piece = Buffer.concat([
            Buffer.from(`${CHUNK.toString(16)}\r\n`),
            Buffer.alloc(CHUNK, 0x61),
            Buffer.from("\r\n"),
          ]);
          // Past the limit, then quiet: no terminating chunk ever comes.
          for (let sent = 0; sent < LIMIT + 2 * CHUNK; sent += CHUNK) {
            if (!(await w.write(piece))) return;
            await sleep(PAUSE_MS);
          }
        });
        expect(res.timedOut, "server must not wait forever").toBe(false);
        expect(res.elapsedMs).toBeLessThan(CUTOFF_BUDGET_MS);
        expect(res.responses[0]?.status).toBe(413);
        expect(res.responses[0]?.complete).toBe(true);
      },
      CUTOFF_BUDGET_MS * 2,
    );

    it(
      "Content-Length larger than sent (over the limit, body stalls): 413 then closed by the idle cap",
      async () => {
        const res = await rawExchange(plain, async (w) => {
          await w.write(uploadHead(`Content-Length: ${3 * MiB}`));
          await writeBody(w, OVERSIZE); // then goes quiet, never finishing
        });
        expect(res.error).toBeUndefined();
        expect(res.timedOut, "server must not wait forever").toBe(false);
        expect(res.responses.length).toBe(1);
        expect(res.responses[0].status).toBe(413);
        expect(res.responses[0].complete).toBe(true);
      },
      CUTOFF_BUDGET_MS * 2,
    );

    it(
      "declared Content-Length over the limit is answered 413 before the body arrives",
      async () => {
        // Early path: the declared length alone proves the body is too large,
        // so the server must not wait for (or on) bytes it will reject.
        const before = sideEffects;
        const res = await rawExchange(plain, async (w) => {
          await w.write(uploadHead(`Content-Length: ${OVERSIZE}`));
          await w.write(Buffer.alloc(1024, 0x61));
        });
        expect(res.timedOut, "413 then close, without the body").toBe(false);
        expect(res.elapsedMs).toBeLessThan(CUTOFF_BUDGET_MS);
        // The 413 itself must not wait on the body: a server that answered
        // only when the drain gave up would still close within the budget.
        expect(res.firstByteMs, "413 sent before the drain ends").toBeLessThan(
          PROMPT_MS,
        );
        expect(res.responses.length).toBe(1);
        expect(res.responses[0].status).toBe(413);
        expect(res.responses[0].complete).toBe(true);
        expect(sideEffects).toBe(before);
      },
      CUTOFF_BUDGET_MS * 2,
    );

    for (const [name, connect] of [
      ["plain", () => plain()],
      ["over TLS", () => overTls()],
    ] as const) {
      it(`Expect: 100-continue with a declared length over the limit (${name}) gets the 413 without 100 Continue`, async () => {
        // A polite client asks before uploading; telling it to go ahead
        // only to reject the upload would waste the whole body.
        const before = sideEffects;
        let got413 = false;
        const res = await rawExchange(connect, async (w) => {
          await w.write(
            `POST /api/upload HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
              `Content-Length: ${OVERSIZE}\r\nExpect: 100-continue\r\n` +
              `Connection: close\r\n\r\n`,
          );
          got413 = await w.waitFor("413", PROMPT_MS);
          w.end();
        });
        expect(got413, "413 arrives without the body being sent").toBe(true);
        expect(res.raw.toString("latin1")).not.toContain("100 Continue");
        expect(res.responses[0]?.status).toBe(413);
        expect(res.responses[0]?.complete).toBe(true);
        expect(res.timedOut).toBe(false);
        expect(sideEffects).toBe(before);
      });
    }

    it("Expect: 100-continue within the limit still gets 100 Continue, then the response", async () => {
      const res = await rawExchange(plain, async (w) => {
        await w.write(
          `POST /api/upload HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
            `Content-Length: ${CHUNK}\r\nExpect: 100-continue\r\n` +
            `Connection: close\r\n\r\n`,
        );
        if (await w.waitFor("100 Continue", PROMPT_MS)) {
          await w.write(Buffer.alloc(CHUNK, 0x61));
        }
      });
      const raw = res.raw.toString("latin1");
      expect(raw.startsWith("HTTP/1.1 100 Continue\r\n\r\n")).toBe(true);
      const final = parseResponses(
        res.raw.subarray("HTTP/1.1 100 Continue\r\n\r\n".length),
      );
      expect(final[0]?.status).toBe(200);
      expect(JSON.parse(final[0].body)).toEqual({ received: CHUNK });
    });

    it("Expect: 100-continue over the limit to a method the route does not export gets 405 with Allow, no 100", async () => {
      // Method policy outranks the body limit; the body is never needed.
      const res = await rawExchange(plain, async (w) => {
        await w.write(
          `POST /api/healthy HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
            `Content-Length: ${OVERSIZE}\r\nExpect: 100-continue\r\n` +
            `Connection: close\r\n\r\n`,
        );
        await w.waitFor("405", PROMPT_MS);
        w.end();
      });
      expect(res.raw.toString("latin1")).not.toContain("100 Continue");
      expect(res.responses[0]?.status).toBe(405);
      expect(res.responses[0]?.headers["allow"]).toBe("GET, HEAD, OPTIONS");
    });

    it("a limit that trips while the response streams the body back still lets the client finish its upload", async () => {
      // The echo commits a 200 before the limit trips, so the client gets a
      // truncated response, but it must not be cut off mid-write (EPIPE).
      const res = await rawExchange(plain, async (w) => {
        await w.write(
          uploadHead("Transfer-Encoding: chunked", "close", "/api/echo"),
        );
        await writeBody(w, OVERSIZE, { chunked: true });
      });
      expect(
        res.error,
        "client must not see a transport error",
      ).toBeUndefined();
      expect(res.timedOut, "server must close the connection").toBe(false);
      expectUploadFinished(res, OVERSIZE, "echo");
      expect(res.responses[0]?.status).toBe(200);
      // The echo stopped at the limit; it is never a complete 2 MiB body.
      expect(res.responses[0]?.complete).toBe(false);
      await assertHealthy("echo");
    });

    it(
      "a chunked firehose into a streaming echo is still cut off by the byte cap",
      async () => {
        const res = await rawExchange(plain, async (w) => {
          await w.write(
            uploadHead("Transfer-Encoding: chunked", "close", "/api/echo"),
          );
          const piece = Buffer.concat([
            Buffer.from(`${CHUNK.toString(16)}\r\n`),
            Buffer.alloc(CHUNK, 0x61),
            Buffer.from("\r\n"),
          ]);
          while (await w.write(piece)) {
            // a firehose: no pause
          }
        });
        expect(res.timedOut, "server must cut the firehose off").toBe(false);
        expect(res.elapsedMs).toBeLessThan(CUTOFF_BUDGET_MS);
        await assertHealthy("echo firehose");
      },
      CUTOFF_BUDGET_MS * 2,
    );

    it("bytes past a declared Content-Length are never parsed as a second request", async () => {
      // The client says 2 MiB but keeps going with what looks like a pipelined
      // request; once the drain reaches the declared end the server closes.
      const res = await rawExchange(plain, async (w) => {
        await w.write(uploadHead(`Content-Length: ${OVERSIZE}`, "keep-alive"));
        await writeBody(w, OVERSIZE);
        await w.write(
          "GET /api/healthy HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
        );
      });
      expectComplete413(res, "trailing bytes");
      expectUploadFinished(res, OVERSIZE, "trailing bytes");
      expect(res.raw.toString("latin1")).not.toContain("healthy");
    });

    it("a keep-alive client's second request after the 413 is not served on that connection", async () => {
      const res = await rawExchange(plain, async (w) => {
        await w.write(uploadHead(`Content-Length: ${OVERSIZE}`, "keep-alive"));
        await writeBody(w, OVERSIZE);
        await sleep(20);
        await w.write(
          "GET /api/healthy HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n",
        );
      });
      expectComplete413(res, "keep-alive");
      expectUploadFinished(res, OVERSIZE, "keep-alive");
      expect(res.raw.toString("latin1")).not.toContain("healthy");
      await assertHealthy("keep-alive");
    });

    it("a client that aborts mid-upload leaves the server healthy and the handler unrun", async () => {
      const before = sideEffects;
      // Past the limit (so the server is mid-drain), then the client vanishes.
      await new Promise<void>((resolve) => {
        const s = plain();
        s.on("error", () => {});
        s.on("close", () => resolve());
        s.once("connect", async () => {
          s.write(uploadHead(`Content-Length: ${OVERSIZE}`));
          for (let i = 0; i < LIMIT / CHUNK + 4; i++) {
            s.write(Buffer.alloc(CHUNK, 0x61));
            await sleep(PAUSE_MS);
          }
          s.destroy();
        });
      });
      await sleep(50);
      expect(sideEffects).toBe(before);
      await assertHealthy("aborted upload");
    });

    it(
      "HTTP/2: a stream that never stops sending is cut off; the session survives",
      async () => {
        const client = http2.connect(`https://127.0.0.1:${tlsPort}`, {
          rejectUnauthorized: false,
        });
        try {
          const started = Date.now();
          const result = await new Promise<{ status: number; closed: boolean }>(
            (resolve) => {
              const req = client.request({
                ":method": "POST",
                ":path": "/api/upload",
                "content-type": "application/octet-stream",
              });
              let status = 0;
              const guard = setTimeout(() => {
                resolve({ status, closed: false });
                req.close(http2.constants.NGHTTP2_CANCEL);
              }, CUTOFF_BUDGET_MS);
              req.on("response", (h) => (status = Number(h[":status"])));
              req.on("error", () => {});
              req.resume();
              req.on("close", () => {
                clearTimeout(guard);
                resolve({ status, closed: true });
              });
              void (async () => {
                const piece = Buffer.alloc(CHUNK, 0x61);
                while (!req.destroyed && !req.closed) {
                  await new Promise<void>((r) => req.write(piece, () => r()));
                }
              })();
            },
          );
          expect(result.closed, "server must end the endless stream").toBe(
            true,
          );
          expect(Date.now() - started).toBeLessThan(CUTOFF_BUDGET_MS);
          expect(result.status).toBe(413);

          const healthy = await new Promise<number>((resolve, reject) => {
            const req = client.request({ ":path": "/api/healthy" });
            req.on("response", (h) => resolve(Number(h[":status"])));
            req.on("error", reject);
            req.resume();
          });
          expect(healthy, "same h2 session after cut-off").toBe(200);
        } finally {
          client.close();
        }
      },
      CUTOFF_BUDGET_MS * 2,
    );

    it(
      "HTTP/2: DATA past a declared content-length is a protocol error that ends that session (nghttp2), and the server stays up",
      async () => {
        // Pins Node's behavior, which Bascik cannot change: nghttp2 checks
        // DATA against content-length below the stream API and answers a
        // body longer than declared with GOAWAY(PROTOCOL_ERROR), so every
        // stream on that session fails. Only an honest or absent length
        // keeps the session (the tests above).
        const client = http2.connect(`https://127.0.0.1:${tlsPort}`, {
          rejectUnauthorized: false,
        });
        client.on("error", () => {});
        const sessionClosed = new Promise<void>((r) => client.once("close", r));
        const req = client.request({
          ":method": "POST",
          ":path": "/api/upload",
          "content-type": "application/octet-stream",
          "content-length": String(OVERSIZE),
        });
        req.on("error", () => {});
        req.resume();
        void (async () => {
          const piece = Buffer.alloc(CHUNK, 0x61);
          while (!req.destroyed && !req.closed) {
            await new Promise<void>((r) => req.write(piece, () => r()));
          }
        })();
        const closedInTime = await Promise.race([
          sessionClosed.then(() => true),
          sleep(CUTOFF_BUDGET_MS).then(() => false),
        ]);
        if (!closedInTime) client.destroy();
        expect(closedInTime, "nghttp2 ends the lying session").toBe(true);

        const fresh = http2.connect(`https://127.0.0.1:${tlsPort}`, {
          rejectUnauthorized: false,
        });
        try {
          const healthy = await new Promise<number>((resolve, reject) => {
            const r = fresh.request({ ":path": "/api/healthy" });
            r.on("response", (h) => resolve(Number(h[":status"])));
            r.on("error", reject);
            r.resume();
          });
          expect(healthy, "a new session is served").toBe(200);
        } finally {
          fresh.close();
        }
      },
      CUTOFF_BUDGET_MS * 2,
    );

    it("an upload under the limit is unaffected", async () => {
      const res = await rawExchange(plain, async (w) => {
        await w.write(uploadHead(`Content-Length: ${LIMIT / 2}`));
        await writeBody(w, LIMIT / 2);
      });
      expect(res.error).toBeUndefined();
      expect(res.responses[0]?.status).toBe(200);
      expect(JSON.parse(res.responses[0].body)).toEqual({
        received: LIMIT / 2,
      });
    });

    it("http.maxBodySize 0 (unlimited) still accepts a 2 MiB chunked upload", async () => {
      configState.http.maxBodySize = 0;
      try {
        const res = await rawExchange(plain, async (w) => {
          await w.write(uploadHead("Transfer-Encoding: chunked"));
          await writeBody(w, OVERSIZE, { chunked: true });
        });
        expect(res.error).toBeUndefined();
        expect(res.responses[0]?.status).toBe(200);
        expect(JSON.parse(res.responses[0].body)).toEqual({
          received: OVERSIZE,
        });
      } finally {
        configState.http.maxBodySize = LIMIT;
      }
    });
  });
});
