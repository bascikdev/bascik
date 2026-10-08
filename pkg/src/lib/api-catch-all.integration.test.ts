/**
 * Catch-all API route parity over real HTTP/1.1 and HTTP/2 transports.
 *
 * Runs the real `createRequestHandler` behind `adaptHttp1` / `adaptHttp2` and
 * sends RAW request targets (Node's `http.request` and the HTTP/2 `:path`
 * pseudo-header do not normalize `..` or `%2F`), so the assertions cover what a
 * hostile client can actually put on the wire.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";

const { configState } = vi.hoisted(() => ({
  configState: {
    base: "/",
    http: {
      httpCache: false,
      compression: false,
      rateLimit: false,
      tls: { enabled: false },
      trustProxy: false,
      maxBodySize: 1024,
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
import { scriptRegistry } from "./script-registry.ts";
import { buildApiRouteTree } from "./api-routes.ts";

interface Reply {
  status: number;
  body: string;
  allow?: string;
}

const API = "/app/src/api";
const routeFiles = ["[...path].ts", "users/[...rest].ts", "users/[id].ts", "users/me.ts", "health.ts"].map(
  (f) => `${API}/${f}`,
);

describe("catch-all API routes over HTTP/1.1 and HTTP/2", () => {
  let h1: http.Server;
  let h2: http2.Http2Server;
  let h1Port: number;
  let h2Port: number;
  const originalRoutes = (apiRouteRegistry as any).routes;

  beforeAll(async () => {
    // Registered in a deliberately unhelpful order; the table is sorted by the builder.
    (apiRouteRegistry as any).routes = buildApiRouteTree([...routeFiles].reverse(), API);

    vi.spyOn(scriptRegistry, "load").mockImplementation(async (filePath: string) => ({
      filePath,
      version: 0,
      module: {
        GET: async (_req: Request, ctx: { params: Record<string, unknown> }) =>
          Response.json({ file: filePath.replace(`${API}/`, ""), params: ctx.params }),
        POST: async (_req: Request, ctx: { params: Record<string, unknown> }) =>
          Response.json({ posted: ctx.params }),
      },
    }));

    const handle = createRequestHandler();

    h1 = http.createServer((reqMsg, resMsg) => {
      const { req, res } = adaptHttp1(reqMsg, resMsg);
      handle(req, res).catch(() => {
        try {
          res.respond(500, { "content-type": "text/plain" });
          res.end("Internal Server Error");
        } catch {}
      });
    });
    await new Promise<void>((r) => h1.listen(0, "127.0.0.1", r));
    h1Port = (h1.address() as AddressInfo).port;

    h2 = http2.createServer();
    h2.on("stream", (stream, headers) => {
      const { req, res } = adaptHttp2(stream, headers);
      handle(req, res).catch(() => {
        try {
          res.respond(500, { "content-type": "text/plain" });
          res.end("Internal Server Error");
        } catch {}
      });
    });
    await new Promise<void>((r) => h2.listen(0, "127.0.0.1", r));
    h2Port = (h2.address() as AddressInfo).port;
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    (apiRouteRegistry as any).routes = originalRoutes;
    await new Promise<void>((r) => h1.close(() => r()));
    await new Promise<void>((r) => h2.close(() => r()));
  });

  const viaHttp1 = (path: string, method = "GET"): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: h1Port, path, method, agent: false }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            allow: res.headers.allow as string | undefined,
          }),
        );
      });
      req.on("error", reject);
      req.end();
    });

  const viaHttp2 = (path: string, method = "GET"): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const client = http2.connect(`http://127.0.0.1:${h2Port}`);
      client.on("error", reject);
      const req = client.request({ ":method": method, ":path": path });
      let status = 0;
      let allow: string | undefined;
      const chunks: Buffer[] = [];
      req.on("response", (headers) => {
        status = Number(headers[":status"]);
        allow = headers.allow as string | undefined;
      });
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        client.close();
        resolve({ status, body: Buffer.concat(chunks).toString("utf8"), allow });
      });
      req.on("error", reject);
      req.end();
    });

  const transports: Array<[string, (p: string, m?: string) => Promise<Reply>]> = [
    ["HTTP/1.1", (p, m) => viaHttp1(p, m)],
    ["HTTP/2", (p, m) => viaHttp2(p, m)],
  ];

  describe.each(transports)("%s", (_name, send) => {
    it("captures one and many remaining segments as string[]", async () => {
      const one = await send("/api/anything");
      expect(one.status).toBe(200);
      expect(JSON.parse(one.body)).toEqual({ file: "[...path].ts", params: { path: ["anything"] } });

      const many = await send("/api/a/b/c?x=1");
      expect(JSON.parse(many.body).params).toEqual({ path: ["a", "b", "c"] });
    });

    it("does not match with zero remaining segments", async () => {
      // Falls through to normal page handling, never to the API handler.
      const res = await send("/api");
      expect(res.body).not.toContain('"params"');
    });

    it("static beats [param] beats catch-all", async () => {
      expect(JSON.parse((await send("/api/health")).body).file).toBe("health.ts");
      expect(JSON.parse((await send("/api/users/me")).body).file).toBe("users/me.ts");
      expect(JSON.parse((await send("/api/users/9")).body).file).toBe("users/[id].ts");
      expect(JSON.parse((await send("/api/users/9/x")).body)).toEqual({
        file: "users/[...rest].ts",
        params: { rest: ["9", "x"] },
      });
    });

    it("decodes each segment exactly once", async () => {
      const res = await send("/api/hello%20world/caf%C3%A9/%2541");
      expect(JSON.parse(res.body).params).toEqual({ path: ["hello world", "café", "%41"] });
    });

    it.each([
      "/api/a%2Fb",
      "/api/a%2fb",
      "/api/a%5Cb",
      "/api/a/%2e%2e/b",
      "/api/a%00b",
      "/api/a%0Ab",
      "/api/%E0%A4%A",
      "/api/a//b",
    ])("rejects %s with 400 and never runs the handler", async (path) => {
      const res = await send(path);
      expect(res.status).toBe(400);
      expect(res.body).not.toContain("params");
    });

    it("literal dot-dot segments are rejected before routing", async () => {
      expect((await send("/api/a/../b")).status).toBe(400);
    });

    it("hidden segments are 404 and never reach the catch-all", async () => {
      // An encoded single dot decodes to a hidden segment and is stopped by the existing guard.
      expect((await send("/api/a/%2e/b")).status).toBe(404);
      expect((await send("/api/a/.env")).status).toBe(404);
      expect((await send("/api/.git/config")).status).toBe(404);
    });

    it("supported methods dispatch, unsupported return 405 with Allow, HEAD/OPTIONS keep their behavior", async () => {
      const post = await send("/api/a/b", "POST");
      expect(JSON.parse(post.body)).toEqual({ posted: { path: ["a", "b"] } });

      const put = await send("/api/a/b", "PUT");
      expect(put.status).toBe(405);
      expect(put.allow).toBe("GET, HEAD, OPTIONS, POST");

      const head = await send("/api/a/b", "HEAD");
      expect(head.status).toBe(200);
      expect(head.body).toBe("");

      const options = await send("/api/a/b", "OPTIONS");
      expect(options.status).toBe(204);
      expect(options.allow).toBe("GET, HEAD, OPTIONS, POST");
    });
  });

  it("HTTP/1.1 and HTTP/2 return identical status and body for every probe", async () => {
    const probes = [
      "/api/a/b/c",
      "/api/users/me",
      "/api/users/9/x",
      "/api/a%2Fb",
      "/api/%E0%A4%A",
      "/api/hello%20world",
      "/api",
    ];
    for (const probe of probes) {
      const [a, b] = await Promise.all([viaHttp1(probe), viaHttp2(probe)]);
      expect({ probe, status: b.status, body: b.body }).toEqual({ probe, status: a.status, body: a.body });
    }
  });
});
