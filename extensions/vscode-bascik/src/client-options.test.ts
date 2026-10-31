import { join, resolve } from "node:path";
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
      initializationOptions(appRoot, { enabled: true, path: "" }, "/work/site"),
    ).toEqual({
      typescript: {
        enabled: true,
        path: join(appRoot, "extensions", "node_modules", "typescript"),
      },
      editorHasEmbeddedTypeScript: true,
    });
    expect(bundledTypeScriptPath(appRoot)).toBe(
      join(appRoot, "extensions", "node_modules", "typescript"),
    );
  });

  it("uses the bascik.typescript.path setting instead, and passes enabled through", () => {
    expect(
      initializationOptions(
        appRoot,
        { enabled: false, path: "  /opt/typescript  " },
        "/work/site",
      ).typescript,
    ).toEqual({ enabled: false, path: resolve("/opt/typescript") });
  });

  it("misuse: reads a relative setting from the first workspace folder, or the editor when there is none", () => {
    expect(
      initializationOptions(
        appRoot,
        { enabled: true, path: "node_modules/typescript" },
        "/work/site",
      ).typescript.path,
    ).toBe(resolve("/work/site", "node_modules/typescript"));
    expect(
      initializationOptions(
        appRoot,
        { enabled: true, path: "node_modules/typescript" },
        undefined,
      ).typescript.path,
    ).toBe(resolve(appRoot, "node_modules/typescript"));
  });
});
