/**
 * Prompt 65: `data-bascik-stream`, chunked server-script responses.
 *
 * Drives the real request handler with the real server-scripts module and a
 * mocked ScriptRegistry.invoke so each script job is a deferred the test
 * controls. Records every respond/write/end call on a fake BascikResponse.
 *
 *  - step 1: a `stream` script flushes headers + static prefix before it
 *    resolves; the concatenated writes equal the fully resolved document.
 *  - step 2: a `server`-only page is byte-identical to today (content-length,
 *    no write calls) under every onServerScriptError value.
 *  - step 2a: mixed page ordering; `server` failure => 500 before commit;
 *    `stream` failure => 200, empty slot, document completes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock, configState } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  configState: {
    base: "/",
    http: { httpCache: false, tls: { enabled: false }, rateLimit: false, hostname: "localhost" },
    scripts: { timeout: 30000, onServerScriptError: "error" as "error" | "warn" | "ignore" },
    logging: { level: "silent", requests: false },
    isProdServer: true,
    isBuild: false,
    directory: { pages: "src/pages", components: ["src/components"], out: "dist" },
  },
}));

vi.mock("./config.js", () => ({ BascikConfig: configState, shouldLog: () => false }));
vi.mock("./script-registry.js", () => ({
  scriptRegistry: { invoke: invokeMock, clear: vi.fn() },
}));
vi.mock("./mem.js", () => ({
  mem: {
    getPage: vi.fn(),
    getPageExact: vi.fn(() => undefined),
    trackOpenPage: vi.fn(),
    untrackOpenPage: vi.fn(),
    isBooting: false,
    setBootingDone: vi.fn(),
  },
}));
vi.mock("./events.js", () => ({
  eventEmitter: { on: vi.fn(), removeListener: vi.fn() },
  runShutdownHandlers: vi.fn(),
  registerShutdownHandler: vi.fn(),
}));

import { createRequestHandler, resetActiveRateLimiter } from "./server.ts";
import { mem } from "./mem.ts";
import { serverSidecarRegistry } from "./server-sidecar.ts";
import { htmlHasServerScripts } from "./server-scripts.ts";

type Deferred = { promise: Promise<{ ok: true; value: string }>; resolve: (v: string) => void; reject: (e: Error) => void };
const deferred = (): Deferred => {
  let resolve!: (v: string) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<{ ok: true; value: string }>((res, rej) => {
    resolve = (v) => res({ ok: true, value: v });
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** Route each invoke() to a deferred by the marker found in its data: URI source. */
const routeInvokes = (routes: Record<string, Deferred | { fail: Error }>) => {
  invokeMock.mockImplementation(async (specifier: string) => {
    const src = decodeURIComponent(String(specifier));
    for (const [marker, target] of Object.entries(routes)) {
      if (src.includes(marker)) {
        if ("fail" in target) return { ok: false, error: target.fail, isNetworkReset: false };
        return target.promise;
      }
    }
    throw new Error(`no route for invoke: ${src.slice(0, 80)}`);
  });
};

type Call = ["respond", number, Record<string, string | number>] | ["write", Buffer] | ["end", Buffer | undefined];
const makeRes = () => {
  const calls: Call[] = [];
  const res = {
    headersSent: false,
    destroyed: false,
    writable: {} as NodeJS.WritableStream,
    respond: vi.fn((status: number, headers: Record<string, string | number>) => {
      res.headersSent = true;
      calls.push(["respond", status, headers]);
    }),
    write: vi.fn((chunk: string | Buffer) => {
      calls.push(["write", Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      return true;
    }),
    end: vi.fn((chunk?: string | Buffer) => {
      calls.push(["end", chunk === undefined ? undefined : Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    }),
    close: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  };
  return { res, calls };
};

const makePage = (content: string) => ({
  relativePagePath: "pages/x.html",
  absolutePagePath: "/abs/src/pages/x.html",
  content: Buffer.from(content),
  compressedContent: undefined,
  hasServerScripts: htmlHasServerScripts(content),
  usedComponentsSet: new Set<string>(),
});

const serve = async (content: string, method = "GET") => {
  (mem.getPage as ReturnType<typeof vi.fn>).mockReturnValue(makePage(content));
  const handler = createRequestHandler();
  const { res, calls } = makeRes();
  const done = handler(
    { method, path: "/x", headers: {}, remoteIp: "127.0.0.1" },
    res as any,
  );
  return { res, calls, done };
};

const body = (calls: Call[]): string =>
  Buffer.concat(calls.flatMap((c) => (c[0] === "write" ? [c[1]] : c[0] === "end" && c[1] ? [c[1]] : []))).toString();
const respondCall = (calls: Call[]) => calls.find((c) => c[0] === "respond") as ["respond", number, Record<string, string | number>] | undefined;
const tick = () => new Promise<void>((r) => setImmediate(r));

beforeEach(() => {
  invokeMock.mockReset();
  serverSidecarRegistry.clear();
  resetActiveRateLimiter();
  configState.scripts.onServerScriptError = "error";
});

const STREAM_PAGE =
  `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><p>before</p>` +
  `<script data-bascik-stream>export default async () => { /*T*/ return ''; }</script><p>after</p></body></html>`;

describe("step 1: a data-bascik-stream script flushes the prefix before it resolves", () => {
  it("commits headers without content-length and writes the static prefix while the job is pending", async () => {
    const t = deferred();
    routeInvokes({ "/*T*/": t });
    const { res, calls, done } = await serve(STREAM_PAGE);
    await tick();

    const r = respondCall(calls);
    expect(r).toBeDefined();
    expect(r![1]).toBe(200);
    expect(r![2]).not.toHaveProperty("content-length");
    expect(r![2]).not.toHaveProperty("etag");
    expect(r![2]).not.toHaveProperty("content-encoding");
    expect(r![2]["cache-control"]).toBe("private, no-store");

    const firstWrite = calls.find((c) => c[0] === "write") as ["write", Buffer] | undefined;
    expect(firstWrite).toBeDefined();
    expect(firstWrite![1].toString()).toContain("<p>before</p>");
    expect(firstWrite![1].toString()).not.toContain("<p>slow</p>");
    expect(res.end).not.toHaveBeenCalled();

    t.resolve("<p>slow</p>");
    await done;
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(body(calls)).toBe(
      `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><p>before</p><p>slow</p><p>after</p></body></html>`,
    );
  });
});

describe("step 2: data-bascik-server pages are byte-identical to today", () => {
  const SERVER_PAGE = STREAM_PAGE.replace("data-bascik-stream", "data-bascik-server");
  for (const policy of ["error", "warn", "ignore"] as const) {
    it(`buffers with content-length and never calls write (onServerScriptError=${policy})`, async () => {
      configState.scripts.onServerScriptError = policy;
      const t = deferred();
      routeInvokes({ "/*T*/": t });
      const { res, calls, done } = await serve(SERVER_PAGE);
      await tick();
      expect(respondCall(calls)).toBeUndefined();
      t.resolve("<p>slow</p>");
      await done;
      expect(res.write).not.toHaveBeenCalled();
      const expected = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><p>before</p><p>slow</p><p>after</p></body></html>`;
      const r = respondCall(calls)!;
      expect(r[2]["content-length"]).toBe(Buffer.byteLength(expected));
      expect(body(calls)).toBe(expected);
    });
  }
});

describe("step 2a: mixed page ordering and failure semantics", () => {
  const MIXED =
    `<p>a</p><script data-bascik-server>export default async () => { /*S*/ return ''; }</script>` +
    `<p>b</p><script data-bascik-stream>export default async () => { /*T*/ return ''; }</script><p>c</p>`;

  it("does not commit until every server job resolves, then flushes through the first stream tag", async () => {
    const s = deferred();
    const t = deferred();
    routeInvokes({ "/*S*/": s, "/*T*/": t });
    const { res, calls, done } = await serve(MIXED);
    await tick();
    expect(respondCall(calls)).toBeUndefined();

    s.resolve("<i>S</i>");
    await tick();
    await tick();
    expect(respondCall(calls)).toBeDefined();
    // Everything up to the first stream tag is on the wire while T is pending.
    expect(body(calls)).toBe("<p>a</p><i>S</i><p>b</p>");
    expect(res.end).not.toHaveBeenCalled();

    t.resolve("<i>T</i>");
    await done;
    expect(body(calls)).toBe("<p>a</p><i>S</i><p>b</p><i>T</i><p>c</p>");
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it("a server failure under 'error' is a 500 with no page bytes", async () => {
    const t = deferred();
    routeInvokes({ "/*S*/": { fail: new Error("boom") }, "/*T*/": t });
    const { calls, done } = await serve(MIXED);
    await done;
    const r = respondCall(calls)!;
    expect(r[1]).toBe(500);
    expect(body(calls)).not.toContain("<p>a</p>");
  });

  it("a stream failure under 'error' stays 200, empties the slot, logs, and completes the document", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
    try {
      const s = deferred();
      routeInvokes({ "/*S*/": s, "/*T*/": { fail: new Error("stream boom") } });
      const { res, calls, done } = await serve(MIXED);
      s.resolve("<i>S</i>");
      await done;
      expect(respondCall(calls)![1]).toBe(200);
      expect(body(calls)).toBe("<p>a</p><i>S</i><p>b</p><p>c</p>");
      expect(res.end).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalled();
      expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("stream boom"))).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("HEAD never enters the streaming path: content-length present, no body", async () => {
    const s = deferred();
    const t = deferred();
    routeInvokes({ "/*S*/": s, "/*T*/": t });
    const { res, calls, done } = await serve(MIXED, "HEAD");
    s.resolve("<i>S</i>");
    t.resolve("<i>T</i>");
    await done;
    expect(res.write).not.toHaveBeenCalled();
    expect(respondCall(calls)![2]).toHaveProperty("content-length");
    expect(body(calls)).toBe("");
  });
});
