import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bundledTypeScriptPath, initializationOptions } from "./client-options";

const appRoot = join(
  "/Applications",
  "Code.app",
  "Contents",
  "Resources",
  "app",
);

describe("initializationOptions", () => {
  it("passes VS Code's own TypeScript and says the editor answers inside TypeScript blocks itself", () => {
    expect(
      initializationOptions(appRoot, { enabled: true, path: "" }, true),
    ).toEqual({
      typescript: {
        enabled: true,
        path: undefined,
        editorPath: join(appRoot, "extensions", "node_modules", "typescript"),
      },
      editorHasEmbeddedTypeScript: true,
    });
    expect(bundledTypeScriptPath(appRoot)).toBe(
      join(appRoot, "extensions", "node_modules", "typescript"),
    );
  });

  it("passes the bascik.typescript.path setting first, keeps VS Code's own as the fallback, and passes enabled through", () => {
    expect(
      initializationOptions(
        appRoot,
        { enabled: false, path: "  /opt/typescript  " },
        true,
      ).typescript,
    ).toEqual({
      enabled: false,
      path: "/opt/typescript",
      // A mistyped setting falls back to this copy rather than turning checks off.
      editorPath: bundledTypeScriptPath(appRoot),
    });
  });

  it("misuse: passes a relative setting as written, never resolved against the open workspace, so the server rejects it", () => {
    expect(
      initializationOptions(
        appRoot,
        { enabled: true, path: " node_modules/typescript " },
        true,
      ).typescript.path,
    ).toBe("node_modules/typescript");
  });

  it("asks the server for every answer when VS Code's HTML support is disabled", () => {
    expect(
      initializationOptions(appRoot, { enabled: true, path: "" }, false)
        .editorHasEmbeddedTypeScript,
    ).toBe(false);
  });
});
