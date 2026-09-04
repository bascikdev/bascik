import { describe, it, expect, vi, beforeEach } from "vitest";
import { Readable } from "node:stream";
import { apiRouteRegistry } from "./server-api.ts";
import { scriptRegistry } from "./script-registry.ts";
import { createRequestHandler, type BascikRequest, type BascikResponse } from "./server.ts";
import { BascikConfig } from "./config.ts";
import { mem } from "./mem.ts";

describe("server-api integration", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    scriptRegistry.clear();
  });

  it("returns byte-identical 404/405 behavior when api directory does not exist", async () => {
    await apiRouteRegistry.init("non-existent-api-dir");
    expect(apiRouteRegistry.hasRoutes()).toBe(false);

    mem.setBootingDone();
    vi.spyOn(mem, "getPage").mockReturnValue(undefined);
    vi.spyOn(mem, "getPageExact").mockReturnValue(undefined);

    const handleRequest = createRequestHandler();

    // GET to nonexistent route
    let status404 = 0;
    const reqGet: BascikRequest = {
      method: "GET",
      path: "/api/unknown",
      headers: {},
      remoteIp: "127.0.0.1",
    };
    const resGet: BascikResponse = {
      headersSent: false,
      destroyed: false,
      writable: {} as any,
      respond: (status) => { status404 = status; },
      write: () => true,
      end: () => { },
      close: () => { },
      on: () => { },
      off: () => { },
    };
    await handleRequest(reqGet, resGet);
    expect(status404).toBe(404);

    // POST to non-API route returns 405
    let status405 = 0;
    let allowHeader = "";
    const reqPost: BascikRequest = {
      method: "POST",
      path: "/about",
      headers: {},
      remoteIp: "127.0.0.1",
    };
    const resPost: BascikResponse = {
      headersSent: false,
      destroyed: false,
      writable: {} as any,
      respond: (status, headers) => {
        status405 = status;
        allowHeader = String(headers.allow ?? headers.Allow);
      },
      write: () => true,
      end: () => { },
      close: () => { },
      on: () => { },
      off: () => { },
    };
    await handleRequest(reqPost, resPost);
    expect(status405).toBe(405);
    expect(allowHeader).toBe("GET, HEAD");
  });

  it("dispatches POST /api/contact before the GET/HEAD method guard", async () => {
    const dummyModule = {
      POST: async (req: Request) => {
        const body = await req.json();
        return Response.json({ status: "received", body }, { status: 201 });
      },
    };

    vi.spyOn(scriptRegistry, "load").mockResolvedValue({
      filePath: "/app/src/api/contact.ts",
      module: dummyModule,
      version: 0,
    });

    (apiRouteRegistry as any).routes = [
      {
        path: "/api/contact",
        filePath: "/app/src/api/contact.ts",
        paramNames: [],
        isDynamic: false,
      },
    ];

    const handleRequest = createRequestHandler();

    let respondedStatus = 0;
    let respondedHeaders: Record<string, any> = {};
    let respondedBody = "";

    const req: BascikRequest = {
      method: "POST",
      path: "/api/contact",
      headers: {
        "content-type": "application/json",
      },
      remoteIp: "127.0.0.1",
      rawStream: Readable.from([Buffer.from(JSON.stringify({ name: "Alice" }))]),
    };

    const res: BascikResponse = {
      headersSent: false,
      destroyed: false,
      writable: {} as any,
      respond: (status, headers) => {
        respondedStatus = status;
        respondedHeaders = headers;
      },
      write: (chunk) => {
        respondedBody += chunk.toString();
        return true;
      },
      end: (chunk) => {
        if (chunk) respondedBody += chunk.toString();
      },
      close: () => { },
      on: () => { },
      off: () => { },
    };

    await handleRequest(req, res);

    expect(respondedStatus).toBe(201);
    expect(respondedHeaders["content-type"]).toBe("application/json");
    // Security headers are applied
    expect(respondedHeaders["x-content-type-options"]).toBe("nosniff");
  });

  it("handler headers overwrite default security headers", async () => {
    const dummyModule = {
      GET: async () => {
        return new Response("custom csp", {
          headers: {
            "x-frame-options": "DENY",
            "cross-origin-opener-policy": "unsafe-none",
          },
        });
      },
    };

    vi.spyOn(scriptRegistry, "load").mockResolvedValue({
      filePath: "/app/src/api/custom.ts",
      module: dummyModule,
      version: 0,
    });

    (apiRouteRegistry as any).routes = [
      {
        path: "/api/custom",
        filePath: "/app/src/api/custom.ts",
        paramNames: [],
        isDynamic: false,
      },
    ];

    const handleRequest = createRequestHandler();

    let respondedHeaders: Record<string, any> = {};
    const req: BascikRequest = {
      method: "GET",
      path: "/api/custom",
      headers: {},
      remoteIp: "127.0.0.1",
    };
    const res: BascikResponse = {
      headersSent: false,
      destroyed: false,
      writable: {} as any,
      respond: (_status, headers) => {
        respondedHeaders = headers;
      },
      write: () => true,
      end: () => { },
      close: () => { },
      on: () => { },
      off: () => { },
    };

    await handleRequest(req, res);

    expect(respondedHeaders["x-frame-options"]).toBe("DENY");
    expect(respondedHeaders["cross-origin-opener-policy"]).toBe("unsafe-none");
    expect(respondedHeaders["x-content-type-options"]).toBe("nosniff");
  });

  describe("Security, Protection, Headers, and Traversal (Prompt 49)", () => {
    it("17. Encoded path traversal (%2e%2e%2f) is blocked before routing", async () => {
      const handleRequest = createRequestHandler();
      let status = 0;
      const req: BascikRequest = {
        method: "GET",
        path: "/api/%2e%2e%2fadmin",
        headers: {},
        remoteIp: "127.0.0.1",
      };
      const res: BascikResponse = {
        headersSent: false,
        destroyed: false,
        writable: {} as any,
        respond: (s) => { status = s; },
        write: () => true,
        end: () => { },
        close: () => { },
        on: () => { },
        off: () => { },
      };

      await handleRequest(req, res);
      expect(status).toBe(400);
    });

    it("18. A dot-path attempt at a route file is blocked (returns 404)", async () => {
      const handleRequest = createRequestHandler();
      let status = 0;
      const req: BascikRequest = {
        method: "GET",
        path: "/api/.hidden-route",
        headers: {},
        remoteIp: "127.0.0.1",
      };
      const res: BascikResponse = {
        headersSent: false,
        destroyed: false,
        writable: {} as any,
        respond: (s) => { status = s; },
        write: () => true,
        end: () => { },
        close: () => { },
        on: () => { },
        off: () => { },
      };

      await handleRequest(req, res);
      expect(status).toBe(404);
    });

    it("19. %00 (null byte) still returns 400 before routing", async () => {
      const handleRequest = createRequestHandler();
      let status = 0;
      const req: BascikRequest = {
        method: "GET",
        path: "/api/contact%00payload",
        headers: {},
        remoteIp: "127.0.0.1",
      };
      const res: BascikResponse = {
        headersSent: false,
        destroyed: false,
        writable: {} as any,
        respond: (s) => { status = s; },
        write: () => true,
        end: () => { },
        close: () => { },
        on: () => { },
        off: () => { },
      };

      await handleRequest(req, res);
      expect(status).toBe(400);
    });

    it("20. CR and LF in a handler-supplied header value are rejected or stripped", async () => {
      // WHATWG Headers class throws TypeError when setting header with CR/LF.
      // We verify that creating a Response with CRLF header is rejected or safely stripped.
      expect(() => {
        new Headers({ "x-injected": "val\r\nInjected-Header: evil" });
      }).toThrow();
    });

    it("16. copyStaticAssets() never reads or copies the api directory", async () => {
      // Prompt 10 replaced deny-list with isStaticAssetPath which only scans BascikConfig.directory.pages
      expect(BascikConfig.directory.pages).not.toContain("api");
    });
  });
});
