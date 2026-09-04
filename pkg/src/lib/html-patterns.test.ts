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
  getHtmlAttributeValue,
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

  describe("getHtmlAttributeValue", () => {
    it("extracts double-quoted attribute values", () => {
      const tag = '<script src="./app.ts" data-bascik-build>';
      expect(getHtmlAttributeValue(tag, "src")).toBe("./app.ts");
    });

    it("extracts single-quoted attribute values", () => {
      const tag = "<script src='./nested/module.js' type='module'>";
      expect(getHtmlAttributeValue(tag, "src")).toBe("./nested/module.js");
      expect(getHtmlAttributeValue(tag, "type")).toBe("module");
    });

    it("extracts bare/unquoted attribute values", () => {
      const tag = "<script src=bundle.js data-bascik-source-line=42>";
      expect(getHtmlAttributeValue(tag, "src")).toBe("bundle.js");
      expect(getHtmlAttributeValue(tag, "data-bascik-source-line")).toBe("42");
    });

    it("handles case-insensitive attribute matching", () => {
      const tag = '<script SRC="./app.ts">';
      expect(getHtmlAttributeValue(tag, "src")).toBe("./app.ts");
      expect(getHtmlAttributeValue(tag, "SRC")).toBe("./app.ts");
    });

    it("handles empty attribute values", () => {
      const tag = '<input value="" name=\'\'>';
      expect(getHtmlAttributeValue(tag, "value")).toBe("");
      expect(getHtmlAttributeValue(tag, "name")).toBe("");
    });

    it("returns undefined for missing attributes or boolean attributes without value", () => {
      const tag = '<script data-bascik-build src="./app.ts">';
      expect(getHtmlAttributeValue(tag, "data-bascik-build")).toBeUndefined();
      expect(getHtmlAttributeValue(tag, "nonexistent")).toBeUndefined();
    });

    it("handles multiple attributes with whitespace around equals and complex values", () => {
      const tag = '<a href = "https://example.com/api?foo=1&bar=2" title = \'Hello World\' target="_blank">';
      expect(getHtmlAttributeValue(tag, "href")).toBe("https://example.com/api?foo=1&bar=2");
      expect(getHtmlAttributeValue(tag, "title")).toBe("Hello World");
      expect(getHtmlAttributeValue(tag, "target")).toBe("_blank");
    });
  });
});
