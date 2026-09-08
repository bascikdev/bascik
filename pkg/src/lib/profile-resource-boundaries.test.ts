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
});