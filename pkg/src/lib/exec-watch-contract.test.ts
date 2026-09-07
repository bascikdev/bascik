import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { installExecPublication } from "./exec-publication.ts";
import { validateConfigShape } from "./config-validation.ts";

describe("independent exec and compilation contract", () => {
  it("does not install a completion-driven compilation listener", () => {
    const emitter = new EventEmitter();
    installExecPublication(emitter);
    expect(emitter.listenerCount("exec-completed")).toBe(0);
  });

  it.each(["dist/file.json", ["dist/file.json"], [], 42])("rejects the removed outputs option: %j", (outputs) => {
    const errors = validateConfigShape({ pipeline: { exec: [{ script: "script.ts", outputs }] } });
    expect(errors).toEqual([expect.objectContaining({ key: "pipeline.exec[0].outputs", unknownKey: true })]);
  });

  it("still broadcasts every failed script as a located build-error without reload", () => {
    const emitter = new EventEmitter();
    const errors: unknown[] = [];
    let reloads = 0;
    emitter.on("build-error", (error) => errors.push(error));
    emitter.on("transpiled", () => reloads++);
    installExecPublication(emitter);
    for (const script of ["first.ts", "second.ts"]) {
      emitter.emit("exec-failed", { entry: { script }, paths: [], error: new Error(script) });
    }
    expect(errors).toEqual([
      expect.objectContaining({ file: "first.ts", message: expect.stringContaining("first.ts") }),
      expect.objectContaining({ file: "second.ts", message: expect.stringContaining("second.ts") }),
    ]);
    expect(reloads).toBe(0);
  });
});