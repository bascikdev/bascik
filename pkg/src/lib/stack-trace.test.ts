import { describe, it, expect, vi } from "vitest";
import { fileURLToPath } from "node:url";
import {
  cleanStackTrace,
  KEEP_INTERNAL_FRAMES_ENV,
  remapRewrittenColumns,
} from "./stack-trace.ts";
import { rewriteModuleSpecifiersWithEdits } from "./module-specifiers.ts";

/** This directory, which is where Bascik's own modules live in a real install too (dist/lib/). */
const bascikLib = fileURLToPath(new URL("./", import.meta.url));

describe("cleanStackTrace – frames that are not the user's", () => {
  it("drops Bascik's own frames and the builtin frames left after the user's last frame", () => {
    const rawTrace = [
      "Error: server boom",
      "    at default (src/pages/srv.html:12:15)",
      `    at ScriptRegistry.invoke (file://${bascikLib}script-registry.js:326:49)`,
      `    at async runServerScriptJob (file://${bascikLib}server-scripts.js:242:20)`,
      "    at async Promise.all (index 1)",
      `    at async file://${bascikLib}server.js:681:37`,
    ].join("\n");

    expect(cleanStackTrace(rawTrace, "data:x", "src/pages/srv.html", 1)).toBe(
      "Error: server boom\n    at default (src/pages/srv.html:12:15)",
    );
  });

  it("shifts columns on the module's first line only", () => {
    const raw = "Error: x\n    at a (data:mod:1:7)\n    at b (data:mod:3:5)";
    expect(cleanStackTrace(raw, "data:mod", "src/pages/x.html", 10, 20)).toBe(
      "Error: x\n    at a (src/pages/x.html:10:27)\n    at b (src/pages/x.html:12:5)",
    );
  });

  it("keeps a builtin frame that sits between two of the user's frames", () => {
    const rawTrace = [
      "Error: inner",
      "    at load (file:///project/src/lib/data.ts:3:9)",
      "    at async Promise.all (index 0)",
      "    at async default (src/pages/x.html:8:5)",
    ].join("\n");

    expect(cleanStackTrace(rawTrace, "/tmp/x.mjs", "src/pages/x.html", 1)).toBe(
      rawTrace,
    );
  });

  it("keeps frames of files in subdirectories, such as test fixtures, which are not Bascik's modules", () => {
    for (const frame of [
      `    at helper (file://${bascikLib}test-fixtures/helper.ts:2:3)`,
      `    at helper (${bascikLib}__fixtures__/helper.ts:2:3)`,
    ]) {
      expect(
        cleanStackTrace(
          `Error: x\n${frame}`,
          "/tmp/x.mjs",
          "src/pages/x.html",
          1,
        ),
      ).toContain(frame);
    }
  });

  it("drops a Bascik frame written as a plain path, without the file URL", () => {
    const rawTrace = `Error: x\n    at default (src/pages/x.html:3:1)\n    at run (${bascikLib}server-scripts.ts:300:9)`;
    expect(cleanStackTrace(rawTrace, "/tmp/x.mjs", "src/pages/x.html", 1)).toBe(
      "Error: x\n    at default (src/pages/x.html:3:1)",
    );
  });

  it(`keeps Bascik's frames when ${KEEP_INTERNAL_FRAMES_ENV}=1`, () => {
    const frame = `    at ScriptRegistry.invoke (file://${bascikLib}script-registry.ts:326:49)`;
    vi.stubEnv(KEEP_INTERNAL_FRAMES_ENV, "1");
    try {
      expect(
        cleanStackTrace(
          `Error: x\n${frame}`,
          "/tmp/x.mjs",
          "src/pages/x.html",
          1,
        ),
      ).toContain(frame);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("maps every column after rewritten imports back to the column as written", () => {
    const source =
      'import a from "./a.ts"; import b from "./b.ts"; a(); b(); boom();\nnext();';
    const { code, edits } = rewriteModuleSpecifiersWithEdits(
      source,
      "/project/src/pages",
      { importRoot: "/project/src" },
    );
    expect(edits).toHaveLength(2);
    const [rewrittenLine] = code.split("\n");
    for (const token of ["a()", "b()", "boom()"]) {
      const raw = `Error: x\n    at f (data:mod:1:${rewrittenLine.lastIndexOf(token) + 1})`;
      expect(remapRewrittenColumns(raw, ["data:mod"], edits)).toBe(
        `Error: x\n    at f (data:mod:1:${source.lastIndexOf(token) + 1})`,
      );
    }
    // Lines without a rewrite, and other files, are left alone.
    expect(
      remapRewrittenColumns("    at g (data:mod:2:1)", ["data:mod"], edits),
    ).toBe("    at g (data:mod:2:1)");
    expect(
      remapRewrittenColumns(
        "    at h (src/lib/x.ts:1:90)",
        ["data:mod"],
        edits,
      ),
    ).toBe("    at h (src/lib/x.ts:1:90)");
  });

  it("maps a column inside a rewritten specifier to the start of the specifier as written", () => {
    const source = 'import a from "./a.ts";';
    const { edits } = rewriteModuleSpecifiersWithEdits(source, "/project/src", {
      importRoot: "/project/src",
    });
    expect(remapRewrittenColumns("at (m.mjs:1:30)", ["m.mjs"], edits)).toBe(
      `at (m.mjs:1:${edits[0].column})`,
    );
  });

  it("keeps Node's located syntax-error report and drops its version trailer", () => {
    const tmpPath = "/project/node_modules/.cache/bascik/build-1-abc.mjs";
    const rawTrace = [
      `file://${tmpPath}:11`,
      '        return "x" +;',
      "                    ^",
      "",
      "SyntaxError: Unexpected token ';'",
      "    at compileSourceTextModule (node:internal/modules/esm/utils:319:16)",
      "    at ModuleLoader.moduleStrategy (node:internal/modules/esm/translators:89:18)",
      "",
      "Node.js v24.21.0",
    ].join("\n");

    // The module is padded to the file's lines, so the offset is 1 and the line is unchanged.
    expect(cleanStackTrace(rawTrace, tmpPath, "src/pages/s.html", 1)).toBe(
      "src/pages/s.html:11\n        return \"x\" +;\n                    ^\n\nSyntaxError: Unexpected token ';'",
    );
  });
});

describe("cleanStackTrace", () => {
  it("returns raw trace if trace is empty or falsy", () => {
    expect(
      cleanStackTrace("", "/tmp/file.mjs", "src/pages/index.html", 10),
    ).toBe("");
  });

  it("replaces tmp file path and maps line numbers using lineOffset", () => {
    const tmpPath = "/project/node_modules/.cache/bascik/server-123.mjs";
    const realPath = "src/pages/about.html";
    const lineOffset = 15;
    const rawTrace = `Error: Server error\n    at ${tmpPath}:3:8`;

    const cleaned = cleanStackTrace(rawTrace, tmpPath, realPath, lineOffset);
    expect(cleaned).toBe(`Error: Server error\n    at ${realPath}:17:8`);
  });

  it("handles file:// URI format in stack trace", () => {
    const tmpPath = "/project/node_modules/.cache/bascik/build-456.mjs";
    const realPath = "src/components/card.html";
    const lineOffset = 5;
    const rawTrace = `Error: Build error\n    at file://${tmpPath}:2:4`;

    const cleaned = cleanStackTrace(rawTrace, tmpPath, realPath, lineOffset);
    expect(cleaned).toBe(`Error: Build error\n    at ${realPath}:6:4`);
  });

  it("remaps frames that carry a dev generation query on the module path or file URL", () => {
    const modulePath = "/project/src/lib/handler.ts";
    const realPath = "src/pages/index.html";
    const rawTrace =
      `Error: gen failure\n` +
      `    at default (file://${modulePath}?bascik-gen=3:2:9)\n` +
      `    at default (${modulePath}?bascik-gen=3:4:1)`;

    const cleaned = cleanStackTrace(rawTrace, modulePath, realPath, 40);
    expect(cleaned).toBe(
      `Error: gen failure\n    at default (${realPath}:41:9)\n    at default (${realPath}:43:1)`,
    );
  });

  it("remaps Windows backslash tmpPath when stack frames use forward slashes", () => {
    const modulePath =
      "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\bascik-script\\gen-trace.mjs";
    const forwardPath =
      "C:/Users/RUNNER~1/AppData/Local/Temp/bascik-script/gen-trace.mjs";
    const realPath = "src/pages/index.html";
    const rawTrace =
      `Error: gen failure\n` +
      `    at default (${forwardPath}?bascik-gen=1:2:9)\n` +
      `    at default (file:///${forwardPath}?bascik-gen=1:4:1)`;

    const cleaned = cleanStackTrace(rawTrace, modulePath, realPath, 40);
    expect(cleaned).toBe(
      `Error: gen failure\n    at default (${realPath}:41:9)\n    at default (${realPath}:43:1)`,
    );
  });

  it("strips the dev generation marker from helper frames loaded under a generation URL (prompt 138)", () => {
    // The entry remaps to the authored source; helpers are their own files, so
    // their frames keep the helper path but must not carry `?bascik-gen=N`.
    const entryPath = "/project/src/lib/src-script.ts";
    const realPath = "src/pages/index.html";
    const rawTrace =
      `Error: from helper\n` +
      `    at utilValue (file:///project/src/lib/util.ts?bascik-gen=2:1:29)\n` +
      `    at helperValue (file:///project/src/lib/helper.ts?bascik-gen=2:2:35)\n` +
      `    at default (file://${entryPath}?bascik-gen=2:2:60)`;

    const cleaned = cleanStackTrace(rawTrace, entryPath, realPath, 10);
    expect(cleaned).toBe(
      `Error: from helper\n` +
        `    at utilValue (file:///project/src/lib/util.ts:1:29)\n` +
        `    at helperValue (file:///project/src/lib/helper.ts:2:35)\n` +
        `    at default (${realPath}:11:60)`,
    );
    expect(cleaned).not.toContain("bascik-gen");
  });

  it("filters out Command failed lines and node:internal stack frames/code frames", () => {
    const tmpPath = "/project/node_modules/.cache/bascik/build-456.mjs";
    const realPath = "src/pages/cli.html";
    const lineOffset = 5;
    const rawTrace = `Command failed: /node /project/node_modules/.cache/bascik/build-456.mjs
node:internal/modules/esm/resolve:271
    throw new ERR_MODULE_NOT_FOUND(
          ^
Error [ERR_MODULE_NOT_FOUND]: Cannot find module './does-not-exist' imported from file://${tmpPath}:2:4
    at finalizeResolution (node:internal/modules/esm/resolve:271:11)
    at moduleResolve (node:internal/modules/esm/resolve:865:10)
    at TracingChannel.tracePromise (node:diagnostics_channel:362:14) {
  code: 'ERR_MODULE_NOT_FOUND',
  url: 'file:///project/docs/scripts/does-not-exist.ts'
}`;

    const cleaned = cleanStackTrace(rawTrace, tmpPath, realPath, lineOffset);
    expect(cleaned).toBe(
      `Error [ERR_MODULE_NOT_FOUND]: Cannot find module './does-not-exist' imported from ${realPath}:6:4 {\n  code: 'ERR_MODULE_NOT_FOUND',\n  url: 'file:///project/docs/scripts/does-not-exist.ts'\n}`,
    );
  });
});
