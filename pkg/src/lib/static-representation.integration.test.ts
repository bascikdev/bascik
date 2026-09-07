import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, rename, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import zlib from "node:zlib";
import http from "node:http";
import http2 from "node:http2";
import { createHash } from "node:crypto";
import { getContentHashEtag, clearCompressedRepresentationCache } from "./caching.ts";

const execFile = promisify(execFileCb);

// ─── Hoisted shared mock config / mem ────────────────────────────────────────
// The integration test exercises the REAL HTTP adapters on loopback with the
// REAL `createRequestHandler`, but a controllable `directory.out` pointing at an
// isolated temp dist. `BascikConfig` is module-frozen at import time, so we
// provide a plain mutable stand-in via `vi.mock`.

vi.mock("./config.js", () => ({
  shouldLog: vi.fn(() => false),
  BascikConfig: {
    base: "/",
    http: {
      httpCache: true,
      compression: true,
      rateLimit: false,
      tls: { enabled: false },
      cacheControl: "public, max-age=3600",
      trustProxy: false,
    },
    scripts: { timeout: 30000 },
    logging: { level: "silent", requests: false },
    isProdServer: true,
    directory: { pages: "src/pages", components: ["src/components"], out: "" },
    minify: { identifiers: false },
  },
}));

vi.mock("./mem.js", () => ({
  mem: {
    getPage: vi.fn(() => undefined),
    getPageExact: vi.fn(() => undefined),
    trackOpenPage: vi.fn(),
    untrackOpenPage: vi.fn(),
    isBooting: false,
    setBootingDone: vi.fn(),
  },
}));

// ─── Real module imports (after mocks) ───────────────────────────────────────
import { createRequestHandler } from "./server.ts";
import { adaptHttp1 } from "./http.ts";
import { adaptHttp2 } from "./http2.ts";
import { BascikConfig } from "./config.ts";

const setDistDir = (dir: string) => {
  (BascikConfig.directory as { out: string }).out = dir;
};

// ─── HTTP helpers ────────────────────────────────────────────────────────────

interface FetchResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  /** Raw body bytes exactly as received (before any manual decoding). */
  raw: Buffer;
}

const http1Fetch = (
  server: http.Server,
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<FetchResult> => {
  return new Promise((resolve, reject) => {
    const addr = server.address() as import("node:net").AddressInfo;
    const req = http.request(
      {
        host: "127.0.0.1",
        port: addr.port,
        path,
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            raw: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
};

const http2Fetch = (
  server: http2.Http2SecureServer,
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<FetchResult> => {
  return new Promise((resolve, reject) => {
    const addr = server.address() as import("node:net").AddressInfo;
    const client = http2.connect(`https://127.0.0.1:${addr.port}`, {
      rejectUnauthorized: false,
    });
    client.on("error", reject);
    const req = client.request({
      ":method": options.method ?? "GET",
      ":path": path,
      ...options.headers,
    });
    req.on("error", reject);
    const chunks: Buffer[] = [];
    let rHeaders: http.IncomingHttpHeaders = {};
    req.on("response", (h) => { rHeaders = h; });
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      resolve({
        status: Number(rHeaders[":status"]) || 0,
        headers: rHeaders,
        raw: Buffer.concat(chunks),
      });
      client.close();
    });
  });
};

// Strip quotes / weak prefix from an ETag header.
const etagBody = (etag: string | undefined): string =>
  (etag ?? "").replace(/^W\//i, "").replace(/"/g, "");

/** Decode a Brotli or gzip body if advertised; identity passes through. */
const decodeBody = (res: FetchResult): Buffer => {
  const enc = typeof res.headers["content-encoding"] === "string"
    ? res.headers["content-encoding"]
    : undefined;
  if (enc === "br") return zlib.brotliDecompressSync(res.raw);
  if (enc === "gzip") return zlib.gunzipSync(res.raw);
  return res.raw;
};

const sha256 = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

// getContentHashEtag returns a quoted strong etag; the .bmeta provenance stores
// the same string so the server's rawEtag comparison is exact.
const quotedHash = (buf: Buffer): string => `"${sha256(buf)}"`;

// ─── Server wiring (real adapters + real handler) ────────────────────────────

const makeHttp1Server = (): http.Server => {
  const server = http.createServer();
  const handleRequest = createRequestHandler();
  server.on("request", (reqMsg, resMsg) => {
    const { req, res } = adaptHttp1(reqMsg, resMsg);
    handleRequest(req, res).catch(() => {});
  });
  return server;
};

const makeHttp2Server = async (certDir: string): Promise<http2.Http2SecureServer> => {
  const keyFile = join(certDir, "key.pem");
  const certFile = join(certDir, "cert.pem");
  await mkdir(certDir, { recursive: true });
  try {
    await execFile("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1",
      "-subj", "/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout", keyFile, "-out", certFile,
    ], { stdio: "ignore" } as never);
  } catch {
    // Fall back to any pre-existing certs if openssl is unavailable.
  }
  const server = http2.createSecureServer({
    key: await readFile(keyFile),
    cert: await readFile(certFile),
    allowHTTP1: true,
  });
  const handleRequest = createRequestHandler();
  server.on("stream", (stream, headers) => {
    const { req, res } = adaptHttp2(stream, headers);
    handleRequest(req, res).catch(() => {});
  });
  server.on("request", (reqMsg, resMsg) => {
    if (reqMsg.httpVersion === "2.0") return;
    const { req, res } = adaptHttp1(reqMsg as any, resMsg as any);
    handleRequest(req, res).catch(() => {});
  });
  return server;
};

// ─── Fixture helpers ─────────────────────────────────────────────────────────

const oldBody = () => Buffer.from("OLD".repeat(300)); // 900 bytes
const newBody = () => Buffer.from("NEW".repeat(300)); // 900 bytes

const installRelease = async (dist: string, name: string, content: Buffer) => {
  await mkdir(dist, { recursive: true });
  await writeFile(join(dist, name), content);
};

describe("Prompt 107 - static representation snapshot integrity (integration)", () => {
  let dist: string;
  let http1Server: http.Server;
  let http2Server: http2.Http2SecureServer;

  const start = async () => {
    dist = await mkdtemp(join(tmpdir(), "bascik-repr-dist-"));
    setDistDir(dist);
    clearCompressedRepresentationCache();

    http1Server = makeHttp1Server();
    await new Promise<void>((r) => http1Server.listen(0, "127.0.0.1", r));

    http2Server = await makeHttp2Server(dist);
    await new Promise<void>((r) => http2Server.listen(0, "127.0.0.1", r));
  };

  const stop = async () => {
    clearCompressedRepresentationCache();
    if (http1Server) await new Promise<void>((r) => { http1Server.close(() => r()); });
    if (http2Server) await new Promise<void>((r) => { http2Server.close(() => r()); });
    if (dist) await rm(dist, { recursive: true, force: true }).catch(() => {});
  };

  beforeEach(async () => {
    await start();
  });

  afterEach(async () => {
    await stop();
  });

  // Run the same scenario across both real adapters.
  const runOnBothAdapters = (
    name: string,
    fn: (fetch: (p: string, o?: { method?: string; headers?: Record<string, string> }) => Promise<FetchResult>) => Promise<void>,
  ) => {
    describe(name, () => {
      it("HTTP/1.1 loopback", async () => {
        await fn((p, o) => http1Fetch(http1Server, p, o));
      });
      it("HTTP/2 loopback", async () => {
        await fn((p, o) => http2Fetch(http2Server, p, o));
      });
    });
  };

  runOnBothAdapters("no-write control: validator, length, and body describe one representation", async (fetch) => {
    await installRelease(dist, "style.css", oldBody());

    const res = await fetch("/style.css", { headers: { "accept-encoding": "identity" } });
    const body = decodeBody(res);

    expect(res.status).toBe(200);
    expect(body.toString()).toBe("OLD".repeat(300));
    expect(String(res.headers["content-length"])).toBe(String(body.byteLength));
    // The ETag must be the strong content hash of the ACTUAL delivered body.
    expect(etagBody(res.headers.etag as string)).toBe(sha256(body));
    expect(etagBody(res.headers.etag as string)).toBe(getContentHashEtag(body).replace(/"/g, ""));
  });

  runOnBothAdapters(
    "atomic same-size replacement: served body hash always equals its own ETag",
    async (fetch) => {
      await installRelease(dist, "style.css", oldBody());
      await fetch("/style.css", { headers: { "accept-encoding": "identity" } });

      // Atomically replace OLD with NEW (same length) between requests. Whether
      // the response observes OLD or NEW, the validator must hash the actual
      // bytes delivered (never an old hash with new bytes).
      await rename(join(dist, "style.css"), join(dist, "style.css.tmp"));
      await writeFile(join(dist, "style.css.tmp"), newBody());
      await rename(join(dist, "style.css.tmp"), join(dist, "style.css"));

      const res = await fetch("/style.css", { headers: { "accept-encoding": "identity" } });
      const body = decodeBody(res);
      expect(res.status).toBe(200);
      expect(["OLD".repeat(300), "NEW".repeat(300)]).toContain(body.toString());
      // One ownership read means header + body are the same snapshot.
      expect(etagBody(res.headers.etag as string)).toBe(sha256(body));
      expect(String(res.headers["content-length"])).toBe(String(body.byteLength));
    },
  );

  runOnBothAdapters(
    "in-place interleaving (same size): served body hash always equals its own ETag",
    async (fetch) => {
      await installRelease(dist, "inline.css", oldBody());
      await fetch("/inline.css", { headers: { "accept-encoding": "identity" } });

      // In-place write at the same boundary OLD -> NEW, same length.
      await writeFile(join(dist, "inline.css"), newBody());

      const res = await fetch("/inline.css", { headers: { "accept-encoding": "identity" } });
      const body = decodeBody(res);
      expect(res.status).toBe(200);
      expect(["OLD".repeat(300), "NEW".repeat(300)]).toContain(body.toString());
      expect(etagBody(res.headers.etag as string)).toBe(sha256(body));
      expect(String(res.headers["content-length"])).toBe(String(body.byteLength));
    },
  );

  runOnBothAdapters(
    "stale sidecar: unverified old .br bytes are never served as current content",
    async (fetch) => {
      await installRelease(dist, "app.css", oldBody());

      // Precompress the OLD content into a sidecar with NO provenance (.bmeta).
      // Then the raw asset becomes NEW. The now-stale sidecar must not be served
      // as though it matched the current content, so the decoded body is NEW.
      await writeFile(join(dist, "app.css.br"), zlib.brotliCompressSync(oldBody()));
      await installRelease(dist, "app.css", newBody());

      const res = await fetch("/app.css", { headers: { "accept-encoding": "br" } });
      const body = decodeBody(res);

      expect(res.status).toBe(200);
      expect(body.toString()).toBe("NEW".repeat(300));
      // The stale sidecar was rejected; a fresh encoding of the CURRENT content
      // is served, whose encoded ETag derives from the current raw hash.
      expect(etagBody(res.headers.etag as string)).toBe(`${sha256(newBody())}-br`);
    },
  );

  runOnBothAdapters("corrupt sidecar: garbage .br bytes are not served after provenance", async (fetch) => {
    await installRelease(dist, "lib.js", oldBody());

    // Corrupt sidecar: garbage bytes with a matching provenance stamp. The
    // one-time representation-creation decompression must detect corruption and
    // reject the sidecar, falling back to a fresh valid encoding.
    await writeFile(join(dist, "lib.js.br"), Buffer.from("this is not brotli"));
    await writeFile(join(dist, "lib.js.br.bmeta"), JSON.stringify({ rawHash: quotedHash(oldBody()) }));

    const res = await fetch("/lib.js", { headers: { "accept-encoding": "br" } });
    const body = decodeBody(res);
    expect(res.status).toBe(200);
    // Even though a corrupt sidecar exists, the served content is valid.
    expect(body.toString()).toBe("OLD".repeat(300));
    // The encoded representation's ETag is the raw content hash suffixed by -br.
    expect(etagBody(res.headers.etag as string)).toBe(`${sha256(oldBody())}-br`);
  });

  runOnBothAdapters("corrupt gzip sidecar: garbage .gz bytes are not served", async (fetch) => {
    await installRelease(dist, "gears.js", oldBody());

    // Corrupt gzip sidecar with matching provenance: rejected at creation time.
    await writeFile(join(dist, "gears.js.gz"), Buffer.from("this is not gzip"));
    await writeFile(join(dist, "gears.js.gz.bmeta"), JSON.stringify({ rawHash: quotedHash(oldBody()) }));

    const res = await fetch("/gears.js", { headers: { "accept-encoding": "gzip" } });
    const body = decodeBody(res);
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(body.toString()).toBe("OLD".repeat(300));
    expect(etagBody(res.headers.etag as string)).toBe(`${sha256(oldBody())}-gzip`);
  });

  runOnBothAdapters("verified sidecar: provenance-bound .br bytes ARE served and match", async (fetch) => {
    await installRelease(dist, "fonts.js", oldBody());

    const verifiedBr = zlib.brotliCompressSync(oldBody());
    await writeFile(join(dist, "fonts.js.br"), verifiedBr);
    await writeFile(join(dist, "fonts.js.br.bmeta"), JSON.stringify({ rawHash: quotedHash(oldBody()) }));

    const res = await fetch("/fonts.js", { headers: { "accept-encoding": "br" } });
    const body = decodeBody(res);

    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("br");
    expect(body.toString()).toBe("OLD".repeat(300));
    // The encoded ETag derives from the raw content hash.
    expect(etagBody(res.headers.etag as string)).toBe(`${sha256(oldBody())}-br`);
  });

  runOnBothAdapters("length-changing replacement: no validator/body/framing mismatch", async (fetch) => {
    await installRelease(dist, "chunk.js", Buffer.from("X".repeat(64)));
    const res1 = await fetch("/chunk.js", { headers: { "accept-encoding": "identity" } });
    expect(decodeBody(res1).toString()).toBe("X".repeat(64));
    const etag1 = etagBody(res1.headers.etag as string);

    // Length-changing replacement (64 -> 233 bytes).
    await installRelease(dist, "chunk.js", Buffer.from("Y".repeat(233)));
    const res2 = await fetch("/chunk.js", { headers: { "accept-encoding": "identity" } });
    const body2 = decodeBody(res2);
    expect(body2.toString()).toBe("Y".repeat(233));
    expect(etagBody(res2.headers.etag as string)).not.toBe(etag1);
    expect(etagBody(res2.headers.etag as string)).toBe(sha256(body2));
    expect(String(res2.headers["content-length"])).toBe("233");
  });

  runOnBothAdapters("empty file serves a zero-length representation", async (fetch) => {
    await installRelease(dist, "empty.css", Buffer.alloc(0));

    const res = await fetch("/empty.css", { headers: { "accept-encoding": "identity" } });
    expect(res.status).toBe(200);
    expect(res.raw.byteLength).toBe(0);
    expect(String(res.headers["content-length"])).toBe("0");
    expect(etagBody(res.headers.etag as string)).toBe(sha256(Buffer.alloc(0)));
  });

  runOnBothAdapters("deletion after selection responds 404", async (fetch) => {
    await installRelease(dist, "gone.css", oldBody());
    await fetch("/gone.css", { headers: { "accept-encoding": "identity" } });

    await rm(join(dist, "gone.css"));
    const res = await fetch("/gone.css", { headers: { "accept-encoding": "identity" } });
    expect(res.status).toBe(404);
  });

  runOnBothAdapters("HEAD returns the same metadata as GET with no body", async (fetch) => {
    await installRelease(dist, "theme.css", oldBody());

    const GET = await fetch("/theme.css", { headers: { "accept-encoding": "identity" } });
    const HEAD = await fetch("/theme.css", {
      method: "HEAD",
      headers: { "accept-encoding": "identity" },
    });

    expect(HEAD.status).toBe(200);
    expect(HEAD.raw.byteLength).toBe(0);
    expect(String(HEAD.headers["content-length"])).toBe(String(GET.headers["content-length"]));
    expect(String(HEAD.headers["content-length"])).toBe(String(oldBody().byteLength));
  });

  runOnBothAdapters("GET/304 coherence: a matching validator returns 304", async (fetch) => {
    await installRelease(dist, "cache.css", oldBody());
    const first = await fetch("/cache.css", { headers: { "accept-encoding": "identity" } });
    const etag = first.headers.etag as string;

    const again = await fetch("/cache.css", {
      headers: { "accept-encoding": "identity", "if-none-match": etag },
    });
    expect(again.status).toBe(304);
    expect(again.raw.byteLength).toBe(0);
  });

  runOnBothAdapters("concurrent readers observe consistent representations", async (fetch) => {
    await installRelease(dist, "hot.css", oldBody());

    const results = await Promise.all(
      Array.from({ length: 8 }, () => fetch("/hot.css", { headers: { "accept-encoding": "identity" } })),
    );
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(decodeBody(r).toString()).toBe("OLD".repeat(300));
      expect(etagBody(r.headers.etag as string)).toBe(sha256(decodeBody(r)));
    }
  });

  it("canceled read is safe and subsequent requests still serve a consistent representation", async () => {
    await installRelease(dist, "abort.css", oldBody());

    // Issue an HTTP/1.1 request and abort it immediately (canceled read).
    const addr1 = http1Server.address() as import("node:net").AddressInfo;
    await new Promise<void>((resolve) => {
      const req = http.request({
        host: "127.0.0.1", port: addr1.port, path: "/abort.css",
        headers: { "accept-encoding": "identity" },
      });
      req.on("error", () => { /* expected on abort */ });
      req.on("close", () => resolve());
      req.end();
      setTimeout(() => req.destroy(), 5);
    });

    // A normal request after the cancel must still be coherent on both adapters.
    const res1 = await http1Fetch(http1Server, "/abort.css", { headers: { "accept-encoding": "identity" } });
    expect(res1.status).toBe(200);
    expect(decodeBody(res1).toString()).toBe("OLD".repeat(300));
    expect(etagBody(res1.headers.etag as string)).toBe(sha256(decodeBody(res1)));

    const res2 = await http2Fetch(http2Server, "/abort.css", { headers: { "accept-encoding": "identity" } });
    expect(res2.status).toBe(200);
    expect(decodeBody(res2).toString()).toBe("OLD".repeat(300));
    expect(etagBody(res2.headers.etag as string)).toBe(sha256(decodeBody(res2)));
  });
});