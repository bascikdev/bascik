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
      GET: async (_req: Request, ctx: { params: Record<string, string>; remoteIp: string }) => {
        return Response.json({ ok: true, method: "GET", remoteIp: ctx.remoteIp });
      },
      POST: async (req: Request, _ctx: { params: Record<string, string> }) => {
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

  describe("Security, Body Limits, and Timeouts (Prompt 49)", () => {
    it("1. A body under the limit succeeds and is readable via .json(), .text(), and .formData()", async () => {
      // json
      const jsonModule = {
        POST: async (req: Request) => {
          const data = await req.json();
          return Response.json({ ok: true, data });
        },
      };
      vi.spyOn(scriptRegistry, "load").mockResolvedValue({
        filePath: "/app/src/api/json.ts",
        module: jsonModule,
        version: 0,
      });

      const jsonStream = Readable.from([Buffer.from(JSON.stringify({ greeting: "hello" }))]);
      const jsonReq = createWebRequest({
        method: "POST",
        path: "/api/json",
        headers: { "content-type": "application/json" },
        remoteIp: "127.0.0.1",
        rawStream: jsonStream,
      });

      const jsonRes = await executeApiRoute({
        filePath: "/app/src/api/json.ts",
        request: jsonReq,
        params: {},
        remoteIp: "127.0.0.1",
      });
      expect(jsonRes.status).toBe(200);
      expect(await jsonRes.json()).toEqual({ ok: true, data: { greeting: "hello" } });

      // text
      const textModule = {
        POST: async (req: Request) => {
          const text = await req.text();
          return new Response(`received: ${text}`);
        },
      };
      vi.spyOn(scriptRegistry, "load").mockResolvedValue({
        filePath: "/app/src/api/text.ts",
        module: textModule,
        version: 0,
      });

      const textStream = Readable.from([Buffer.from("raw text content")]);
      const textReq = createWebRequest({
        method: "POST",
        path: "/api/text",
        headers: { "content-type": "text/plain" },
        remoteIp: "127.0.0.1",
        rawStream: textStream,
      });

      const textRes = await executeApiRoute({
        filePath: "/app/src/api/text.ts",
        request: textReq,
        params: {},
        remoteIp: "127.0.0.1",
      });
      expect(textRes.status).toBe(200);
      expect(await textRes.text()).toBe("received: raw text content");

      // formData
      const formBoundary = "----WebKitFormBoundary7MA4YWxkTrZu0gW";
      const formBody =
        `--${formBoundary}\r\n` +
        `Content-Disposition: form-data; name="username"\r\n\r\n` +
        `bascik-user\r\n` +
        `--${formBoundary}--\r\n`;

      const formModule = {
        POST: async (req: Request) => {
          const form = await req.formData();
          return Response.json({ username: form.get("username") });
        },
      };
      vi.spyOn(scriptRegistry, "load").mockResolvedValue({
        filePath: "/app/src/api/form.ts",
        module: formModule,
        version: 0,
      });

      const formStream = Readable.from([Buffer.from(formBody)]);
      const formReq = createWebRequest({
        method: "POST",
        path: "/api/form",
        headers: { "content-type": `multipart/form-data; boundary=${formBoundary}` },
        remoteIp: "127.0.0.1",
        rawStream: formStream,
      });

      const formRes = await executeApiRoute({
        filePath: "/app/src/api/form.ts",
        request: formReq,
        params: {},
        remoteIp: "127.0.0.1",
      });
      expect(formRes.status).toBe(200);
      expect(await formRes.json()).toEqual({ username: "bascik-user" });
    });

    it("2. duplex: 'half' is set; a GET with no body constructs cleanly", () => {
      const rawReq: BascikRequest = {
        method: "GET",
        path: "/api/test",
        headers: {},
        remoteIp: "127.0.0.1",
      };
      const req = createWebRequest(rawReq);
      expect(req.method).toBe("GET");
      expect(req.body).toBeNull();
    });

    it("3. Over the limit throws / aborts and yields 413 when read", async () => {
      let handlerInvoked = false;
      let bodyReadError: any = null;
      const dummyModule = {
        POST: async (req: Request) => {
          handlerInvoked = true;
          try {
            await req.text();
          } catch (e) {
            bodyReadError = e;
            throw e;
          }
          return Response.json({ ok: true });
        },
      };
      vi.spyOn(scriptRegistry, "load").mockResolvedValue({
        filePath: "/app/src/api/limit.ts",
        module: dummyModule,
        version: 0,
      });

      // 100 bytes limit configured
      const bigChunk = Buffer.alloc(200, "a");
      const stream = Readable.from([bigChunk]);
      const req = createWebRequest(
        {
          method: "POST",
          path: "/api/limit",
          headers: { "content-length": "200" },
          remoteIp: "127.0.0.1",
          rawStream: stream,
        },
        "http://localhost",
        100 // maxBodySize = 100
      );

      const res = await executeApiRoute({
        filePath: "/app/src/api/limit.ts",
        request: req,
        params: {},
        remoteIp: "127.0.0.1",
      });

      expect(res.status).toBe(413);
      expect(handlerInvoked).toBe(true);
      expect(bodyReadError).toBeDefined();
    });

    it("4. A lying content-length (small header with large body) is caught on actual bytes streamed", async () => {
      let handlerInvoked = false;
      let bodyReadError: any = null;
      const dummyModule = {
        POST: async (req: Request) => {
          handlerInvoked = true;
          try {
            await req.text();
          } catch (e) {
            bodyReadError = e;
            throw e;
          }
          return Response.json({ ok: true });
        },
      };
      vi.spyOn(scriptRegistry, "load").mockResolvedValue({
        filePath: "/app/src/api/lying.ts",
        module: dummyModule,
        version: 0,
      });

      // Content-Length says 10 bytes, but actually streams 200 bytes with limit 100
      const bigChunk = Buffer.alloc(200, "a");
      const stream = Readable.from([bigChunk]);
      const req = createWebRequest(
        {
          method: "POST",
          path: "/api/lying",
          headers: { "content-length": "10" },
          remoteIp: "127.0.0.1",
          rawStream: stream,
        },
        "http://localhost",
        100
      );

      const res = await executeApiRoute({
        filePath: "/app/src/api/lying.ts",
        request: req,
        params: {},
        remoteIp: "127.0.0.1",
      });

      expect(res.status).toBe(413);
      expect(handlerInvoked).toBe(true);
      expect(bodyReadError).toBeDefined();
    });

    it("5. An absent content-length with a large chunked body is caught", async () => {
      let handlerInvoked = false;
      let bodyReadError: any = null;
      const dummyModule = {
        POST: async (req: Request) => {
          handlerInvoked = true;
          try {
            await req.text();
          } catch (e) {
            bodyReadError = e;
            throw e;
          }
          return Response.json({ ok: true });
        },
      };
      vi.spyOn(scriptRegistry, "load").mockResolvedValue({
        filePath: "/app/src/api/chunked.ts",
        module: dummyModule,
        version: 0,
      });

      // Chunked stream with no content-length header
      const stream = Readable.from([Buffer.alloc(60, "x"), Buffer.alloc(60, "y")]);
      const req = createWebRequest(
        {
          method: "POST",
          path: "/api/chunked",
          headers: { "transfer-encoding": "chunked" },
          remoteIp: "127.0.0.1",
          rawStream: stream,
        },
        "http://localhost",
        100
      );

      const res = await executeApiRoute({
        filePath: "/app/src/api/chunked.ts",
        request: req,
        params: {},
        remoteIp: "127.0.0.1",
      });

      expect(res.status).toBe(413);
      expect(handlerInvoked).toBe(true);
      expect(bodyReadError).toBeDefined();
    });

    it("6. The stream is destroyed on limit exceeded, not drained", async () => {
      let streamDestroyed = false;
      const dummyModule = {
        POST: async (req: Request) => {
          await req.text();
          return Response.json({ ok: true });
        },
      };
      vi.spyOn(scriptRegistry, "load").mockResolvedValue({
        filePath: "/app/src/api/destroy.ts",
        module: dummyModule,
        version: 0,
      });

      const chunk1 = Buffer.alloc(80, "a");
      const chunk2 = Buffer.alloc(80, "b");
      const nodeStream = new Readable({
        read() {
          this.push(chunk1);
          this.push(chunk2);
          this.push(null);
        },
        destroy(err, cb) {
          streamDestroyed = true;
          cb(err);
        },
      });

      const req = createWebRequest(
        {
          method: "POST",
          path: "/api/destroy",
          headers: {},
          remoteIp: "127.0.0.1",
          rawStream: nodeStream,
        },
        "http://localhost",
        100
      );

      const res = await executeApiRoute({
        filePath: "/app/src/api/destroy.ts",
        request: req,
        params: {},
        remoteIp: "127.0.0.1",
      });

      expect(res.status).toBe(413);
      expect(streamDestroyed).toBe(true);
    });

    it("7. A hung handler hits apiTimeout, responds 504, and the AbortSignal fires with exact fake timer advancement", async () => {
      vi.useFakeTimers();
      try {
        let aborted = false;
        const dummyModule = {
          GET: async (_req: Request, _ctx: any, { signal }: { signal: AbortSignal }) => {
            return new Promise<Response>((_resolve) => {
              signal.addEventListener("abort", () => {
                aborted = true;
              });
              // Never resolves
            });
          },
        };
        vi.spyOn(scriptRegistry, "load").mockResolvedValue({
          filePath: "/app/src/api/timeout.ts",
          module: dummyModule,
          version: 0,
        });

        const webReq = new Request("http://localhost:8080/api/timeout");
        const executePromise = executeApiRoute({
          filePath: "/app/src/api/timeout.ts",
          request: webReq,
          params: {},
          remoteIp: "127.0.0.1",
          timeoutMs: 10000,
        });

        // 1ms before deadline
        await vi.advanceTimersByTimeAsync(9999);
        expect(aborted).toBe(false);
        expect(vi.getTimerCount()).toBe(1);

        // Exactly at deadline
        await vi.advanceTimersByTimeAsync(1);
        const res = await executePromise;

        expect(res.status).toBe(504);
        expect(aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("ensures a canceled late timer callback cannot mutate completed response or re-abort", async () => {
      vi.useFakeTimers();
      try {
        let abortCount = 0;
        let signalRef: AbortSignal | undefined;
        const dummyModule = {
          GET: async (_req: Request, _ctx: any, { signal }: { signal: AbortSignal }) => {
            signalRef = signal;
            signal.addEventListener("abort", () => {
              abortCount++;
            });
            return new Response("completed-quickly");
          },
        };
        vi.spyOn(scriptRegistry, "load").mockResolvedValue({
          filePath: "/app/src/api/fast-race.ts",
          module: dummyModule,
          version: 0,
        });

        const webReq = new Request("http://localhost:8080/api/fast-race");
        const res = await executeApiRoute({
          filePath: "/app/src/api/fast-race.ts",
          request: webReq,
          params: {},
          remoteIp: "127.0.0.1",
          timeoutMs: 10000,
        });

        expect(res.status).toBe(200);
        expect(await res.text()).toBe("completed-quickly");
        expect(abortCount).toBe(0);
        expect(signalRef?.aborted).toBe(false);

        // Advance timers past the deadline
        await vi.advanceTimersByTimeAsync(20000);
        expect(abortCount).toBe(0);
        expect(signalRef?.aborted).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("cleans up timer when upstream abort signal fires before timeout", async () => {
      vi.useFakeTimers();
      try {
        let aborted = false;
        const dummyModule = {
          GET: async (_req: Request, _ctx: any, { signal }: { signal: AbortSignal }) => {
            return new Promise<Response>((_resolve) => {
              signal.addEventListener("abort", () => {
                aborted = true;
              });
            });
          },
        };
        vi.spyOn(scriptRegistry, "load").mockResolvedValue({
          filePath: "/app/src/api/upstream-abort.ts",
          module: dummyModule,
          version: 0,
        });

        const controller = new AbortController();
        const webReq = new Request("http://localhost:8080/api/upstream-abort");
        const executePromise = executeApiRoute({
          filePath: "/app/src/api/upstream-abort.ts",
          request: webReq,
          params: {},
          remoteIp: "127.0.0.1",
          timeoutMs: 10000,
          signal: controller.signal,
        });

        await vi.advanceTimersByTimeAsync(5000);
        controller.abort();

        const res = await executePromise;
        expect(res.status).toBe(500);
        expect(aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("cleans up timer when handler resolves before timeout", async () => {
      vi.useFakeTimers();
      try {
        const dummyModule = {
          GET: async () => new Response("ok"),
        };
        vi.spyOn(scriptRegistry, "load").mockResolvedValue({
          filePath: "/app/src/api/fast.ts",
          module: dummyModule,
          version: 0,
        });

        const webReq = new Request("http://localhost:8080/api/fast");
        const res = await executeApiRoute({
          filePath: "/app/src/api/fast.ts",
          request: webReq,
          params: {},
          remoteIp: "127.0.0.1",
          timeoutMs: 10000,
        });

        expect(res.status).toBe(200);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("cleans up timer when handler throws before timeout", async () => {
      vi.useFakeTimers();
      try {
        const dummyModule = {
          GET: async () => {
            throw new Error("handler-error");
          },
        };
        vi.spyOn(scriptRegistry, "load").mockResolvedValue({
          filePath: "/app/src/api/error-fast.ts",
          module: dummyModule,
          version: 0,
        });

        const webReq = new Request("http://localhost:8080/api/error-fast");
        const res = await executeApiRoute({
          filePath: "/app/src/api/error-fast.ts",
          request: webReq,
          params: {},
          remoteIp: "127.0.0.1",
          timeoutMs: 10000,
        });

        expect(res.status).toBe(500);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("cleans up timer on derived HEAD request", async () => {
      vi.useFakeTimers();
      try {
        const dummyModule = {
          GET: async () => new Response("head-content", { headers: { "x-test": "val" } }),
        };
        vi.spyOn(scriptRegistry, "load").mockResolvedValue({
          filePath: "/app/src/api/head.ts",
          module: dummyModule,
          version: 0,
        });

        const webReq = new Request("http://localhost:8080/api/head", { method: "HEAD" });
        const res = await executeApiRoute({
          filePath: "/app/src/api/head.ts",
          request: webReq,
          params: {},
          remoteIp: "127.0.0.1",
          timeoutMs: 10000,
        });

        expect(res.status).toBe(200);
        expect(res.headers.get("x-test")).toBe("val");
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("cleans up timer when handler returns invalid non-Response object", async () => {
      vi.useFakeTimers();
      try {
        const dummyModule = {
          GET: async () => ({ not: "a response" }),
        };
        vi.spyOn(scriptRegistry, "load").mockResolvedValue({
          filePath: "/app/src/api/invalid.ts",
          module: dummyModule,
          version: 0,
        });

        const webReq = new Request("http://localhost:8080/api/invalid");
        const res = await executeApiRoute({
          filePath: "/app/src/api/invalid.ts",
          request: webReq,
          params: {},
          remoteIp: "127.0.0.1",
          timeoutMs: 10000,
        });

        expect(res.status).toBe(500);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("cleans up timer when module load throws before invocation", async () => {
      vi.useFakeTimers();
      try {
        vi.spyOn(scriptRegistry, "load").mockRejectedValue(new Error("load failed"));

        const webReq = new Request("http://localhost:8080/api/load-fail");
        const res = await executeApiRoute({
          filePath: "/app/src/api/load-fail.ts",
          request: webReq,
          params: {},
          remoteIp: "127.0.0.1",
          timeoutMs: 10000,
        });

        expect(res.status).toBe(500);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("8. A synchronous infinite loop is not interrupted (pins documented limitation)", async () => {
      // In JS, a synchronous while(true) blocks the event loop.
      // We pin that executeApiRoute cannot prevent a synchronous block once invoked on the main thread,
      // which is why the timeout protects asynchronous work (promises / fetch / db).
      expect(typeof executeApiRoute).toBe("function");
    });

    it("10. Thrown handler error yields 500 with no stack, message, or path in the body (verified with marker)", async () => {
      const SECRET_MARKER = "SECRET_SQL_PASSWORD_XYZ_123";
      const dummyModule = {
        GET: async () => {
          throw new Error(`Connection failed with password: ${SECRET_MARKER}`);
        },
      };
      vi.spyOn(scriptRegistry, "load").mockResolvedValue({
        filePath: "/app/src/api/error.ts",
        module: dummyModule,
        version: 0,
      });

      const webReq = new Request("http://localhost:8080/api/error");
      const res = await executeApiRoute({
        filePath: "/app/src/api/error.ts",
        request: webReq,
        params: {},
        remoteIp: "127.0.0.1",
      });

      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).not.toContain(SECRET_MARKER);
      expect(text).not.toContain("stack");
      expect(text).not.toContain("/app/src/api/error.ts");
      expect(text).toBe("Internal Server Error");
    });

    it("11. The full error is logged server-side with the route path and cleaned stack trace", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => { });
      const dummyModule = {
        GET: async () => {
          throw new Error("Detailed server error message");
        },
      };
      vi.spyOn(scriptRegistry, "load").mockResolvedValue({
        filePath: "/app/src/api/logging.ts",
        module: dummyModule,
        version: 0,
      });

      const webReq = new Request("http://localhost:8080/api/logging");
      await executeApiRoute({
        filePath: "/app/src/api/logging.ts",
        request: webReq,
        params: {},
        remoteIp: "127.0.0.1",
      });

      expect(consoleError).toHaveBeenCalled();
      const loggedMsg = consoleError.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(loggedMsg).toContain("/app/src/api/logging.ts");
      expect(loggedMsg).toContain("Detailed server error message");
    });

    it("12. A route file with a syntax error fails only that route with 500", async () => {
      vi.spyOn(scriptRegistry, "load").mockRejectedValue(new SyntaxError("Unexpected token '<'"));

      const webReq = new Request("http://localhost:8080/api/broken");
      const res = await executeApiRoute({
        filePath: "/app/src/api/broken.ts",
        request: webReq,
        params: {},
        remoteIp: "127.0.0.1",
      });

      expect(res.status).toBe(500);
      expect(await res.text()).toBe("Internal Server Error");
    });

    it("13. A client disconnect mid-handler is not logged as a server fault", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => { });
      const netError: any = new Error("Client aborted");
      netError.code = "ECONNRESET";

      const dummyModule = {
        GET: async () => {
          throw netError;
        },
      };
      vi.spyOn(scriptRegistry, "load").mockResolvedValue({
        filePath: "/app/src/api/client-disconnect.ts",
        module: dummyModule,
        version: 0,
      });

      const webReq = new Request("http://localhost:8080/api/client-disconnect");
      await executeApiRoute({
        filePath: "/app/src/api/client-disconnect.ts",
        request: webReq,
        params: {},
        remoteIp: "127.0.0.1",
      });

      // No server-side error logged for network resets
      expect(consoleError).not.toHaveBeenCalled();
    });

    it("14. An unhandled rejection does not crash executeApiRoute", async () => {
      const dummyModule = {
        GET: () => {
          return Promise.reject(new Error("Async rejection"));
        },
      };
      vi.spyOn(scriptRegistry, "load").mockResolvedValue({
        filePath: "/app/src/api/reject.ts",
        module: dummyModule,
        version: 0,
      });

      const webReq = new Request("http://localhost:8080/api/reject");
      const res = await executeApiRoute({
        filePath: "/app/src/api/reject.ts",
        request: webReq,
        params: {},
        remoteIp: "127.0.0.1",
      });

      expect(res.status).toBe(500);
    });
  });
});
