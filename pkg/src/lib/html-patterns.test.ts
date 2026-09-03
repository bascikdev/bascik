import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BARE_TOKEN,
  ATTR_VALUE,
  ATTR,
  BUILD_FLAG,
  SERVER_FLAG,
  ROUTES_FLAG,
  SCRIPT_TAG_PREFIX,
} from "./html-patterns.ts";

describe("html-patterns (Prompt 52)", () => {
  it("exports valid regex fragments", () => {
    expect(BARE_TOKEN).toBeDefined();
    expect(ATTR_VALUE).toBeDefined();
    expect(ATTR).toBeDefined();
    expect(BUILD_FLAG).toBeDefined();
    expect(SERVER_FLAG).toBeDefined();
    expect(ROUTES_FLAG).toBeDefined();
    expect(SCRIPT_TAG_PREFIX).toBeDefined();

    // Verify regex pattern matching
    const testRe = new RegExp(`${SCRIPT_TAG_PREFIX}(?:\\s+${ATTR})*\\s+${BUILD_FLAG}(?:\\s+${ATTR})*\\s*>`);
    expect(testRe.test('<script data-bascik-build type="module">')).toBe(true);
  });

  it("is imported by build-scripts.ts, routes.ts, and server-scripts.ts", () => {
    const buildScriptsSource = readFileSync(resolve(__dirname, "build-scripts.ts"), "utf-8");
    const routesSource = readFileSync(resolve(__dirname, "routes.ts"), "utf-8");
    const serverScriptsSource = readFileSync(resolve(__dirname, "server-scripts.ts"), "utf-8");

    expect(buildScriptsSource).toMatch(/from ["']\.\/html-patterns(\.ts)?["']/);
    expect(routesSource).toMatch(/from ["']\.\/html-patterns(\.ts)?["']/);
    expect(serverScriptsSource).toMatch(/from ["']\.\/html-patterns(\.ts)?["']/);
  });
});
