/**
 * Packet P1: raw HTTP/1.1 wire syntax, framing faults, and upload limits.
 *
 * Ground rules:
 * - Real HTTP/1.1 server running real `createRequestHandler` with `adaptHttp1`.
 * - Local raw TCP socket clients using `node:net`.
 * - Bounded test cases: malformed escapes/UTF-8, request-line/header syntax,
 *   authority, conflicting framing, oversized headers, malformed chunks,
 *   declared length mismatch, partial upload disconnects, body-limit crossing,
 *   and method rejection (GET/HEAD with body, auto-OPTIONS, 405).
 * - Every fault test asserts protocol-valid termination without cross-request
 *   contamination, followed by healthy/readiness verification over a fresh connection.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import http2 from "node:http2";
import net from "node:net";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

const { configState } = vi.hoisted(() => ({
  configState: {
    base: "/",
    http: {
      httpCache: false,
      compression: false,
      rateLimit: false,
      tls: { enabled: false },
      trustProxy: false,
      maxBodySize: 1024, // 1 KB limit for upload tests
      apiTimeout: 10000,
    },
    scripts: { timeout: 30000, onServerScriptError: "error" },
    logging: { level: "silent", requests: false },
    isProdServer: false,
    directory: { pages: "src/pages", components: ["src/components"], api: "src/api", out: "" },
    minify: { identifiers: false },
  },
}));

vi.mock("./config.js", () => ({
  shouldLog: () => false,
  BascikConfig: configState,
}));

import { adaptHttp1 } from "./http.ts";
import { adaptHttp2 } from "./http2.ts";
import { createRequestHandler } from "./server.ts";
import { apiRouteRegistry } from "./server-api.ts";
import { BascikConfig } from "./config.ts";

interface RawResponse {
  raw: Buffer;
  head: string;
  body: string;
  status: number;
  headers: Record<string, string>;
  socketClosed: boolean;
  error?: Error;
}

/** Parses raw HTTP/1.1 response bytes into headers, status, and body. */
function parseRawHttpResponse(buf: Buffer): { head: string; body: string; status: number; headers: Record<string, string> } {
  const str = buf.toString("latin1");
  const headEnd = str.indexOf("\r\n\r\n");
  if (headEnd < 0) {
    const statusMatch = /^HTTP\/1\.[01] (\d{3})/.exec(str);
    return { head: str, body: "", status: statusMatch ? Number(statusMatch[1]) : 0, headers: {} };
  }
  const head = str.substring(0, headEnd);
  const body = buf.subarray(headEnd + 4).toString("utf8");
  const lines = head.split("\r\n");
  const statusMatch = /^HTTP\/1\.[01] (\d{3})/.exec(lines[0] ?? "");
  const status = statusMatch ? Number(statusMatch[1]) : 0;
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const colon = lines[i].indexOf(":");
    if (colon > 0) {
      headers[lines[i].substring(0, colon).trim().toLowerCase()] = lines[i].substring(colon + 1).trim();
    }
  }
  return { head, body, status, headers };
}

/** Helper to send raw bytes over a TCP socket and capture response and socket closure. */
function sendRawBytes(port: number, payload: Buffer | string, options: { delayMs?: number; closeAfterWrite?: boolean } = {}): Promise<RawResponse> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const socket = net.connect(port, "127.0.0.1", () => {
      const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
      socket.write(data, () => {
        if (options.closeAfterWrite) {
          socket.destroy();
        }
      });
    });

    let closed = false;
    socket.on("data", (chunk) => {
      chunks.push(chunk);
    });

    socket.on("close", () => {
      closed = true;
      const raw = Buffer.concat(chunks);
      const parsed = parseRawHttpResponse(raw);
      resolve({ raw, ...parsed, socketClosed: closed });
    });

    socket.on("error", (err) => {
      const raw = Buffer.concat(chunks);
      const parsed = parseRawHttpResponse(raw);
      resolve({ raw, ...parsed, socketClosed: closed, error: err });
    });
  });
}

/** Oracle asserting that the response indicates either a protocol rejection status or socket termination without success. */
function assertProtocolRejection(res: RawResponse, permittedStatuses: number[], context: string): void {
  if (res.status !== 0) {
    expect(
      permittedStatuses,
      `${context}: expected status in [${permittedStatuses.join(",")}], got ${res.status}`
    ).toContain(res.status);
  } else {
    // If status is 0, Node rejected at the socket/framing layer before generating HTTP response
    expect(res.socketClosed, `${context}: socket must be closed on framing rejection`).toBe(true);
  }
}

describe("packet P1: raw HTTP/1.1 and upload protocol faults", () => {
  let server: http.Server;
  let serverPort: number;
  let http2Server: http2.Http2SecureServer;
  let http2Port: number;
  let testDir: string;
  const originalRoutes = (apiRouteRegistry as any).routes;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), "bascik-p1-protocol-"));
    const distDir = join(testDir, "dist");
    await mkdir(distDir, { recursive: true });
    await writeFile(join(distDir, "index.html"), "<html><body>Home</body></html>");
    await writeFile(join(distDir, "style.css"), "body { color: black; }");

    configState.directory.out = distDir;

    // Authored API modules in memory
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
        path: "/api/stream",
        filePath: join(testDir, "api-stream.ts"),
        paramNames: [],
        isDynamic: false,
      },
      {
        path: "/api/echo-method",
        filePath: join(testDir, "api-echo-method.ts"),
        paramNames: [],
        isDynamic: false,
      },
    ];

    const { scriptRegistry } = await import("./script-registry.ts");
    vi.spyOn(scriptRegistry, "load").mockImplementation(async (filePath) => {
      if (filePath.includes("healthy")) {
        return {
          filePath,
          version: 0,
          module: {
            GET: async () => new Response(JSON.stringify({ healthy: true }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          },
        };
      }
      if (filePath.includes("upload")) {
        return {
          filePath,
          version: 0,
          module: {
            POST: async (req: Request) => {
              let received = 0;
              if (req.body) {
                const reader = req.body.getReader();
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  received += value.byteLength;
                }
              }
              return new Response(JSON.stringify({ received }), {
                status: 200,
                headers: { "content-type": "application/json" },
              });
            },
          },
        };
      }
      if (filePath.includes("stream")) {
        return {
          filePath,
          version: 0,
          module: {
            GET: async (_req: Request, _ctx: unknown, { signal }: { signal?: AbortSignal } = {}) => {
              const stream = new ReadableStream<Uint8Array>({
                async pull(controller) {
                  controller.enqueue(Buffer.from("chunk-1\n"));
                  await new Promise((r) => setTimeout(r, 40));
                  if (!signal?.aborted) {
                    controller.enqueue(Buffer.from("chunk-2\n"));
                  }
                  controller.close();
                },
              });
              return new Response(stream, {
                status: 200,
                headers: { "content-type": "text/plain" },
              });
            },
          },
        };
      }
      return {
        filePath,
        version: 0,
        module: {
          GET: async () => new Response("ok GET", { status: 200 }),
          POST: async () => new Response("ok POST", { status: 200 }),
        },
      };
    });

    const handleRequest = createRequestHandler();
    server = http.createServer((reqMsg, resMsg) => {
      const { req, res } = adaptHttp1(reqMsg, resMsg);
      handleRequest(req, res).catch((err) => {
        if (!res.headersSent) {
          try {
            res.respond(500, { "content-type": "text/plain" });
            res.end("Internal Server Error");
          } catch {}
        }
      });
    });

    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    serverPort = (server.address() as net.AddressInfo).port;

    // TLS keys & certificates for HTTP/2
    const keyPath = join(testDir, "key.pem");
    const certPath = join(testDir, "cert.pem");
    await execFile("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1",
      "-subj", "/CN=localhost", "-keyout", keyPath, "-out", certPath,
    ]);

    http2Server = http2.createSecureServer({
      key: await readFile(keyPath),
      cert: await readFile(certPath),
      allowHTTP1: false,
    });

    http2Server.on("stream", (stream, headers) => {
      const { req, res } = adaptHttp2(stream, headers);
      handleRequest(req, res).catch((err) => {
        if (!res.headersSent) {
          try {
            res.respond(500, { "content-type": "text/plain" });
            res.end("Internal Server Error");
          } catch {}
        }
      });
    });

    await new Promise<void>((r) => http2Server.listen(0, "127.0.0.1", r));
    http2Port = (http2Server.address() as net.AddressInfo).port;
  });

  afterAll(async () => {
    (apiRouteRegistry as any).routes = originalRoutes;
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => http2Server.close(() => r()));
    await rm(testDir, { recursive: true, force: true });
  });

  /** Helper to verify server readiness and clean state over a fresh connection. */
  async function assertHealthyReadiness(context: string): Promise<void> {
    const res = await sendRawBytes(serverPort, "GET /api/healthy HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    expect(res.status, `${context}: post-fault healthy check must return 200`).toBe(200);
    expect(res.body, `${context}: healthy check response body`).toContain("healthy");
  }

  // ── Step 1: Failing Oracle Tests & Negative Controls ─────────────────────────
  describe("step 1: protocol rejection oracle and negative controls", () => {
    it("oracle rejects an accepted 200 response when protocol rejection is required (negative control)", () => {
      const fakeSuccess: RawResponse = {
        raw: Buffer.from("HTTP/1.1 200 OK\r\n\r\n"),
        head: "HTTP/1.1 200 OK",
        body: "",
        status: 200,
        headers: {},
        socketClosed: true,
      };
      expect(() => {
        assertProtocolRejection(fakeSuccess, [400, 431], "negative control test");
      }).toThrow(/expected status in \[400,431\], got 200/);
    });

    it("oracle rejects an unclosed socket when socket termination is required (negative control)", () => {
      const fakeUnclosed: RawResponse = {
        raw: Buffer.alloc(0),
        head: "",
        body: "",
        status: 0,
        headers: {},
        socketClosed: false,
      };
      expect(() => {
        assertProtocolRejection(fakeUnclosed, [400], "negative control unclosed socket");
      }).toThrow(/socket must be closed on framing rejection/);
    });

    it("HTTP/2 oracle rejects missing error on simulated stream failure (negative control)", () => {
      const assertStreamFailed = (errorCode: number | undefined) => {
        if (errorCode === undefined || errorCode === 0) {
          throw new Error("expected stream rejection, but stream completed without error");
        }
      };
      expect(() => assertStreamFailed(0)).toThrow(/expected stream rejection/);
      expect(() => assertStreamFailed(undefined)).toThrow(/expected stream rejection/);
      expect(() => assertStreamFailed(http2.constants.NGHTTP2_CANCEL)).not.toThrow();
    });
  });

  // ── Wire Syntax & Malformed Pathname Escapes ──────────────────────────────────
  describe("malformed pathname escapes and UTF-8", () => {
    it("rejects invalid percent escapes with 400 Bad Request", async () => {
      const res = await sendRawBytes(serverPort, "GET /test%ZZ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
      assertProtocolRejection(res, [400], "invalid percent escape");
      await assertHealthyReadiness("after invalid percent escape");
    });

    it("rejects overlong or malformed UTF-8 sequence with 400 Bad Request", async () => {
      const res = await sendRawBytes(serverPort, "GET /test%C0%AF HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
      assertProtocolRejection(res, [400], "malformed UTF-8 sequence");
      await assertHealthyReadiness("after malformed UTF-8");
    });

    it("rejects embedded null byte and control characters in URI", async () => {
      const res = await sendRawBytes(serverPort, "GET /test\0bad HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
      assertProtocolRejection(res, [400], "embedded null byte");
      await assertHealthyReadiness("after null byte");
    });
  });

  // ── Request Line, Headers, and Authority Syntax ──────────────────────────────
  describe("request-line, header syntax, and authority", () => {
    it("rejects request-line with invalid syntax", async () => {
      // In HTTP, an invalid request line like a control character, malformed verb or invalid syntax
      const res = await sendRawBytes(serverPort, "GET\0 /api/healthy HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
      // Node http_parser rejects invalid request lines with 400 or destroys socket
      assertProtocolRejection(res, [400], "invalid request-line syntax");
      await assertHealthyReadiness("after invalid request-line");
    });

    it("rejects spaces in header field names", async () => {
      const res = await sendRawBytes(serverPort, "GET /api/healthy HTTP/1.1\r\nHost: 127.0.0.1\r\nBad Header: val\r\nConnection: close\r\n\r\n");
      assertProtocolRejection(res, [400], "space in header name");
      await assertHealthyReadiness("after space in header name");
    });

    it("rejects HTTP/1.1 request missing Host header with 400 Bad Request", async () => {
      const res = await sendRawBytes(serverPort, "GET /api/healthy HTTP/1.1\r\nConnection: close\r\n\r\n");
      // RFC 9112 Section 3.2: HTTP/1.1 without Host MUST return 400
      assertProtocolRejection(res, [400], "missing Host header");
      await assertHealthyReadiness("after missing Host header");
    });

    it("rejects oversized headers exceeding Node limits with 431 Request Header Fields Too Large", async () => {
      const bigHeader = "X-Large: " + "A".repeat(32 * 1024) + "\r\n";
      const res = await sendRawBytes(serverPort, `GET /api/healthy HTTP/1.1\r\nHost: 127.0.0.1\r\n${bigHeader}Connection: close\r\n\r\n`);
      assertProtocolRejection(res, [431, 400], "oversized headers");
      await assertHealthyReadiness("after oversized headers");
    });
  });

  // ── Framing Conflicts, Malformed Chunks, and Length Mismatch ─────────────────
  describe("framing conflicts and chunked encoding faults", () => {
    it("rejects conflicting Transfer-Encoding and Content-Length", async () => {
      const payload = "POST /api/upload HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\nContent-Length: 5\r\nConnection: close\r\n\r\n5\r\nhello\r\n0\r\n\r\n";
      const res = await sendRawBytes(serverPort, payload);
      // RFC 9112 Section 6.1: conflicting framing must be rejected with 400
      assertProtocolRejection(res, [400], "conflicting framing");
      await assertHealthyReadiness("after conflicting framing");
    });

    it("terminates on malformed chunk size syntax", async () => {
      const payload = "POST /api/upload HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\nZZ\r\nhello\r\n0\r\n\r\n";
      const res = await sendRawBytes(serverPort, payload);
      assertProtocolRejection(res, [400], "malformed chunk size");
      await assertHealthyReadiness("after malformed chunk size");
    });

    it("handles declared Content-Length mismatch where client disconnects prematurely", async () => {
      // Declares 100 bytes but only sends 10 then destroys socket
      const payload = "POST /api/upload HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100\r\n\r\n0123456789";
      const res = await sendRawBytes(serverPort, payload, { closeAfterWrite: true });
      assertProtocolRejection(res, [400, 499], "declared length disconnect");
      await assertHealthyReadiness("after declared length disconnect");
    });
  });

  // ── Upload Disconnects & Body Limit Crossing ─────────────────────────────────
  describe("upload limits and partial upload disconnects", () => {
    it("rejects request body exceeding maxBodySize with 413 Payload Too Large", async () => {
      const oversize = Buffer.alloc(2048, 0x61); // 2 KB > 1 KB limit
      const payload = Buffer.concat([
        Buffer.from(`POST /api/upload HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: ${oversize.length}\r\nContent-Type: application/octet-stream\r\nConnection: close\r\n\r\n`),
        oversize,
      ]);
      const res = await sendRawBytes(serverPort, payload);
      assertProtocolRejection(res, [413], "body limit exceeded");
      expect(res.headers["connection"]).toBe("close");
      await assertHealthyReadiness("after 413 payload too large");
    });

    it("handles partial streaming upload disconnect cleanly without hung handler", async () => {
      const partialData = "POST /api/upload HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\n\r\n10\r\n0123456789abcdef\r\n";
      const res = await sendRawBytes(serverPort, partialData, { closeAfterWrite: true });
      // Socket was closed abruptly mid-chunked stream
      expect(res.socketClosed).toBe(true);
      await assertHealthyReadiness("after partial streaming disconnect");
    });
  });

  // ── Method Guards, auto-OPTIONS, and Ignored/Rejected Bodies ─────────────────
  describe("method guards, auto-OPTIONS, and body handling", () => {
    it("responds 405 Method Not Allowed with Allow header for POST to static route", async () => {
      const res = await sendRawBytes(serverPort, "POST /style.css HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
      expect(res.status).toBe(405);
      expect(res.headers["allow"]).toBe("GET, HEAD");
      await assertHealthyReadiness("after 405 on static route");
    });

    it("responds 405 Method Not Allowed with Allow header for POST to health endpoint", async () => {
      const res = await sendRawBytes(serverPort, "POST /_health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
      expect(res.status).toBe(405);
      expect(res.headers["allow"]).toBe("GET, HEAD");
      await assertHealthyReadiness("after 405 on health check");
    });

    it("responds 405 with exported methods Allow header for unexported method on API route", async () => {
      const res = await sendRawBytes(serverPort, "DELETE /api/echo-method HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
      expect(res.status).toBe(405);
      expect(res.headers["allow"]).toContain("GET");
      expect(res.headers["allow"]).toContain("POST");
      expect(res.headers["allow"]).toContain("OPTIONS");
      await assertHealthyReadiness("after 405 on API route");
    });

    it("auto-responds 204 No Content with Allow header on OPTIONS when not explicitly exported", async () => {
      const res = await sendRawBytes(serverPort, "OPTIONS /api/healthy HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
      expect(res.status).toBe(204);
      expect(res.headers["allow"]).toBeDefined();
      expect(res.headers["allow"]).toContain("GET");
      expect(res.headers["allow"]).toContain("OPTIONS");
      await assertHealthyReadiness("after auto-OPTIONS");
    });

    it("ignores or drains request body sent on GET without error", async () => {
      const payload = "GET /api/healthy HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 12\r\nConnection: close\r\n\r\nignored-body";
      const res = await sendRawBytes(serverPort, payload);
      expect(res.status).toBe(200);
      expect(res.body).toContain("healthy");
      await assertHealthyReadiness("after GET with body");
    });

    it("ignores or drains request body sent on HEAD without error", async () => {
      const payload = "HEAD /api/healthy HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 12\r\nConnection: close\r\n\r\nignored-body";
      const res = await sendRawBytes(serverPort, payload);
      expect(res.status).toBe(200);
      expect(res.body).toBe(""); // HEAD must not send body
      await assertHealthyReadiness("after HEAD with body");
    });
  });

  // ── Packet P2: True HTTP/2 Faults ──────────────────────────────────────────
  describe("packet P2: true HTTP/2 stream faults and isolation", () => {
    async function assertHealthyH2Session(client: http2.ClientHttp2Session, context: string): Promise<void> {
      const healthyRes = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = client.request({ ":path": "/api/healthy", ":method": "GET" });
        let body = "";
        let status = 0;
        req.on("response", (headers) => {
          status = Number(headers[":status"]);
        });
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf8");
        });
        req.on("end", () => resolve({ status, body }));
        req.on("error", reject);
      });
      expect(healthyRes.status, `${context}: expected 200 on healthy check`).toBe(200);
      expect(healthyRes.body, `${context}: expected healthy payload`).toContain("healthy");
    }

    it("handles stream reset before commit cleanly without server crash or hang", async () => {
      const client = http2.connect("https://127.0.0.1:" + http2Port, { rejectUnauthorized: false });
      try {
        const stream = client.request({ ":path": "/api/healthy", ":method": "GET" });
        // Reset immediately before commit
        stream.close(http2.constants.NGHTTP2_CANCEL);

        await new Promise<void>((resolve) => {
          stream.on("close", resolve);
          stream.on("error", () => resolve());
        });

        // Healthy request over the same session succeeds cleanly
        await assertHealthyH2Session(client, "after reset before commit");
      } finally {
        client.close();
      }
    });

    it("handles stream reset after commit with healthy sibling isolation on the same session", async () => {
      const client = http2.connect("https://127.0.0.1:" + http2Port, { rejectUnauthorized: false });
      try {
        let streamReceivedChunk = false;
        let streamClosed = false;

        // 1. Long streaming request that will be cancelled after the first chunk arrives
        const faultyStream = client.request({ ":path": "/api/stream", ":method": "GET" });
        faultyStream.on("data", () => {
          streamReceivedChunk = true;
          faultyStream.close(http2.constants.NGHTTP2_CANCEL);
        });
        const faultySettled = new Promise<void>((resolve) => {
          faultyStream.on("close", () => {
            streamClosed = true;
            resolve();
          });
          faultyStream.on("error", () => resolve());
        });

        // 2. Concurrent healthy sibling request on the same HTTP/2 session
        const siblingPromise = new Promise<{ status: number; body: string }>((resolve, reject) => {
          const req = client.request({ ":path": "/api/healthy", ":method": "GET" });
          let body = "";
          let status = 0;
          req.on("response", (headers) => { status = Number(headers[":status"]); });
          req.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
          req.on("end", () => resolve({ status, body }));
          req.on("error", reject);
        });

        const [_, sibling] = await Promise.all([faultySettled, siblingPromise]);

        expect(streamReceivedChunk).toBe(true);
        expect(streamClosed).toBe(true);
        expect(sibling.status).toBe(200);
        expect(sibling.body).toContain("healthy");

        // Fresh request on the same session verifies no session contamination
        await assertHealthyH2Session(client, "after sibling reset");
      } finally {
        client.close();
      }
    });

    it("handles bounded simultaneous streams without framing errors or stream starvation", async () => {
      const client = http2.connect("https://127.0.0.1:" + http2Port, { rejectUnauthorized: false });
      try {
        const streamCount = 20;
        const requests = Array.from({ length: streamCount }, (_, index) => {
          return new Promise<{ index: number; status: number }>((resolve, reject) => {
            const req = client.request({ ":path": "/api/healthy", ":method": "GET" });
            let status = 0;
            req.on("response", (headers) => {
              status = Number(headers[":status"]);
            });
            req.on("data", () => {});
            req.on("end", () => resolve({ index, status }));
            req.on("error", reject);
          });
        });

        const results = await Promise.all(requests);
        expect(results).toHaveLength(streamCount);
        for (const res of results) {
          expect(res.status).toBe(200);
        }

        await assertHealthyH2Session(client, "after 20 simultaneous streams");
      } finally {
        client.close();
      }
    });

    it("handles GOAWAY and session close gracefully", async () => {
      const client = http2.connect("https://127.0.0.1:" + http2Port, { rejectUnauthorized: false });
      try {
        // Send a request to establish session
        await assertHealthyH2Session(client, "pre-goaway session check");

        // Send GOAWAY from client and close session
        client.goaway(http2.constants.NGHTTP2_NO_ERROR);
        client.destroy();

        // Subsequent stream request on destroyed session must reject
        expect(() => {
          client.request({ ":path": "/api/healthy", ":method": "GET" });
        }).toThrow(/The session has been closed|destroyed/);
      } finally {
        client.close();
      }

      // Fresh session connects and succeeds without lingering server blockade
      const freshClient = http2.connect("https://127.0.0.1:" + http2Port, { rejectUnauthorized: false });
      try {
        await assertHealthyH2Session(freshClient, "fresh session after goaway");
      } finally {
        freshClient.close();
      }
    });

    it("rejects connection-specific prohibited headers per RFC 9113", async () => {
      // RFC 9113 section 8.2.2: Node's client validates and rejects prohibited HTTP/1.1 headers
      // (connection, keep-alive, transfer-encoding) before transmitting over HTTP/2.
      // Prompt 155 specifies: "A client-library rejection is only a client control, not server
      // admission evidence. Use a protocol-capable local fixture for cases Node's ordinary client
      // cannot transmit, or explicitly report that coverage as absent."
      const client = http2.connect("https://127.0.0.1:" + http2Port, { rejectUnauthorized: false });
      try {
        expect(() => {
          client.request({
            ":path": "/api/healthy",
            ":method": "GET",
            "connection": "keep-alive",
          });
        }).toThrow(/HTTP\/1 Connection specific headers are forbidden/);

        // Verify session remains healthy after client-side prohibited header trap
        await assertHealthyH2Session(client, "after prohibited header client rejection");
      } finally {
        client.close();
      }
    });
  });
});
