import { describe, it, expect } from "vitest";
import { loadChokidar } from "./dev-watcher.ts";

describe("loadChokidar", () => {
  it("resolves the chokidar module when present", async () => {
    const chokidar = await loadChokidar();
    expect(chokidar).toBeDefined();
    expect(typeof chokidar.watch).toBe("function");
  });

  it("throws a descriptive actionable error when chokidar cannot be found (ERR_MODULE_NOT_FOUND)", async () => {
    const missingModuleLoader = () =>
      Promise.reject(
        Object.assign(new Error("Cannot find module 'chokidar'"), {
          code: "ERR_MODULE_NOT_FOUND",
        })
      );

    await expect(loadChokidar(missingModuleLoader)).rejects.toThrowError(
      /`bascik dev` requires chokidar for file watching, but it is not installed/
    );
    await expect(loadChokidar(missingModuleLoader)).rejects.toThrowError(
      /--omit=optional/
    );
  });

  it("throws a descriptive actionable error when chokidar cannot be found (MODULE_NOT_FOUND)", async () => {
    const missingModuleLoader = () =>
      Promise.reject(
        Object.assign(new Error("Cannot find module 'chokidar'"), {
          code: "MODULE_NOT_FOUND",
        })
      );

    await expect(loadChokidar(missingModuleLoader)).rejects.toThrowError(
      /`bascik dev` requires chokidar for file watching, but it is not installed/
    );
  });

  it("rethrows other unexpected errors", async () => {
    const unexpectedError = new Error("Syntax error in package");
    const failingLoader = () => Promise.reject(unexpectedError);

    await expect(loadChokidar(failingLoader)).rejects.toThrow(unexpectedError);
  });
});
