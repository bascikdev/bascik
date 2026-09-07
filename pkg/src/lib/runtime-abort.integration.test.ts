import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getEventListeners } from "node:events";
import { ScriptRegistry } from "./script-registry.js";
import { executeApiRoute } from "./api-runtime.js";
import { scriptRegistry } from "./script-registry.js";
import { FrameworkClock, TimeoutHandle } from "./clock.js";

describe("Runtime abort and deadline settlement ordering (integration)", () => {
  let loadSpy: any;

  beforeEach(() => {
    // Vitest 4 hygiene: individual mock resets, not vi.clearAllMocks()
    loadSpy?.mockReset?.();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("1. Pre-aborted invocations never invoke handler", () => {
    it("ScriptRegistry.invoke with already-aborted signal never runs handler (timeout disabled)", async () => {
      let handlerCalled = false;
      const registry = new ScriptRegistry();
      // Pre-load to isolate load from invoke
      loadSpy = vi.spyOn(registry, "load").mockResolvedValue({
        filePath: "dummy.js",
        module: {
          default: () => {
            handlerCalled = true;
          },
        },
        version: 0,
      });

      const controller = new AbortController();
      controller.abort(new Error("Pre-aborted upstream"));

      const result = await registry.invoke("dummy.js", [], {
        signal: controller.signal,
        timeoutMs: 0,
      });

      expect(handlerCalled).toBe(false);
      expect(result.ok).toBe(false);
      expect(result.timedOut).toBe(false);
      expect(result.error?.message).toContain("Pre-aborted upstream");
    });

    it("ScriptRegistry.invoke with already-aborted signal never runs handler (timeout enabled)", async () => {
      let handlerCalled = false;
      const registry = new ScriptRegistry();
      loadSpy = vi.spyOn(registry, "load").mockResolvedValue({
        filePath: "dummy.js",
        module: {
          default: () => {
            handlerCalled = true;
          },
        },
        version: 0,
      });

      const controller = new AbortController();
      controller.abort(new Error("Pre-aborted upstream with timeout"));

      const result = await registry.invoke("dummy.js", [], {
        signal: controller.signal,
        timeoutMs: 10000,
      });

      expect(handlerCalled).toBe(false);
      expect(result.ok).toBe(false);
      expect(result.timedOut).toBe(false);
      expect(result.error?.message).toContain("Pre-aborted upstream with timeout");
    });

    it("executeApiRoute with already-aborted signal never runs handler (timeout disabled)", async () => {
      let handlerCalled = false;
      loadSpy = vi.spyOn(scriptRegistry, "load").mockResolvedValue({
        filePath: "/app/src/api/preabort.ts",
        module: {
          GET: () => {
            handlerCalled = true;
            return new Response("ok");
          },
        },
        version: 0,
      });

      const controller = new AbortController();
      controller.abort(new Error("Client aborted"));

      const req = new Request("http://localhost:8080/api/preabort");
      const res = await executeApiRoute({
        filePath: "/app/src/api/preabort.ts",
        request: req,
        params: {},
        remoteIp: "127.0.0.1",
        signal: controller.signal,
        timeoutMs: 0,
      });

      expect(handlerCalled).toBe(false);
      expect(res.status).toBe(499);
    });

    it("executeApiRoute with already-aborted signal never runs handler (timeout enabled)", async () => {
      let handlerCalled = false;
      loadSpy = vi.spyOn(scriptRegistry, "load").mockResolvedValue({
        filePath: "/app/src/api/preabort-timeout.ts",
        module: {
          GET: () => {
            handlerCalled = true;
            return new Response("ok");
          },
        },
        version: 0,
      });

      const controller = new AbortController();
      controller.abort(new Error("Client aborted"));

      const req = new Request("http://localhost:8080/api/preabort-timeout");
      const res = await executeApiRoute({
        filePath: "/app/src/api/preabort-timeout.ts",
        request: req,
        params: {},
        remoteIp: "127.0.0.1",
        signal: controller.signal,
        timeoutMs: 10000,
      });

      expect(handlerCalled).toBe(false);
      expect(res.status).toBe(499);
    });
  });

  describe("2. Abort or deadline during deferred load boundary", () => {
    it("ScriptRegistry.invoke aborts during deferred load and never calls handler", async () => {
      let handlerCalled = false;
      const controller = new AbortController();
      let resolveLoad: (val: any) => void;

      const registry = new ScriptRegistry();
      loadSpy = vi.spyOn(registry, "load").mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveLoad = resolve;
          })
      );

      const invokePromise = registry.invoke("deferred.js", [], {
        signal: controller.signal,
      });

      // Abort while loading
      controller.abort(new Error("Aborted during module load"));

      // Complete the load after abort
      resolveLoad!({
        filePath: "deferred.js",
        module: {
          default: () => {
            handlerCalled = true;
          },
        },
        version: 0,
      });

      const result = await invokePromise;
      expect(handlerCalled).toBe(false);
      expect(result.ok).toBe(false);
      expect(result.error?.message).toContain("Aborted during module load");
    });

    it("ScriptRegistry.invoke deadline fires during deferred load and never calls handler", async () => {
      let handlerCalled = false;
      let timeoutCallback: (() => void) | undefined;
      let resolveLoad: (val: any) => void;

      const mockClock: FrameworkClock = {
        now: () => 1000,
        setTimeout: (cb) => {
          timeoutCallback = cb;
          return 1 as unknown as TimeoutHandle;
        },
        clearTimeout: vi.fn(),
        setInterval: vi.fn(),
        clearInterval: vi.fn(),
      };

      const registry = new ScriptRegistry({ clock: mockClock });
      loadSpy = vi.spyOn(registry, "load").mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveLoad = resolve;
          })
      );

      const invokePromise = registry.invoke("deferred-timeout.js", [], {
        timeoutMs: 1000,
      });

      // Deadline fires during load
      expect(timeoutCallback).toBeDefined();
      timeoutCallback!();

      // Later load finishes
      resolveLoad!({
        filePath: "deferred-timeout.js",
        module: {
          default: () => {
            handlerCalled = true;
          },
        },
        version: 0,
      });

      const result = await invokePromise;
      expect(handlerCalled).toBe(false);
      expect(result.ok).toBe(false);
      expect(result.timedOut).toBe(true);
      expect(result.error?.message).toContain("timed out after 1000ms");
    });

    it("executeApiRoute aborts during deferred load and never calls handler", async () => {
      let handlerCalled = false;
      const controller = new AbortController();
      let resolveLoad: (val: any) => void;

      loadSpy = vi.spyOn(scriptRegistry, "load").mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveLoad = resolve;
          })
      );

      const req = new Request("http://localhost:8080/api/deferred-abort");
      const executePromise = executeApiRoute({
        filePath: "/app/src/api/deferred-abort.ts",
        request: req,
        params: {},
        remoteIp: "127.0.0.1",
        signal: controller.signal,
      });

      controller.abort(new Error("Client disconnect during load"));

      resolveLoad!({
        filePath: "/app/src/api/deferred-abort.ts",
        module: {
          GET: () => {
            handlerCalled = true;
            return new Response("ok");
          },
        },
        version: 0,
      });

      const res = await executePromise;
      expect(handlerCalled).toBe(false);
      expect(res.status).toBe(499);
    });

    it("executeApiRoute deadline fires during deferred load and never calls handler", async () => {
      let handlerCalled = false;
      let timeoutCallback: (() => void) | undefined;
      let resolveLoad: (val: any) => void;

      const mockClock: FrameworkClock = {
        now: () => 1000,
        setTimeout: (cb) => {
          timeoutCallback = cb;
          return 1 as unknown as TimeoutHandle;
        },
        clearTimeout: vi.fn(),
        setInterval: vi.fn(),
        clearInterval: vi.fn(),
      };

      loadSpy = vi.spyOn(scriptRegistry, "load").mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveLoad = resolve;
          })
      );

      const req = new Request("http://localhost:8080/api/deferred-timeout");
      const executePromise = executeApiRoute({
        filePath: "/app/src/api/deferred-timeout.ts",
        request: req,
        params: {},
        remoteIp: "127.0.0.1",
        timeoutMs: 1000,
        clock: mockClock,
      });

      expect(timeoutCallback).toBeDefined();
      timeoutCallback!();

      resolveLoad!({
        filePath: "/app/src/api/deferred-timeout.ts",
        module: {
          GET: () => {
            handlerCalled = true;
            return new Response("ok");
          },
        },
        version: 0,
      });

      const res = await executePromise;
      expect(handlerCalled).toBe(false);
      expect(res.status).toBe(504);
    });
  });

  describe("3. Settlement races and edge cases", () => {
    it("handler resolves then abort fires: settlement remains success and abort is ignored", async () => {
      const controller = new AbortController();
      const registry = new ScriptRegistry();
      loadSpy = vi.spyOn(registry, "load").mockResolvedValue({
        filePath: "resolve-abort.js",
        module: {
          default: async () => {
            return "immediate-success";
          },
        },
        version: 0,
      });

      const result = await registry.invoke("resolve-abort.js", [], {
        signal: controller.signal,
      });

      expect(result.ok).toBe(true);
      expect(result.value).toBe("immediate-success");

      // Late abort after resolution
      controller.abort(new Error("Late abort"));
      expect(result.ok).toBe(true);
      expect(result.timedOut).toBeUndefined();
    });

    it("abort fires then handler resolves/rejects late: remains aborted, late rejection is handled without unhandled-rejection", async () => {
      const controller = new AbortController();
      let lateReject: (err: Error) => void;
      let handlerStarted = false;

      const registry = new ScriptRegistry();
      loadSpy = vi.spyOn(registry, "load").mockResolvedValue({
        filePath: "late-reject.js",
        module: {
          default: () => {
            handlerStarted = true;
            return new Promise((_resolve, reject) => {
              lateReject = reject;
            });
          },
        },
        version: 0,
      });

      const invokePromise = registry.invoke("late-reject.js", [], {
        signal: controller.signal,
      });

      // Wait a tick for handler to be invoked
      await new Promise((r) => setTimeout(r, 0));
      expect(handlerStarted).toBe(true);

      controller.abort(new Error("Early abort"));
      const result = await invokePromise;

      expect(result.ok).toBe(false);
      expect(result.error?.message).toContain("Early abort");

      // Late rejection from handler that was started
      lateReject!(new Error("Late failure"));
      await new Promise((r) => setTimeout(r, 10));
      // No unhandled rejection thrown
    });

    it("timeout fires then handler rejects late: result is timed out, late rejection is handled", async () => {
      let timeoutCallback: (() => void) | undefined;
      let lateReject: (err: Error) => void;
      let handlerStarted = false;

      const mockClock: FrameworkClock = {
        now: () => 1000,
        setTimeout: (cb) => {
          timeoutCallback = cb;
          return 1 as unknown as TimeoutHandle;
        },
        clearTimeout: vi.fn(),
        setInterval: vi.fn(),
        clearInterval: vi.fn(),
      };

      const registry = new ScriptRegistry({ clock: mockClock });
      loadSpy = vi.spyOn(registry, "load").mockResolvedValue({
        filePath: "timeout-late-reject.js",
        module: {
          default: () => {
            handlerStarted = true;
            return new Promise((_, reject) => {
              lateReject = reject;
            });
          },
        },
        version: 0,
      });

      const invokePromise = registry.invoke("timeout-late-reject.js", [], {
        timeoutMs: 500,
      });

      // Wait a tick for handler to be invoked
      await new Promise((r) => setTimeout(r, 0));
      expect(handlerStarted).toBe(true);

      timeoutCallback!();
      const result = await invokePromise;

      expect(result.ok).toBe(false);
      expect(result.timedOut).toBe(true);

      lateReject!(new Error("Late explosion"));
      await new Promise((r) => setTimeout(r, 10));
    });

    it("synchronous throw from handler settles as error cleanly", async () => {
      const registry = new ScriptRegistry();
      loadSpy = vi.spyOn(registry, "load").mockResolvedValue({
        filePath: "sync-throw.js",
        module: {
          default: () => {
            throw new Error("Synchronous explosion");
          },
        },
        version: 0,
      });

      const result = await registry.invoke("sync-throw.js", []);
      expect(result.ok).toBe(false);
      expect(result.error?.message).toContain("Synchronous explosion");
    });

    it("reentrant upstream abort from inside the handler: the abort wins because it is observed before the handler promise settles", async () => {
      const controller = new AbortController();
      const registry = new ScriptRegistry();
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      loadSpy = vi.spyOn(registry, "load").mockResolvedValue({
        filePath: "reentrant-abort.js",
        module: {
          default: async () => {
            // Fires synchronously during the handler call, so the signal is
            // already aborted when the runtime checks it before racing. The
            // handler's return value (settled one microtask later) is discarded.
            controller.abort(new Error("Reentrant abort from inside"));
            return "handler-value";
          },
        },
        version: 0,
      });

      const result = await registry.invoke("reentrant-abort.js", [], {
        signal: controller.signal,
      });

      expect(result.ok).toBe(false);
      expect(result.timedOut).toBe(false);
      expect(result.error?.message).toBe("Reentrant abort from inside");
      errorSpy.mockRestore();
    });

    it("import rejection after cancellation is swallowed/contained without crashing process", async () => {
      const controller = new AbortController();
      let rejectLoad: (err: any) => void;
      const loadPromise = new Promise((_, reject) => {
        rejectLoad = reject;
      });

      const registry = new ScriptRegistry();
      loadSpy = vi.spyOn(registry, "load").mockImplementation(() => loadPromise as any);

      const invokePromise = registry.invoke("broken-import.js", [], {
        signal: controller.signal,
      });

      controller.abort(new Error("Canceled before import completed"));
      const result = await invokePromise;

      expect(result.ok).toBe(false);
      expect(result.error?.message).toContain("Canceled before import completed");

      // Now import fails
      rejectLoad!(new Error("SyntaxError: Unexpected token in module"));
      await new Promise((r) => setTimeout(r, 10));
    });

    it("non-Error abort reason is normalized cleanly into Error object", async () => {
      const controller = new AbortController();
      controller.abort("plain string abort reason");

      const registry = new ScriptRegistry();
      loadSpy = vi.spyOn(registry, "load").mockResolvedValue({
        filePath: "non-error.js",
        module: { default: () => {} },
        version: 0,
      });

      const result = await registry.invoke("non-error.js", [], {
        signal: controller.signal,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error?.message).toBe("plain string abort reason");
    });

    /**
     * Settlement contract under an injected clock: whichever of the handler
     * promise and the deadline settles first wins. Both settle in the same
     * synchronous turn here, so promise reaction order (settlement order)
     * decides deterministically.
     */
    const makeSimultaneousFixture = () => {
      let timeoutCallback: (() => void) | undefined;
      let resolveHandler: (val: unknown) => void = () => {};
      const handlerPromise = new Promise((resolve) => {
        resolveHandler = resolve;
      });
      const mockClock: FrameworkClock = {
        now: () => 1000,
        setTimeout: (cb) => {
          timeoutCallback = cb;
          return 1 as unknown as TimeoutHandle;
        },
        clearTimeout: vi.fn(),
        setInterval: vi.fn(),
        clearInterval: vi.fn(),
      };
      const registry = new ScriptRegistry({ clock: mockClock });
      loadSpy = vi.spyOn(registry, "load").mockResolvedValue({
        filePath: "simultaneous.js",
        module: { default: () => handlerPromise },
        version: 0,
      });
      return {
        registry,
        mockClock,
        fireTimeout: () => timeoutCallback!(),
        resolveHandler: (v: unknown) => resolveHandler(v),
      };
    };

    it("simultaneous completion: the deadline wins when it fires before the handler promise settles", async () => {
      const fx = makeSimultaneousFixture();
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const invokePromise = fx.registry.invoke("simultaneous.js", [], { timeoutMs: 100 });
      // Let invoke reach the result race before both settle in one turn.
      await Promise.resolve();
      await Promise.resolve();

      fx.fireTimeout();
      fx.resolveHandler("resolved-value");

      const result = await invokePromise;
      expect(result.ok).toBe(false);
      expect(result.timedOut).toBe(true);
      expect(result.error?.message).toContain("timed out after 100ms");
      expect(fx.mockClock.clearTimeout).toHaveBeenCalledTimes(1);
      errorSpy.mockRestore();
    });

    it("simultaneous completion: the handler result wins when its promise settles before the deadline fires", async () => {
      const fx = makeSimultaneousFixture();
      const invokePromise = fx.registry.invoke("simultaneous.js", [], { timeoutMs: 100 });
      await Promise.resolve();
      await Promise.resolve();

      fx.resolveHandler("resolved-value");
      fx.fireTimeout();

      const result = await invokePromise;
      expect(result.ok).toBe(true);
      expect(result.ok && result.value).toBe("resolved-value");
      expect(fx.mockClock.clearTimeout).toHaveBeenCalledTimes(1);
    });
  });

  describe("4. Listener and timer cleanup proof after many bounded invocations", () => {
    it("proves zero listener leaks on upstream signal after 100 invocations of ScriptRegistry.invoke", async () => {
      const controller = new AbortController();
      const registry = new ScriptRegistry();
      loadSpy = vi.spyOn(registry, "load").mockResolvedValue({
        filePath: "cleanup-test.js",
        module: {
          default: async () => {
            return "done";
          },
        },
        version: 0,
      });

      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      for (let i = 0; i < 100; i++) {
        const res = await registry.invoke("cleanup-test.js", [], {
          signal: controller.signal,
          timeoutMs: 5000,
        });
        expect(res.ok).toBe(true);
      }
      // Every invocation removed its upstream abort subscription.
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    });

    it("proves zero listener leaks on upstream signal after 100 invocations of executeApiRoute", async () => {
      const controller = new AbortController();
      loadSpy = vi.spyOn(scriptRegistry, "load").mockResolvedValue({
        filePath: "/app/src/api/cleanup.ts",
        module: {
          GET: async () => new Response("ok"),
        },
        version: 0,
      });

      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      for (let i = 0; i < 100; i++) {
        const req = new Request(`http://localhost:8080/api/cleanup?i=${i}`);
        const res = await executeApiRoute({
          filePath: "/app/src/api/cleanup.ts",
          request: req,
          params: {},
          remoteIp: "127.0.0.1",
          signal: controller.signal,
          timeoutMs: 5000,
        });
        expect(res.status).toBe(200);
      }
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    });
  });
});
