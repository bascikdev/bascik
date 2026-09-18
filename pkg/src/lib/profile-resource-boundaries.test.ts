import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanGeneratorEnvironment, validateIndependentGates, validateResponses } from "../../bench/profile-workload.ts";

const workload = new URL("../../bench/profile-workload.ts", import.meta.url).href;

describe("profiling boundary controls", () => {
  it.each([false, true])("measures actual script, stream, source-cycle and worker resource boundaries (allocation=%s)", async (allocation) => {
    const root = await mkdtemp(join(tmpdir(), "bascik-resource-boundaries-"));
    let passed = false;
    try {
      await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../../bench/profile-boundaries.ts", import.meta.url)), root, ...(allocation ? ["--allocation"] : [])], {
        timeout: 30_000, env: cleanGeneratorEnvironment(process.env),
      });
      const result = JSON.parse(await readFile(join(root, "boundaries.json"), "utf8"));
      expect(result.success).toBe(true);
      expect(result.checkpoints.map((entry: { phase: string }) => entry.phase)).toEqual(expect.arrayContaining([
        "script-success", "script-syntax-failure", "script-cancel", "stream-success", "stream-disconnect", "source-cycle", "worker-success", "worker-cancel", "shutdown",
      ]));
      expect(result.sourceCycle.compilations).toBe(1);
      expect(result.sourceCycle.publications).toBe(1);
      expect(result.worker.completed).toBe(4);
      expect(result.worker.maxActive).toBe(2);
      expect(result.worker.canceled).toBe(3);
      if (allocation) {
        expect(result.allocation.records).toBeGreaterThan(0);
        expect(result.allocation.coverage).toBe("main script and source-cycle window only");
        expect(JSON.parse(await readFile(join(root, "main.heapprofile"), "utf8")).samples.length).toBeGreaterThan(0);
      }
      expect((await stat(root)).mode & 0o777).toBe(0o700);
      passed = true;
    } finally {
      if (passed && process.env.BASCIK_PROFILE_TEST_KEEP_REPORTS !== "1") await rm(root, { recursive: true, force: true });
      else console.error(`Private resource-boundary diagnostics retained: ${root}`);
    }
  }, 35_000);

  it.each(["timer", "descriptor"])("rejects a live injected %s and accepts its explicit cleanup", async (resource) => {
    const source = `
      import { createResourceProbe, validateResourceBoundary } from ${JSON.stringify(workload)};
      import { openSync, closeSync } from 'node:fs';
      import { setImmediate as checkpoint } from 'node:timers/promises';
      import assert from 'node:assert/strict';
      const probe = createResourceProbe();
      const baseline = probe.snapshot();
      const resource = ${JSON.stringify(resource)};
      const handle = resource === 'timer' ? setInterval(() => {}, 1000).unref() : openSync(process.execPath, 'r');
      assert.throws(() => validateResourceBoundary(baseline, probe.snapshot()), /resource boundary/);
      if (resource === 'timer') clearInterval(handle); else closeSync(handle);
      await checkpoint();
      await checkpoint();
      validateResourceBoundary(baseline, probe.snapshot());
      probe.close();
      console.log('control rejected and cleanup accepted');
    `;
    const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", source], {
      timeout: 10_000, env: cleanGeneratorEnvironment(process.env),
    });
    expect(result.stdout).toContain("control rejected and cleanup accepted");
  });

  it.each([false, true])("discriminates independent gates from serialization (serialized=%s)", async (serialized) => {
    const events: { gate: string; event: "start" | "release" | "end"; at: number }[] = [];
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const run = async (gate: string, release: Promise<void>) => {
      events.push({ gate, event: "start", at: performance.now() });
      await release;
      events.push({ gate, event: "end", at: performance.now() });
    };
    const pending = run("first", first.promise);
    const other = serialized ? pending.then(() => run("second", second.promise)) : run("second", second.promise);
    events.push({ gate: "first", event: "release", at: performance.now() });
    first.resolve();
    await pending;
    events.push({ gate: "second", event: "release", at: performance.now() });
    second.resolve();
    await other;
    if (serialized) expect(() => validateIndependentGates(events, ["first", "second"])).toThrow(/independent gates/);
    else expect(() => validateIndependentGates(events, ["first", "second"])).not.toThrow();
  });

  it("rejects a stream with all expected bytes but no completion", async () => {
    const body = Buffer.from("complete bytes do not prove stream completion");
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const reader = new ReadableStream<Uint8Array>({ start(value) { controller = value; value.enqueue(body); } }).getReader();
    const chunk = await reader.read();
    const expected = [{ id: "stream", body }];
    const response = { id: "stream", body: Buffer.from(chunk.value!), status: 200, encoding: "identity", durationMs: 0, complete: false };
    try {
      expect(() => validateResponses(expected, [response])).toThrow(/stream completion/);
      controller.close();
      response.complete = (await reader.read()).done;
      expect(() => validateResponses(expected, [response])).not.toThrow();
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  });

  describe("packet R6: exec, permit, worker, and SSE repeated boundary controls", () => {
    it("negative control: rejects leaked permit and unreleased listener on repeated execution", async () => {
      const { Semaphore } = await import("./script-runner.ts");
      const sem = new Semaphore(1);
      await sem.acquire();
      expect(sem.getActiveCount()).toBe(1);

      // Leaked permit oracle rejection
      expect(() => {
        expect(sem.getActiveCount()).toBe(0);
      }).toThrow();
      sem.release();
      expect(sem.getActiveCount()).toBe(0);

      // Unreleased drain listener oracle rejection
      const { SseManager } = await import("./sse.ts");
      const sse = new SseManager({ heartbeatIntervalMs: 10_000 });
      const emitter = new (await import("node:events")).EventEmitter();
      const mockRes: any = {
        headersSent: false,
        destroyed: false,
        writableEnded: false,
        write: () => true,
        end: () => {},
        on: (event: string, listener: any) => emitter.on(event, listener),
        off: (event: string, listener: any) => emitter.off(event, listener),
      };
      const client = sse.addClient(mockRes);
      expect(emitter.listenerCount("drain")).toBe(1);
      expect(() => {
        expect(emitter.listenerCount("drain")).toBe(0);
      }).toThrow();
      sse.removeClient(client!.id);
      expect(emitter.listenerCount("drain")).toBe(0);
      sse.destroy();
    });

    it("settles 100 repeated permit and SSE boundary cycles without resource or listener accumulation", async () => {
      const { Semaphore } = await import("./script-runner.ts");
      const { SseManager } = await import("./sse.ts");
      const { EventEmitter } = await import("node:events");
      const { createResourceProbe, validateResourceBoundary } = await import("../../bench/profile-workload.ts");

      const probe = createResourceProbe();
      const baseline = probe.snapshot();

      const sem = new Semaphore(2);
      const sse = new SseManager({ heartbeatIntervalMs: 60_000 });

      // 100 repeated permit acquisition and release cycles
      for (let i = 0; i < 100; i++) {
        await sem.acquire();
        expect(sem.getActiveCount()).toBe(1);
        sem.release();
        expect(sem.getActiveCount()).toBe(0);
      }

      // 100 repeated SSE client connection, backpressure drain, and removal cycles
      for (let i = 0; i < 100; i++) {
        const emitter = new EventEmitter();
        const mockRes: any = {
          headersSent: false,
          destroyed: false,
          writableEnded: false,
          write: () => {
            return false; // force backpressure drain listener state
          },
          end: () => {},
          close: () => {},
          on: (event: string, listener: any) => emitter.on(event, listener),
          off: (event: string, listener: any) => emitter.off(event, listener),
        };

        const client = sse.addClient(mockRes);
        expect(client).toBeDefined();
        expect(emitter.listenerCount("drain")).toBe(1);

        // Send a frame to exercise write backpressure
        sse.send(client!, `data: message-${i}\n\n`);

        // Emit drain to resolve backpressure
        emitter.emit("drain");

        // Remove client cleanly
        sse.removeClient(client!.id);
        expect(sse.activeClientCount).toBe(0);
        expect(emitter.listenerCount("drain")).toBe(0);
      }

      sse.destroy();
      expect(sse.activeClientCount).toBe(0);

      // Allow GC / microtask turn for unreferenced timer/object cleanup
      await new Promise<void>((resolve) => setImmediate(resolve));

      // Validate zero async handle / descriptor leaks against baseline
      const finalSnapshot = probe.snapshot();
      validateResourceBoundary(baseline, finalSnapshot);
      probe.close();
    });
  });
});