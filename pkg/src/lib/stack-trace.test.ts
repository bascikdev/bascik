import { describe, it, expect } from "vitest";
import { cleanStackTrace } from "./stack-trace.ts";

describe("cleanStackTrace", () => {
  it("returns raw trace if trace is empty or falsy", () => {
    expect(cleanStackTrace("", "/tmp/file.mjs", "src/pages/index.html", 10)).toBe("");
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
    expect(cleaned).toBe(`Error: gen failure\n    at default (${realPath}:41:9)\n    at default (${realPath}:43:1)`);
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
    expect(cleaned).toBe(`Error [ERR_MODULE_NOT_FOUND]: Cannot find module './does-not-exist' imported from ${realPath}:6:4 {\n  code: 'ERR_MODULE_NOT_FOUND',\n  url: 'file:///project/docs/scripts/does-not-exist.ts'\n}`);
  });
});
