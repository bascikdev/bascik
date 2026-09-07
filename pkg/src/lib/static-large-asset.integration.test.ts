/**
 * Prompt 140 (Half A): large static assets are streamed from one file handle
 * with a weak validator, and memory per in-flight request is bounded by the
 * stream's high-water mark rather than the file size.
 *
 * Runs the REAL `createRequestHandler` behind the REAL HTTP/1.1 and HTTP/2
 * adapters over loopback against an isolated temp `dist/`. This file is
 * memory-sensitive: run it in its own forked process so other tests'
 * allocations do not distort the RSS measurement:
 *
 *   vitest run src/lib/static-large-asset.integration.test.ts --pool=forks
 *
 * Measured on Node v24.17.0, macOS arm64, 8 distinct files of
 * MAX_BUFFERED_ASSET_BYTES + 1 bytes (2 MiB + 1), 8 concurrent HTTP/1.1 GETs
 * from a child-process client with `Accept-Encoding: br, gzip`, peak RSS
 * sampled every 2 ms after a forced GC (three runs each):
 *   buffered (pre-140: `getStaticRepresentation` for every request, which
 *   also Brotli-compresses each 2 MiB buffer on the fly):
 *     peak RSS growth 70.0 / 78.6 / 80.7 MiB  (35x to 40x file size)
 *   streamed (`getStaticDelivery` + `fd.createReadStream()` pipeline):
 *     peak RSS growth  1.0 /  2.3 /  2.4 MiB  (0.5x to 1.2x file size,
 *     bounded by the 64 KiB read high-water mark per stream plus socket
 *     write buffers)
 * The assertion bound is 4x the file size: above the streamed ceiling with
 * margin and far below the buffered floor.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile, stat as fsStat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import http2 from "node:http2";
import net from "node:net";
import v8 from "node:v8";
import vm from "node:vm";
import zlib from "node:zlib";
import { createHash } from "node:crypto";

// Obtain a real `gc()` without requiring the test runner to be launched with
// `--expose-gc`. Peak RSS would otherwise measure uncollected 64 KiB read
// chunks (GC timing), not what a request actually retains while in flight.
v8.setFlagsFromString("--expose-gc");
const forceGc: () => void = vm.runInNewContext("gc");

const execFile = promisify(execFileCb);

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

import { createRequestHandler } from "./server.ts";
import { adaptHttp1 } from "./http.ts";
import { adaptHttp2 } from "./http2.ts";
import { BascikConfig } from "./config.ts";
import {
  MAX_BUFFERED_ASSET_BYTES,
  MAX_CACHED_REPRESENTATION_BYTES,
  clearStaticRepresentationCache,
  getCompressedCacheEntriesCount,
  getOpenStreamedAssetHandles,
  getContentHashEtag,
  getEncodedEtag,
  getOnTheFlyCompressionCount,
} from "./caching.ts";
import { emitPrecompressedSidecars } from "./precompress.ts";
import { manifestCollector } from "./manifest.ts";

const setDistDir = (dir: string) => {
  (BascikConfig.directory as { out: string }).out = dir;
};

interface FetchResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  raw: Buffer;
}

const http1Fetch = (
  server: http.Server,
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<FetchResult> =>
  new Promise((resolve, reject) => {
    const addr = server.address() as net.AddressInfo;
    const req = http.request(
      { host: "127.0.0.1", port: addr.port, path, method: options.method ?? "GET", headers: options.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, raw: Buffer.concat(chunks) }));
      },
    );
    req.on("error", reject);
    req.end();
  });

const http2Fetch = (
  server: http2.Http2SecureServer,
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<FetchResult> =>
  new Promise((resolve, reject) => {
    const addr = server.address() as net.AddressInfo;
    const client = http2.connect(`https://127.0.0.1:${addr.port}`, { rejectUnauthorized: false });
    client.on("error", reject);
    const req = client.request({ ":method": options.method ?? "GET", ":path": path, ...options.headers });
    req.on("error", reject);
    const chunks: Buffer[] = [];
    let rHeaders: http.IncomingHttpHeaders = {};
    req.on("response", (h) => { rHeaders = h; });
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      resolve({ status: Number(rHeaders[":status"]) || 0, headers: rHeaders, raw: Buffer.concat(chunks) });
      client.close();
    });
  });

interface DigestResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  bytes: number;
  sha256: string;
}

/**
 * Burst client that runs in a CHILD process so the client's own socket and
 * heap buffers never land in the server process's RSS. Each request folds the
 * body into a SHA-256 digest as it arrives and reports status, headers,
 * byte count, and digest as JSON on stdout.
 */
const CHILD_BURST_CLIENT = `
import http from "node:http";
import { createHash } from "node:crypto";
// With \`-e\` there is no script path in argv, so the first user arg is argv[1].
const [port, acceptEncoding, ...paths] = process.argv.slice(1);
const one = (path) => new Promise((resolve, reject) => {
  const req = http.request({ host: "127.0.0.1", port: Number(port), path, method: "GET",
    headers: { "accept-encoding": acceptEncoding } }, (res) => {
    const hash = createHash("sha256");
    let bytes = 0;
    res.on("data", (c) => { bytes += c.byteLength; hash.update(c); });
    res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, bytes, sha256: hash.digest("hex") }));
  });
  req.on("error", reject);
  req.end();
});
const results = await Promise.all(paths.map(one));
process.stdout.write(JSON.stringify(results));
`;

/**
 * Run the burst in a child process while sampling THIS process's peak LIVE
 * RSS: each sample runs a full GC first so the number reflects buffers still
 * referenced by in-flight requests, not chunks awaiting collection. Sampling
 * during the burst (not after) is what catches per-request buffers that are
 * freed by the time the last response ends.
 */
const childBurst = async (
  server: http.Server,
  paths: string[],
  acceptEncoding: string,
): Promise<{ results: DigestResult[]; peakRss: number }> => {
  const addr = server.address() as net.AddressInfo;
  forceGc();
  let peakRss = process.memoryUsage().rss;
  const sampler = setInterval(() => {
    forceGc();
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 2);
  try {
    const { stdout } = await execFile(
      process.execPath,
      ["--input-type=module", "-e", CHILD_BURST_CLIENT, String(addr.port), acceptEncoding, ...paths],
      { maxBuffer: 1024 * 1024 },
    );
    return { results: JSON.parse(stdout) as DigestResult[], peakRss };
  } finally {
    clearInterval(sampler);
  }
};

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
  await execFile("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1",
    "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "-keyout", keyFile, "-out", certFile,
  ]);
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
  return server;
};

/** Deterministic, non-repeating body so byte-exactness is meaningful. */
const makeLargeBody = (size: number): Buffer => {
  const buf = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) buf[i] = (i * 31 + (i >>> 8)) & 0xff;
  return buf;
};

const waitFor = async (predicate: () => boolean): Promise<void> => {
  // Event-driven settle: yield to the event loop until the predicate holds.
  // Bounded by the vitest test timeout, no fixed sleep.
  for (;;) {
    if (predicate()) return;
    await new Promise<void>((r) => setImmediate(r));
  }
};

describe("Prompt 140 - large static assets are streamed with a weak validator", () => {
  let dist: string;
  let http1Server: http.Server;
  let http2Server: http2.Http2SecureServer;
  const LARGE = MAX_BUFFERED_ASSET_BYTES + 1;
  let largeBody: Buffer;

  beforeEach(async () => {
    dist = await mkdtemp(join(tmpdir(), "bascik-large-asset-"));
    setDistDir(dist);
    clearStaticRepresentationCache();
    largeBody = makeLargeBody(LARGE);
    await writeFile(join(dist, "big.bin"), largeBody);
    http1Server = makeHttp1Server();
    await new Promise<void>((r) => http1Server.listen(0, "127.0.0.1", r));
    http2Server = await makeHttp2Server(join(dist, ".certs"));
    await new Promise<void>((r) => http2Server.listen(0, "127.0.0.1", r));
  });

  afterEach(async () => {
    clearStaticRepresentationCache();
    await new Promise<void>((r) => http1Server.close(() => r()));
    await new Promise<void>((r) => http2Server.close(() => r()));
    await rm(dist, { recursive: true, force: true }).catch(() => {});
  });

  it("the streaming bound is a real constant no larger than the cache bound", () => {
    expect(MAX_BUFFERED_ASSET_BYTES).toBeGreaterThan(0);
    expect(MAX_BUFFERED_ASSET_BYTES).toBeLessThanOrEqual(MAX_CACHED_REPRESENTATION_BYTES);
  });

  it("8 concurrent GETs (HTTP/1.1) return byte-exact bodies, a weak ETag, and bounded peak RSS growth", async () => {
    // Eight DISTINCT files: the single-flight owner legitimately dedupes
    // simultaneous requests for one path into one buffer, so identical
    // requests would understate per-request acquisition cost.
    const names = Array.from({ length: 8 }, (_, i) => `big-${i}.bin`);
    await Promise.all(names.map((n) => writeFile(join(dist, n), largeBody)));

    // Warm the path once so lazy module allocation is not attributed to the
    // burst, then take the baseline.
    const warm = await http1Fetch(http1Server, "/big.bin", { headers: { "accept-encoding": "identity" } });
    expect(warm.status).toBe(200);
    forceGc();
    const before = process.memoryUsage().rss;

    const expectedDigest = createHash("sha256").update(largeBody).digest("hex");
    // A compressible Accept-Encoding proves large assets never take the
    // buffer-compress path: they stay on streamed identity.
    const { results, peakRss } = await childBurst(http1Server, names.map((n) => `/${n}`), "br, gzip");
    const growth = peakRss - before;
    // Recorded for the report; the bound is 4x the file size (see header).
    console.log(`[140] peak RSS growth during 8-way burst: ${(growth / 1024 / 1024).toFixed(1)} MiB (${(growth / LARGE).toFixed(2)}x file)`);

    for (const r of results) {
      expect(r.status).toBe(200);
      expect(Number(r.headers["content-length"])).toBe(LARGE);
      expect(r.headers["content-encoding"]).toBeUndefined();
      expect(r.bytes).toBe(LARGE);
      expect(r.sha256).toBe(expectedDigest);
      expect(String(r.headers.etag)).toMatch(/^W\/"[0-9a-z]+-[0-9a-z]+-[0-9a-z]+"$/);
    }
    // Never retained in the representation cache.
    expect(getCompressedCacheEntriesCount()).toBe(0);
    expect(growth).toBeLessThan(4 * LARGE);
  });

  it("HTTP/2 streams the same bytes with the same weak validator", async () => {
    const res = await http2Fetch(http2Server, "/big.bin", { headers: { "accept-encoding": "br" } });
    expect(res.status).toBe(200);
    expect(Number(res.headers["content-length"])).toBe(LARGE);
    expect(res.raw.equals(largeBody)).toBe(true);
    expect(String(res.headers.etag)).toMatch(/^W\//);
    expect(res.headers["content-encoding"]).toBeUndefined();
  });

  it("the weak validator describes the served inode: size, mtime, and ino from the opened handle", async () => {
    const res = await http1Fetch(http1Server, "/big.bin");
    const st = await fsStat(join(dist, "big.bin"));
    const expected = `W/"${st.size.toString(36)}-${Math.trunc(st.mtimeMs).toString(36)}-${st.ino.toString(36)}"`;
    expect(res.headers.etag).toBe(expected);
  });

  it("conditional GET with the weak ETag returns 304 and HEAD carries length without a body", async () => {
    const first = await http1Fetch(http1Server, "/big.bin");
    const etag = String(first.headers.etag);
    const cond = await http1Fetch(http1Server, "/big.bin", { headers: { "if-none-match": etag } });
    expect(cond.status).toBe(304);
    expect(cond.raw.byteLength).toBe(0);
    expect(cond.headers.etag).toBe(etag);

    const head = await http1Fetch(http1Server, "/big.bin", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(Number(head.headers["content-length"])).toBe(LARGE);
    expect(head.raw.byteLength).toBe(0);
    expect(head.headers.etag).toBe(etag);

    // No handle is left open by 304 or HEAD.
    expect(getOpenStreamedAssetHandles()).toBe(0);
  });

  it("closes the file handle when the client aborts mid-stream", async () => {
    const addr = http1Server.address() as net.AddressInfo;
    // Raw socket so we can stop reading and destroy after the first bytes.
    const gotFirstBytes = new Promise<void>((resolve, reject) => {
      const socket = net.connect(addr.port, "127.0.0.1", () => {
        socket.write(`GET /big.bin HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
      });
      socket.once("data", () => {
        // Headers plus the first chunk have arrived; the server has a stream
        // in flight. Tear the connection down.
        socket.destroy();
        resolve();
      });
      socket.on("error", reject);
    });
    await gotFirstBytes;
    await waitFor(() => getOpenStreamedAssetHandles() === 0);
    expect(getOpenStreamedAssetHandles()).toBe(0);
  });

  it("a file exactly at the bound stays on the buffered path with a strong ETag", async () => {
    const exact = makeLargeBody(MAX_BUFFERED_ASSET_BYTES);
    await writeFile(join(dist, "exact.bin"), exact);
    const res = await http1Fetch(http1Server, "/exact.bin");
    expect(res.status).toBe(200);
    expect(res.raw.equals(exact)).toBe(true);
    expect(String(res.headers.etag)).toMatch(/^"[0-9a-f]{64}"$/);
  });
});

describe("Prompt 140 - precompressed sidecars round trip from build to server", () => {
  let dist: string;
  let http1Server: http.Server;
  const cssBody = Buffer.from(".a{color:red}.b{margin:0}\n".repeat(60));

  beforeEach(async () => {
    dist = await mkdtemp(join(tmpdir(), "bascik-precompress-serve-"));
    setDistDir(dist);
    clearStaticRepresentationCache();
    await writeFile(join(dist, "styles.css"), cssBody);
    // Produce the sidecars exactly as `bascik --build` does with
    // `http.precompress: true`: the finalize transaction walks what the build
    // recorded and emits `.br`/`.gz` plus `.bmeta` provenance.
    (BascikConfig as { http: { precompress?: boolean } }).http.precompress = true;
    manifestCollector.clear();
    await manifestCollector.recordFileFromDisk(join(dist, "styles.css"));
    const { emitted } = await emitPrecompressedSidecars();
    expect(emitted.sort()).toEqual(["styles.css.br", "styles.css.br.bmeta", "styles.css.gz", "styles.css.gz.bmeta"]);
    http1Server = makeHttp1Server();
    await new Promise<void>((r) => http1Server.listen(0, "127.0.0.1", r));
  });

  afterEach(async () => {
    (BascikConfig as { http: { precompress?: boolean } }).http.precompress = false;
    manifestCollector.clear();
    clearStaticRepresentationCache();
    await new Promise<void>((r) => http1Server.close(() => r()));
    await rm(dist, { recursive: true, force: true }).catch(() => {});
  });

  it("serves the emitted .br sidecar verbatim with the encoded ETag and no on-the-fly compression", async () => {
    const sidecar = await readFile(join(dist, "styles.css.br"));
    // The codec is captured via `promisify` at module load, so a `zlib` spy
    // cannot observe it; the owner exposes a timing-independent counter.
    const codecRunsBefore = getOnTheFlyCompressionCount();

    const res = await http1Fetch(http1Server, "/styles.css", { headers: { "accept-encoding": "br" } });
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("br");
    expect(res.raw.equals(sidecar)).toBe(true);
    expect(res.headers.etag).toBe(getEncodedEtag(getContentHashEtag(cssBody), "br"));
    expect(Number(res.headers["content-length"])).toBe(sidecar.byteLength);
    expect(zlib.brotliDecompressSync(res.raw).equals(cssBody)).toBe(true);
    expect(getOnTheFlyCompressionCount()).toBe(codecRunsBefore);
  });

  it("falls back to on-the-fly compression when the .bmeta rawHash does not match the current asset", async () => {
    // Corrupt the provenance: the sidecar bytes are still valid Brotli of the
    // current file, but the stamp no longer proves it, so it must be ignored.
    await writeFile(join(dist, "styles.css.br.bmeta"), JSON.stringify({ rawHash: '"deadbeef"' }));
    const sidecar = await readFile(join(dist, "styles.css.br"));
    const codecRunsBefore = getOnTheFlyCompressionCount();

    const res = await http1Fetch(http1Server, "/styles.css", { headers: { "accept-encoding": "br" } });
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("br");
    expect(getOnTheFlyCompressionCount()).toBe(codecRunsBefore + 1);
    // Body is a fresh compression of the current bytes, not the sidecar
    // (compared by decoded content since two Brotli encoders may differ).
    expect(zlib.brotliDecompressSync(res.raw).equals(cssBody)).toBe(true);
    expect(res.headers.etag).toBe(getEncodedEtag(getContentHashEtag(cssBody), "br"));
    // The on-the-fly path is chosen even though the sidecar bytes would have decoded fine.
    expect(zlib.brotliDecompressSync(sidecar).equals(cssBody)).toBe(true);
  });
});
