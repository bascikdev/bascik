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
  SCRIPT_END_TAG,
  SCRIPT_TAG_PREFIX,
  getHtmlAttributeValue,
  scriptOpenTag,
} from "./html-patterns.ts";

describe("SCRIPT_END_TAG", () => {
  const endTag = new RegExp(`^${SCRIPT_END_TAG}$`, "i");

  it.each(["</script>", "</SCRIPT>", "</script >", "</script\t\n foo>", "</script/>", "</script foo=\"bar\">", "</script <p>"])(
    "matches the end tag %j that browsers accept",
    (tag) => expect(endTag.test(tag)).toBe(true),
  );

  it.each(["</scripts>", "</script-x>", "</scriptfoo>", "</ script>", "</script", "</script\u00a0>", "</script\u3000>"])("does not match %j", (tag) => {
    expect(endTag.test(tag)).toBe(false);
  });

  it("ends a lazy script body at the first end tag, whatever its spelling", () => {
    const re = new RegExp(`<script>([\\s\\S]*?)${SCRIPT_END_TAG}`, "gi");
    const html = "<script>a()</script\t\n foo><p>between</p><script>b()</scripts></script/><p>after</p>";
    expect([...html.matchAll(re)].map((match) => match[1])).toEqual(["a()", "b()</scripts>"]);
  });
});

describe("scriptOpenTag", () => {
  it.each([
    ["</script>"],
    ["</script >"],
    ["</script\t\n foo>"],
    ["</script/>"],
    ["</SCRIPT b </script>"],
  ])("strips the body and the end tag %j", (endTag) => {
    const open = '<script data-bascik-build data-note="a > b">';
    expect(scriptOpenTag(`${open}x()${endTag}`, "x()")).toBe(open);
    expect(scriptOpenTag(`${open}${endTag}`, "")).toBe(open);
  });

  it("keeps end-tag lookalikes in the body out of the open tag", () => {
    const open = "<script data-bascik-server>";
    const body = 'const s = "</scripts>";';
    expect(scriptOpenTag(`${open}${body}</script>`, body)).toBe(open);
  });
});

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
