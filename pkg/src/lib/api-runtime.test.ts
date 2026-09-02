import { describe, it, expect, vi, beforeEach } from "vitest";
import { Readable } from "node:stream";
import { executeApiRoute, createWebRequest } from "./api-runtime.ts";
import { scriptRegistry } from "./script-registry.ts";
import type { BascikRequest } from "./server.ts";

describe("API runtime execution", () => {
  beforeEach(() => {
    scriptRegistry.clear();
    vi.restoreAllMocks();
  });

  it("constructs WHATWG Request excluding HTTP/2 pseudo-headers", () => {
    const rawReq: BascikRequest = {
      method: "POST",
      path: "/api/test?search=1",
      headers: {
        ":method": "POST",
        ":path": "/api/test?search=1",
        ":scheme": "https",
        ":authority": "localhost:8080",
        "content-type": "application/json",
        "x-custom": "hello",
      },
      remoteIp: "127.0.0.1",
    };

    const req = createWebRequest(rawReq, "http://localhost:8080");
    expect(req.method).toBe("POST");
    expect(req.url).toBe("http://localhost:8080/api/test?search=1");
    expect(req.headers.get("content-type")).toBe("application/json");
    expect(req.headers.get("x-custom")).toBe("hello");
    expect(Array.from(req.headers.keys()).some((k) => k.startsWith(":"))).toBe(false);
  });

  it("routes to the exported method handler", async () => {
    const dummyModule = {
      GET: async (req: Request, ctx: { params: Record<string, string>; remoteIp: string }) => {
        return Response.json({ ok: true, method: "GET", remoteIp: ctx.remoteIp });
      },
      POST: async (req: Request, ctx: { params: Record<string, string> }) => {
        const body = await req.json();
        return Response.json({ ok: true, body }, { status: 201 });
      },
    };

    vi.spyOn(scriptRegistry, "load").mockResolvedValue({
      filePath: "/app/src/api/test.ts",
      module: dummyModule,
      version: 0,
    });

    const webReq = new Request("http://localhost:8080/api/test", { method: "GET" });
    const res = await executeApiRoute({
      filePath: "/app/src/api/test.ts",
      request: webReq,
      params: {},
      remoteIp: "192.168.1.5",
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ ok: true, method: "GET", remoteIp: "192.168.1.5" });
  });

  it("returns 405 with Allow header for unexported method", async () => {
    const dummyModule = {
      GET: async () => new Response("ok"),
      POST: async () => new Response("created"),
    };

    vi.spyOn(scriptRegistry, "load").mockResolvedValue({
      filePath: "/app/src/api/test.ts",
      module: dummyModule,
      version: 0,
    });

    const webReq = new Request("http://localhost:8080/api/test", { method: "DELETE" });
    const res = await executeApiRoute({
      filePath: "/app/src/api/test.ts",
      request: webReq,
      params: {},
      remoteIp: "127.0.0.1",
    });

    expect(res.status).toBe(405);
    // GET includes HEAD and OPTIONS
    expect(res.headers.get("allow")).toBe("GET, HEAD, OPTIONS, POST");
  });

  it("derives HEAD from GET when HEAD is not explicitly exported", async () => {
    const dummyModule = {
      GET: async () => new Response("hello world", {
        status: 200,
        headers: { "x-custom-header": "test" },
      }),
    };

    vi.spyOn(scriptRegistry, "load").mockResolvedValue({
      filePath: "/app/src/api/test.ts",
      module: dummyModule,
      version: 0,
    });

    const webReq = new Request("http://localhost:8080/api/test", { method: "HEAD" });
    const res = await executeApiRoute({
      filePath: "/app/src/api/test.ts",
      request: webReq,
      params: {},
      remoteIp: "127.0.0.1",
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-custom-header")).toBe("test");
    expect(res.body).toBeNull();
  });

  it("uses explicit HEAD export if defined", async () => {
    const dummyModule = {
      GET: async () => new Response("get body"),
      HEAD: async () => new Response(null, {
        status: 204,
        headers: { "x-explicit-head": "true" },
      }),
    };

    vi.spyOn(scriptRegistry, "load").mockResolvedValue({
      filePath: "/app/src/api/test.ts",
      module: dummyModule,
      version: 0,
    });

    const webReq = new Request("http://localhost:8080/api/test", { method: "HEAD" });
    const res = await executeApiRoute({
      filePath: "/app/src/api/test.ts",
      request: webReq,
      params: {},
      remoteIp: "127.0.0.1",
    });

    expect(res.status).toBe(204);
    expect(res.headers.get("x-explicit-head")).toBe("true");
  });

  it("auto-responds 204 with Allow and no CORS headers on OPTIONS when not exported", async () => {
    const dummyModule = {
      POST: async () => new Response("ok"),
    };

    vi.spyOn(scriptRegistry, "load").mockResolvedValue({
      filePath: "/app/src/api/test.ts",
      module: dummyModule,
      version: 0,
    });

    const webReq = new Request("http://localhost:8080/api/test", { method: "OPTIONS" });
    const res = await executeApiRoute({
      filePath: "/app/src/api/test.ts",
      request: webReq,
      params: {},
      remoteIp: "127.0.0.1",
    });

    expect(res.status).toBe(204);
    expect(res.headers.get("allow")).toBe("OPTIONS, POST");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("returns 500 when handler returns a non-Response", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => { });
    const dummyModule = {
      GET: async () => ({ not: "a response" } as any),
    };

    vi.spyOn(scriptRegistry, "load").mockResolvedValue({
      filePath: "/app/src/api/test.ts",
      module: dummyModule,
      version: 0,
    });

    const webReq = new Request("http://localhost:8080/api/test", { method: "GET" });
    const res = await executeApiRoute({
      filePath: "/app/src/api/test.ts",
      request: webReq,
      params: {},
      remoteIp: "127.0.0.1",
    });

    expect(res.status).toBe(500);
    expect(consoleError).toHaveBeenCalled();
  });

  it("preserves multiple set-cookie values via Headers.getSetCookie()", async () => {
    const dummyModule = {
      GET: async () => {
        const headers = new Headers();
        headers.append("Set-Cookie", "a=1; Path=/");
        headers.append("Set-Cookie", "b=2; Path=/; HttpOnly");
        return new Response("ok", { headers });
      },
    };

    vi.spyOn(scriptRegistry, "load").mockResolvedValue({
      filePath: "/app/src/api/test.ts",
      module: dummyModule,
      version: 0,
    });

    const webReq = new Request("http://localhost:8080/api/test", { method: "GET" });
    const res = await executeApiRoute({
      filePath: "/app/src/api/test.ts",
      request: webReq,
      params: {},
      remoteIp: "127.0.0.1",
    });

    expect(res.headers.getSetCookie()).toEqual([
      "a=1; Path=/",
      "b=2; Path=/; HttpOnly",
    ]);
  });
});
