import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { installExecPublication } from "./exec-publication.ts";
import { execWatchCoversPath } from "./exec.ts";

describe("exec outcome reporting", () => {
  it("never turns success after failure into a reload", () => {
    const emitter = new EventEmitter();
    const events: string[] = [];
    for (const name of ["build-error", "transpiled", "asset-changed", "watch-path-processed"]) {
      emitter.on(name, () => events.push(name));
    }
    installExecPublication(emitter);
    const payload = { entry: { script: "generator.ts", watch: ["content/"] }, paths: ["content/doc.md"] };
    emitter.emit("exec-failed", { ...payload, error: "failed" });
    emitter.emit("exec-completed", payload);
    expect(events).toEqual(["build-error"]);
  });

  it("keeps failure reporters scoped to their own emitter", () => {
    const first = new EventEmitter();
    const second = new EventEmitter();
    const errors: string[] = [];
    first.on("build-error", () => errors.push("first"));
    second.on("build-error", () => errors.push("second"));
    installExecPublication(first);
    installExecPublication(second);
    installExecPublication(first);
    first.emit("exec-failed", { entry: { script: "first.ts" }, error: "first" });
    second.emit("exec-failed", { entry: { script: "second.ts" }, error: "second" });
    expect(errors).toEqual(["first", "second"]);
  });

  it("matches exec watch patterns without granting them compilation ownership", () => {
    expect(execWatchCoversPath(["content/*.md"], "content/doc.md")).toBe(true);
    expect(execWatchCoversPath(["content/*.md"], "content/sub/doc.md")).toBe(false);
    expect(execWatchCoversPath(["content/**/*.md"], "content/sub/doc.md")).toBe(true);
    expect(execWatchCoversPath(["./content"], `${process.cwd()}/content/doc.md`)).toBe(true);
    expect(execWatchCoversPath(["/abs/content"], "/abs/content/doc.md")).toBe(true);
    expect(execWatchCoversPath(["scripts/"], `${process.cwd()}/scripts/gen.mjs`, "scripts/gen.mjs")).toBe(false);
  });
});