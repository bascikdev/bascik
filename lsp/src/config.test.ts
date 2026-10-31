import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadExtensionConfig } from "./config.js";
import {
  parseExtensionConfigFile,
  parseExtensionConfigSource,
  readExtensionConfig,
} from "./config-reader.js";

describe("extension-config", () => {
  it("returns empty config when no file exists", () => {
    const cfg = loadExtensionConfig("/tmp");
    expect(cfg).toEqual({});
  });
});

describe("extension-config files", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "bascik-lsp-ext-config-"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as { __bascikExtPwned?: unknown }).__bascikExtPwned;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const write = (name: string, text: string) =>
    fs.writeFileSync(path.join(root, name), text);

  it("reads export default { ... } with comments, trailing commas and satisfies", () => {
    write(
      "bascik.ext.ts",
      [
        'import type { BascikExtensionConfig } from "@bascik/language-server";',
        "// Turned off while we migrate { old markup }",
        "export default {",
        "  diagnostics: {",
        "    disabledRules: [\"unclosed-component-tag\", 'css-id-selector'],",
        "    /* a } in a comment */ selfClosingComponents: false,",
        "  },",
        "} satisfies BascikExtensionConfig;",
        "// trailing } comment",
      ].join("\n"),
    );
    expect(loadExtensionConfig(root)).toEqual({
      diagnostics: {
        disabledRules: ["unclosed-component-tag", "css-id-selector"],
        selfClosingComponents: false,
      },
    });
  });

  it("reads a typed const exported by name", () => {
    write(
      "bascik.ext.ts",
      [
        'import type { BascikExtensionConfig } from "@bascik/language-server";',
        "const config: BascikExtensionConfig = {",
        '  diagnostics: { disabledRules: ["unclosed-component-tag"] },',
        "};",
        "export default config;",
      ].join("\n"),
    );
    expect(loadExtensionConfig(root)).toEqual({
      diagnostics: { disabledRules: ["unclosed-component-tag"] },
    });
  });

  it("reads module.exports in bascik.ext.js", () => {
    write(
      "bascik.ext.js",
      'module.exports = { diagnostics: { escapeFunctions: ["escapeHtml"] } };\n',
    );
    expect(loadExtensionConfig(root)).toEqual({
      diagnostics: { escapeFunctions: ["escapeHtml"] },
    });
  });

  it("never runs code in the config, and says where it stopped", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    write(
      "bascik.ext.ts",
      [
        "export default {",
        "  diagnostics: {",
        '    escapeFunctions: [(globalThis.__bascikExtPwned = process.pid, "ok")],',
        "  },",
        "};",
      ].join("\n"),
    );
    expect(loadExtensionConfig(root)).toEqual({});
    expect(
      (globalThis as { __bascikExtPwned?: unknown }).__bascikExtPwned,
    ).toBeUndefined();
    const result = readExtensionConfig(root);
    expect(result.problem).toMatchObject({
      file: path.join(root, "bascik.ext.ts"),
      line: 3,
    });
    expect(result.problem?.message).toMatch(/without running it/);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0][0])).toContain(
      `${path.join(root, "bascik.ext.ts")}:3:`,
    );
  });

  it("reports a file with no default export instead of silently ignoring it", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    write("bascik.ext.ts", "const config = { diagnostics: {} };\n");
    expect(readExtensionConfig(root).problem?.message).toMatch(
      /No `export default/,
    );
  });

  it("reports a broken bascik.ext.json once per change, with its line", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    write(
      "bascik.ext.json",
      '{\n  "diagnostics": {\n    "disabledRules": ["a",]\n  }\n}\n',
    );
    expect(loadExtensionConfig(root)).toEqual({});
    expect(loadExtensionConfig(root)).toEqual({});
    expect(errors).toHaveBeenCalledTimes(1);
    expect(readExtensionConfig(root).problem?.line).toBe(3);
    write("bascik.ext.json", '{ "diagnostics": { "enabled": false } }');
    expect(loadExtensionConfig(root)).toEqual({
      diagnostics: { enabled: false },
    });
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it("rejects a config that is not an object", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    write("bascik.ext.json", '["unclosed-component-tag"]');
    expect(loadExtensionConfig(root)).toEqual({});
    expect(readExtensionConfig(root).problem?.message).toMatch(/object/);
  });

  it("reports a config file that is present but cannot be read, instead of skipping it", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    // A folder where the file should be fails to read as EISDIR, like a file
    // the editor's user may not read (EACCES).
    fs.mkdirSync(path.join(root, "bascik.ext.json"));
    write(
      "bascik.ext.ts",
      "export default { diagnostics: { enabled: false } };",
    );
    const result = readExtensionConfig(root);
    expect(result).toMatchObject({
      config: {},
      file: path.join(root, "bascik.ext.json"),
      problem: {
        file: path.join(root, "bascik.ext.json"),
        line: 1,
        message: expect.stringMatching(/could not be read.*EISDIR/),
      },
    });
    expect(loadExtensionConfig(root)).toEqual({});
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0][0])).toContain(
      `${path.join(root, "bascik.ext.json")}:1:`,
    );
  });

  it("uses the first config file present, even when it is broken", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    write("bascik.ext.json", "{ nope");
    write(
      "bascik.ext.ts",
      "export default { diagnostics: { enabled: false } };",
    );
    expect(readExtensionConfig(root).file).toBe(
      path.join(root, "bascik.ext.json"),
    );
    expect(loadExtensionConfig(root)).toEqual({});
  });
});

describe("config literal reader", () => {
  it("keeps a __proto__ key as an own property, as JSON.parse does", () => {
    const config = parseExtensionConfigSource(
      'export default { "__proto__": { diagnostics: { selfClosingComponents: false } } };',
    ) as Record<string, unknown>;
    expect(Object.getPrototypeOf(config)).toBe(Object.prototype);
    expect(Object.keys(config)).toEqual(["__proto__"]);
    expect((config as { diagnostics?: unknown }).diagnostics).toBeUndefined();
    const bare = parseExtensionConfigSource(
      "export default { __proto__: { diagnostics: {} } };",
    ) as Record<string, unknown>;
    expect(Object.getPrototypeOf(bare)).toBe(Object.prototype);
    expect(Object.keys(bare)).toEqual(["__proto__"]);
  });

  it("decodes \\x, \\u and \\u{} escapes as JavaScript does", () => {
    expect(
      parseExtensionConfigSource(
        String.raw`export default { a: "\u0041", b: '\x42', c: "\u{1F600}", d: "\u{43}" };`,
      ),
    ).toEqual({ a: "A", b: "B", c: "\u{1F600}", d: "C" });
  });

  it("reports a malformed escape where it is", () => {
    expect(
      parseExtensionConfigFile(
        "bascik.ext.ts",
        'export default {\n  a: "\\u00G1",\n};',
      ).problem,
    ).toMatchObject({ line: 2, message: expect.stringMatching(/\\u escape/) });
    expect(() =>
      parseExtensionConfigSource('export default { a: "\\x4" };'),
    ).toThrow(/escape/i);
    expect(() =>
      parseExtensionConfigSource('export default { a: "\\u{110000}" };'),
    ).toThrow(/escape/i);
  });
});

describe("config literal reader on unhappy input (R2-03)", () => {
  it("reads a bascik.ext.json saved with a byte order mark, as Windows Notepad writes it", () => {
    expect(
      parseExtensionConfigFile(
        "bascik.ext.json",
        '﻿{ "diagnostics": { "enabled": false } }',
      ),
    ).toEqual({
      config: { diagnostics: { enabled: false } },
      file: "bascik.ext.json",
    });
  });

  it("reads a line continuation in a string with CRLF line endings", () => {
    expect(
      parseExtensionConfigSource(
        "export default {\r\n  diagnostics: { escapeFunctions: ['esc\\\r\nape'] },\r\n};\r\n",
      ),
    ).toEqual({ diagnostics: { escapeFunctions: ["escape"] } });
  });

  it("skips a regex literal elsewhere in the file instead of reading its quote as a string", () => {
    expect(
      parseExtensionConfigSource(
        [
          'const quoted = /"[^"]*"/g;',
          "const half = 4 / 2 / 1;",
          "const trailing = /\\//;",
          "export default { diagnostics: { enabled: false } };",
        ].join("\n"),
      ),
    ).toEqual({ diagnostics: { enabled: false } });
  });

  it("reads the number forms JavaScript writes", () => {
    expect(
      parseExtensionConfigSource(
        "export default { a: 1., b: 0o17, c: 0b101, d: 0x1F, e: 1_000, f: .5e1, g: -2 };",
      ),
    ).toEqual({ a: 1, b: 15, c: 5, d: 31, e: 1000, f: 5, g: -2 });
  });

  it("reports a computed __proto__ key at its line instead of setting the prototype", () => {
    const result = parseExtensionConfigFile(
      "bascik.ext.ts",
      "export default {\n  ['__proto__']: { diagnostics: {} },\n};",
    );
    expect(result.config).toEqual({});
    expect(Object.getPrototypeOf(result.config)).toBe(Object.prototype);
    expect(result.problem).toMatchObject({
      line: 2,
      message: expect.stringMatching(/key: value/),
    });
  });

  it("names the unsupported shape of a template literal with a substitution", () => {
    expect(
      parseExtensionConfigFile(
        "bascik.ext.ts",
        "export default {\n  diagnostics: { escapeFunctions: [`esc${1}`] },\n};",
      ).problem,
    ).toMatchObject({
      line: 2,
      message: expect.stringMatching(/literal values/),
    });
    expect(
      parseExtensionConfigSource(
        "export default { a: `plain \\${not} computed` };",
      ),
    ).toEqual({ a: "plain ${not} computed" });
  });

  it("reads nested arrays and objects with comments and trailing commas", () => {
    expect(
      parseExtensionConfigSource(
        "export default { a: [[1, [2, /* x */ [3,],],], { b: [ ], }, ], } as const;",
      ),
    ).toEqual({ a: [[1, [2, [3]]], { b: [] }] });
  });
});
