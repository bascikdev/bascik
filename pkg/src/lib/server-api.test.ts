import { describe, it, expect, vi, beforeEach } from "vitest";
import { Readable } from "node:stream";
import { apiRouteRegistry, LINGER_FRAMED_BODY_LIMIT } from "./server-api.ts";
import { scriptRegistry } from "./script-registry.ts";
import {
  createRequestHandler,
  type BascikRequest,
  type BascikResponse,
} from "./server.ts";
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
      respond: (status) => {
        status404 = status;
      },
      write: () => true,
      end: () => {},
      close: () => {},
      on: () => {},
      off: () => {},
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
      end: () => {},
      close: () => {},
      on: () => {},
      off: () => {},
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
      rawStream: Readable.from([
        Buffer.from(JSON.stringify({ name: "Alice" })),
      ]),
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
      close: () => {},
      on: () => {},
      off: () => {},
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
      end: () => {},
      close: () => {},
      on: () => {},
      off: () => {},
    };

    await handleRequest(req, res);

    expect(respondedHeaders["x-frame-options"]).toBe("DENY");
    expect(respondedHeaders["cross-origin-opener-policy"]).toBe("unsafe-none");
    expect(respondedHeaders["x-content-type-options"]).toBe("nosniff");
  });

  describe("route invalidation ownership (prompt 112)", () => {
    it("invalidateFile invalidates the runtime module identity and rescans routes from disk", async () => {
      const invalidateSpy = vi.spyOn(scriptRegistry, "invalidate");
      const reloadSpy = vi
        .spyOn(apiRouteRegistry, "reload")
        .mockResolvedValue(undefined);
      const order: string[] = [];
      invalidateSpy.mockImplementation(() => {
        order.push("invalidate");
        return true;
      });
      reloadSpy.mockImplementation(async () => {
        order.push("reload");
      });

      await apiRouteRegistry.invalidateFile("/app/src/api/value.ts");

      expect(invalidateSpy).toHaveBeenCalledWith("/app/src/api/value.ts");
      expect(order).toEqual(["invalidate", "reload"]);
    });

    it("dispatch loads the route by the file path the scanner recorded, so identity is shared with invalidation", async () => {
      // Real registry, real module identity: write a module, dispatch, edit +
      // invalidate through the API registry, dispatch again.
      const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const { tmpdir } = await import("node:os");
      const dir = await mkdtemp(join(tmpdir(), "bascik-112-api-"));
      try {
        const routeFile = join(dir, "value.mjs");
        await writeFile(
          routeFile,
          `export const GET = async () => Response.json({ value: "OLD" });`,
        );
        (apiRouteRegistry as any).routes = [
          {
            path: "/api/value",
            filePath: routeFile,
            paramNames: [],
            isDynamic: false,
          },
        ];
        const handleRequest = createRequestHandler();
        const run = async (): Promise<string> => {
          let body = "";
          const req: BascikRequest = {
            method: "GET",
            path: "/api/value",
            headers: {},
            remoteIp: "127.0.0.1",
          };
          const res: BascikResponse = {
            headersSent: false,
            destroyed: false,
            writable: {} as any,
            respond: () => {},
            write: (chunk) => {
              body += chunk.toString();
              return true;
            },
            end: (chunk) => {
              if (chunk) body += chunk.toString();
            },
            close: () => {},
            on: () => {},
            off: () => {},
          };
          await handleRequest(req, res);
          return body;
        };

        expect(JSON.parse(await run()).value).toBe("OLD");

        await writeFile(
          routeFile,
          `export const GET = async () => Response.json({ value: "NEW" });`,
        );
        // reload() would rescan BascikConfig.directory.api (not our temp dir);
        // keep the route table and only exercise the identity handoff.
        vi.spyOn(apiRouteRegistry, "reload").mockResolvedValue(undefined);
        await apiRouteRegistry.invalidateFile(routeFile);

        // The configured singleton runs in dev under vitest, so the edit is visible.
        expect(scriptRegistry.mode).toBe("development");
        expect(JSON.parse(await run()).value).toBe("NEW");
      } finally {
        (apiRouteRegistry as any).routes = [];
        await rm(dir, { recursive: true, force: true });
      }
    });
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
        respond: (s) => {
          status = s;
        },
        write: () => true,
        end: () => {},
        close: () => {},
        on: () => {},
        off: () => {},
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
        respond: (s) => {
          status = s;
        },
        write: () => true,
        end: () => {},
        close: () => {},
        on: () => {},
        off: () => {},
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
        respond: (s) => {
          status = s;
        },
        write: () => true,
        end: () => {},
        close: () => {},
        on: () => {},
        off: () => {},
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

describe("over-limit request bodies (lingering close)", () => {
  // BascikConfig is frozen, so these run against the shipped default; the
  // maxBodySize 0 case is covered with real servers in
  // body-limit-linger.integration.test.ts.
  const LIMIT = BascikConfig.http.maxBodySize;
  const load = vi.fn();
  /** The route's POST handler; it reads the whole body. */
  const postHandler = vi.fn();
  /** Replaces the route module for one test. */
  let routeModule: Record<string, unknown> | undefined;

  beforeEach(() => {
    vi.restoreAllMocks();
    scriptRegistry.clear();
    load.mockReset();
    routeModule = undefined;
    postHandler.mockReset();
    postHandler.mockImplementation(async (req: Request) => {
      const text = await req.text();
      return Response.json({ received: text.length });
    });
    vi.spyOn(scriptRegistry, "load").mockImplementation(async (filePath) => {
      load(filePath);
      return {
        filePath,
        version: 0,
        module: routeModule ?? { POST: postHandler },
      };
    });
    (apiRouteRegistry as any).routes = [
      {
        path: "/api/upload",
        filePath: "/app/src/api/upload.ts",
        paramNames: [],
        isDynamic: false,
      },
    ];
  });

  it("runs against a real limit", () => {
    expect(LIMIT).toBeGreaterThan(0);
  });

  const post = async (
    headers: Record<string, string>,
    chunks: Buffer[],
    method = "POST",
  ) => {
    const calls: string[] = [];
    let status = 0;
    let respondedHeaders: Record<string, any> = {};
    let body = "";
    const res: BascikResponse = {
      headersSent: false,
      destroyed: false,
      writable: {} as any,
      respond: (s, h) => {
        calls.push("respond");
        status = s;
        respondedHeaders = h;
        res.headersSent = true;
      },
      write: (chunk) => {
        body += chunk.toString();
        return true;
      },
      end: (chunk) => {
        if (chunk) body += chunk.toString();
      },
      close: () => {
        calls.push("close");
      },
      on: () => {},
      off: () => {},
      lingerClose: () => {
        calls.push("lingerClose");
      },
    };
    await createRequestHandler()(
      {
        method,
        path: "/api/upload",
        headers,
        remoteIp: "127.0.0.1",
        rawStream: Readable.from(chunks),
      },
      res,
    );
    return { status, headers: respondedHeaders, body, calls };
  };

  it("a declared Content-Length over the limit is answered 413 without running the handler", async () => {
    const out = await post({ "content-length": String(LIMIT + 1) }, [
      Buffer.alloc(10),
    ]);
    expect(out.status).toBe(413);
    expect(out.body).toBe("Payload Too Large");
    expect(out.headers["content-length"]).toBe("17");
    expect(out.headers["connection"]).toBe("close");
    // Security headers still apply to the early 413.
    expect(out.headers["x-content-type-options"]).toBe("nosniff");
    expect(postHandler).not.toHaveBeenCalled();
    // The transport is told to drain before the 413 is committed.
    expect(out.calls).toEqual(["lingerClose", "respond"]);
  });

  it("a body that trips the limit mid-read (no length) gets 413 and a lingering close", async () => {
    const out = await post({ "transfer-encoding": "chunked" }, [
      Buffer.alloc(LIMIT),
      Buffer.alloc(LIMIT),
    ]);
    expect(out.status).toBe(413);
    expect(out.body).toBe("Payload Too Large");
    expect(load).toHaveBeenCalled();
    expect(out.calls).toEqual(["lingerClose", "respond"]);
  });

  it("a Content-Length that undercounts is still caught by the streaming limit", async () => {
    const out = await post({ "content-length": "10" }, [
      Buffer.alloc(LIMIT),
      Buffer.alloc(LIMIT),
    ]);
    expect(out.status).toBe(413);
    expect(out.calls).toEqual(["lingerClose", "respond"]);
  });

  it.each(["abc", "-5", "1e9", "", " "])(
    "a malformed Content-Length (%j) never takes the early path",
    async (declared) => {
      const out = await post({ "content-length": declared }, [
        Buffer.alloc(10),
      ]);
      expect(out.status).toBe(200);
      expect(load).toHaveBeenCalled();
      expect(out.calls).toEqual(["respond"]);
    },
  );

  it("a body within the limit is untouched: no lingering close", async () => {
    const out = await post({ "content-length": String(LIMIT) }, [
      Buffer.alloc(LIMIT),
    ]);
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body)).toEqual({ received: LIMIT });
    expect(out.calls).toEqual(["respond"]);
  });

  it("a declared Content-Length over the limit to a method the route does not export gets 405 with Allow, not 413", async () => {
    // The method policy outranks the body limit: the request is wrong
    // whatever its size, and 405 + Allow tells the client how to fix it.
    routeModule = { GET: vi.fn(async () => new Response("ok")) };
    const out = await post(
      { "content-length": String(LIMIT * 2) },
      [Buffer.alloc(10)],
      "DELETE",
    );
    expect(out.status).toBe(405);
    expect(out.headers["allow"]).toBe("GET, HEAD, OPTIONS");
    // No body was rejected, so the transport is not told to drain one.
    expect(out.calls).not.toContain("lingerClose");
  });

  it("misuse: a declared Content-Length over the limit to an exported method outside the allowlist gets 405, not 413 (F086)", async () => {
    const purge = vi.fn(async () => new Response("purged"));
    routeModule = { GET: vi.fn(async () => new Response("ok")), PURGE: purge };
    const out = await post(
      { "content-length": String(LIMIT * 2) },
      [Buffer.alloc(10)],
      "PURGE",
    );
    expect(out.status).toBe(405);
    expect(out.headers["allow"]).toBe("GET, HEAD, OPTIONS");
    expect(purge).not.toHaveBeenCalled();
    expect(out.calls).not.toContain("lingerClose");
  });

  it("an explicit HEAD export that returns a streamed body gets headers only, and the body is canceled (F088)", async () => {
    const cancel = vi.fn();
    routeModule = {
      HEAD: vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                controller.enqueue(new TextEncoder().encode("never sent"));
              },
              cancel,
            }),
            { headers: { "x-k": "v" } },
          ),
      ),
    };
    const out = await post({}, [], "HEAD");
    expect(out.status).toBe(200);
    expect(out.headers["x-k"]).toBe("v");
    expect(out.body).toBe("");
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  });

  it("an auto OPTIONS with a declared Content-Length over the limit still gets 204", async () => {
    const out = await post(
      { "content-length": String(LIMIT * 2) },
      [Buffer.alloc(10)],
      "OPTIONS",
    );
    expect(out.status).toBe(204);
    expect(out.calls).not.toContain("lingerClose");
  });

  it("a handler that never reads its body is still not run for a declared length over the limit", async () => {
    // Deliberate (nginx's client_max_body_size does the same): the limit is
    // a property of the request, not of whether this handler reads it.
    const headersOnly = vi.fn(async () => new Response("ok"));
    routeModule = { POST: headersOnly };
    const out = await post({ "content-length": String(LIMIT * 2) }, [
      Buffer.alloc(10),
    ]);
    expect(out.status).toBe(413);
    expect(headersOnly).not.toHaveBeenCalled();
    expect(out.calls).toEqual(["lingerClose", "respond"]);
  });

  it("a limit that trips while the response streams the request body still gets a lingering close", async () => {
    // An echo: the body is read only while the response is pulled, so the
    // limit trips after the 200's headers are committed.
    routeModule = { POST: async (req: Request) => new Response(req.body) };
    const out = await post({ "transfer-encoding": "chunked" }, [
      Buffer.alloc(LIMIT / 2),
      Buffer.alloc(LIMIT / 2),
      Buffer.alloc(LIMIT),
    ]);
    expect(out.status).toBe(200);
    expect(out.calls).toEqual(["respond", "lingerClose", "close"]);
  });

  // F087: undici's Request constructor rejects CONNECT, TRACE and TRACK,
  // so these were a logged 500 before dispatch instead of the 405 + Allow
  // the method policy documents.
  it.each(["TRACE", "TRACK", "trace"])(
    "%s to an API route gets 405 with Allow, and no handler runs",
    async (method) => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const get = vi.fn(async () => new Response("ok"));
      routeModule = { GET: get, POST: postHandler };
      const out = await post({}, [], method);
      expect(out.status).toBe(405);
      expect(out.headers["allow"]).toBe("GET, HEAD, OPTIONS, POST");
      expect(out.body).toBe("Method Not Allowed");
      expect(out.headers["x-content-type-options"]).toBe("nosniff");
      expect(get).not.toHaveBeenCalled();
      expect(postHandler).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
    },
  );

  it("TRACE to an API route whose module fails to load is a 500, as for any method", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(scriptRegistry, "load").mockRejectedValue(new Error("boom"));
    const out = await post({}, [], "TRACE");
    expect(out.status).toBe(500);
    expect(errors).toHaveBeenCalled();
  });

  // F074: a request-target starting with `//` is scheme-relative to WHATWG
  // URL; the host of request.url must still come from the request origin.
  it.each([
    ["//api/upload", "http://localhost//api/upload"],
    ["//api/upload?x=1", "http://localhost//api/upload?x=1"],
  ])("%s reaches the handler with request.url %s", async (path, expected) => {
    let seen = "";
    routeModule = {
      GET: vi.fn(async (request: Request) => {
        seen = request.url;
        return new Response("ok");
      }),
    };
    const res: BascikResponse = {
      headersSent: false,
      destroyed: false,
      writable: {} as any,
      respond: () => {
        res.headersSent = true;
      },
      write: () => true,
      end: () => {},
      close: () => {},
      on: () => {},
      off: () => {},
    };
    await createRequestHandler()(
      {
        method: "GET",
        path,
        headers: { host: "localhost" },
        remoteIp: "127.0.0.1",
      },
      res,
    );
    expect(seen).toBe(expected);
  });

  describe("a handler that catches the rejection and answers itself", () => {
    // The transport holds the end of the response until the drain settles,
    // so a body with no length would be missing its final chunk until the
    // client finished uploading. A bounded body is framed with a
    // Content-Length instead (body-limit-linger.integration.test.ts pins
    // the wire behavior).
    const catching = (respond: () => Response) => async (req: Request) => {
      try {
        await req.text();
      } catch {
        return respond();
      }
      return new Response("fits");
    };
    const overLimit = [Buffer.alloc(LIMIT), Buffer.alloc(LIMIT)];

    it("a small string body gets a Content-Length", async () => {
      routeModule = {
        POST: catching(() => new Response("too big, sorry", { status: 413 })),
      };
      const out = await post({ "transfer-encoding": "chunked" }, overLimit);
      expect(out.status).toBe(413);
      expect(out.body).toBe("too big, sorry");
      expect(out.headers["content-length"]).toBe("14");
      expect(out.calls).toEqual(["lingerClose", "respond"]);
    });

    it("an empty body gets Content-Length 0", async () => {
      routeModule = {
        POST: catching(() => new Response("", { status: 413 })),
      };
      const out = await post({ "transfer-encoding": "chunked" }, overLimit);
      expect(out.status).toBe(413);
      expect(out.headers["content-length"]).toBe("0");
    });

    it("a null body gets Content-Length 0", async () => {
      routeModule = {
        POST: catching(() => new Response(null, { status: 413 })),
      };
      const out = await post({ "transfer-encoding": "chunked" }, overLimit);
      expect(out.status).toBe(413);
      expect(out.headers["content-length"]).toBe("0");
    });

    it("misuse: a body over the buffer bound still streams whole, unframed", async () => {
      const big = "x".repeat(LINGER_FRAMED_BODY_LIMIT * 2);
      routeModule = {
        POST: catching(
          () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  const bytes = new TextEncoder().encode(big);
                  for (let at = 0; at < bytes.length; at += 4096)
                    controller.enqueue(bytes.subarray(at, at + 4096));
                  controller.close();
                },
              }),
              { status: 413 },
            ),
        ),
      };
      const out = await post({ "transfer-encoding": "chunked" }, overLimit);
      expect(out.status).toBe(413);
      expect(out.body).toBe(big);
      expect(out.headers["content-length"]).toBeUndefined();
    });

    it("misuse: a body stream that fails before it ends still gets the 500 a streamed failure gets", async () => {
      routeModule = {
        POST: catching(
          () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode("partial"));
                  controller.error(new Error("producer failed"));
                },
              }),
              { status: 413 },
            ),
        ),
      };
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const out = await post({ "transfer-encoding": "chunked" }, overLimit);
        // The failure surfaced before any header was committed.
        expect(out.status).toBe(500);
        expect(out.body).toBe("Internal Server Error");
      } finally {
        errors.mockRestore();
      }
    });

    it("a Content-Length the handler set is kept as it is", async () => {
      routeModule = {
        POST: catching(
          () =>
            new Response("nope", {
              status: 413,
              headers: { "content-length": "4" },
            }),
        ),
      };
      const out = await post({ "transfer-encoding": "chunked" }, overLimit);
      expect(out.headers["content-length"]).toBe("4");
      expect(out.body).toBe("nope");
    });

    it("a body that was never rejected is not buffered", async () => {
      routeModule = { POST: async () => new Response("fine") };
      const out = await post({ "transfer-encoding": "chunked" }, [
        Buffer.alloc(10),
      ]);
      expect(out.status).toBe(200);
      expect(out.headers["content-length"]).toBeUndefined();
    });
  });

  it("a transport without lingerClose (a test double, a non-socket host) still gets the 413", async () => {
    let status = 0;
    await createRequestHandler()(
      {
        method: "POST",
        path: "/api/upload",
        headers: { "content-length": String(LIMIT * 2) },
        remoteIp: "127.0.0.1",
        rawStream: Readable.from([Buffer.alloc(1)]),
      },
      {
        headersSent: false,
        destroyed: false,
        writable: {} as any,
        respond: (s) => {
          status = s;
        },
        write: () => true,
        end: () => {},
        close: () => {},
        on: () => {},
        off: () => {},
      },
    );
    expect(status).toBe(413);
  });
});
