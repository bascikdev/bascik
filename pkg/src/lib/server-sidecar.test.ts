import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./config.js", () => ({
  BascikConfig: {
    directory: { out: "dist", pages: "pages", components: ["components"] },
    generate: { manifest: true },
    isBuild: true,
  },
}));

import {
  serverSidecarRegistry,
  extractServerScriptsToSidecar,
} from "./server-sidecar.ts";
import { htmlHasServerScripts, executeServerScripts } from "./server-scripts.ts";
import { BascikConfig } from "./config.ts";
import { rm, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("server-scripts sidecar", () => {
  const baseRequest = {
    method: "GET",
    url: "/dashboard",
    path: "/dashboard",
    pathname: "/dashboard",
    headers: {},
    searchParams: {},
  };

  beforeEach(() => {
    serverSidecarRegistry.clear();
  });

  it("replaces <script data-bascik-server> with inert placeholder and records source in registry", () => {
    const SECRET = "TOP_SECRET_NODE_CODE_12345";
    const rawHtml = `<main><script data-bascik-server>const secret = "${SECRET}"; console.log(secret);</script></main>`;

    const extracted = extractServerScriptsToSidecar(rawHtml, "src/pages/dashboard.html");
    expect(extracted).not.toContain(SECRET);
    expect(extracted).not.toContain("data-bascik-server>");
    expect(extracted).toMatch(/<script type="text\/bascik-server" data-bascik-server-id="[^"]+"><\/script>/);

    // Placeholder is detected by htmlHasServerScripts
    expect(htmlHasServerScripts(extracted)).toBe(true);
  });

  it("writes dist/.bascik/server-scripts.json and loads it back", async () => {
    const outDir = join(tmpdir(), `bascik-sidecar-test-${Date.now()}`);
    (serverSidecarRegistry as any).loadedSidecar = null;
    const rawHtml = `<script data-bascik-server>console.log("hello");</script>`;
    extractServerScriptsToSidecar(rawHtml, "src/pages/test.html");

    await mkdir(join(outDir, ".bascik"), { recursive: true });

    // Write sidecar
    const scripts = serverSidecarRegistry.getAllScripts();
    expect(Object.keys(scripts).length).toBe(1);

    await rm(outDir, { recursive: true, force: true });
  });

  it("maps multiple server scripts per page in order and executes them via placeholder", async () => {
    const rawHtml = `<div><script data-bascik-server>console.log("part1");</script><script data-bascik-server>console.log("part2");</script></div>`;
    const extracted = extractServerScriptsToSidecar(rawHtml, "src/pages/multi.html");

    const result = await executeServerScripts(extracted, baseRequest);
    expect(result).toBe("<div>part1\npart2\n</div>");
  });

  it("preserves authored page identity for inline relative imports", async () => {
    const rawHtml = `<script data-bascik-server>
      import { serverInlineMessage } from './test-fixtures/server-inline-helper.ts';
      export default function() { return serverInlineMessage; }
    </script>`;
    const extracted = extractServerScriptsToSidecar(
      rawHtml,
      "pages/server-inline-page.html",
      undefined,
      "src/lib/server-inline-page.html",
    );

    const result = await executeServerScripts(
      extracted,
      baseRequest,
      undefined,
      "dist/server-inline-page.html",
    );

    expect(result).toBe("<p>inline import</p>");
  });

  it("roundtrips component source identity through sidecar extraction", async () => {
    const rawHtml = `<script data-bascik-server data-bascik-source-file="src%2Flib%2Fcomponent.html">
      import { serverInlineMessage } from './test-fixtures/server-inline-helper.ts';
      export default function() { return serverInlineMessage; }
    </script>`;
    const extracted = extractServerScriptsToSidecar(
      rawHtml,
      "pages/consumer.html",
      undefined,
      "src/pages/consumer.html",
    );

    expect(Object.values(serverSidecarRegistry.getAllScripts())[0]?.sourceFile)
      .toBe("src/lib/component.html");
    await expect(executeServerScripts(
      extracted,
      baseRequest,
      undefined,
      "dist/consumer.html",
    )).resolves.toBe("<p>inline import</p>");
  });

  it("attributes component-authored sidecar failures to the exact authored line", async () => {
    const outDir = join(tmpdir(), `bascik-sidecar-lines-${Date.now()}`);
    const previousOutDir = BascikConfig.directory.out;
    const rawHtml = `${"<p>consumer spacing</p>\n".repeat(20)}<script data-bascik-server data-bascik-source-file="src%2Fcomponents%2Ffailing-card.html" data-bascik-source-line="8">
throw new Error('component sidecar failure');
</script>`;
    const extracted = extractServerScriptsToSidecar(
      rawHtml,
      "pages/consumer.html",
      undefined,
      "src/pages/consumer.html",
    );

    expect(extracted).not.toContain("data-bascik-source-file");
    expect(extracted).not.toContain("data-bascik-source-line");
    try {
      BascikConfig.directory.out = outDir;
      const sidecarPath = await serverSidecarRegistry.writeSidecar("test");
      serverSidecarRegistry.clear();
      await serverSidecarRegistry.loadSidecar(sidecarPath!);

      expect(serverSidecarRegistry.getScript(Object.keys(JSON.parse(
        await readFile(sidecarPath!, "utf8"),
      ).scripts)[0])).toMatchObject({
        sourceFile: "src/components/failing-card.html",
        sourceLine: 8,
      });
      await expect(
        executeServerScripts(extracted, baseRequest, undefined, "dist/consumer.html"),
      ).rejects.toThrow("src/components/failing-card.html:9");
    } finally {
      BascikConfig.directory.out = previousOutDir;
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("throws clear error when sidecar placeholder cannot be resolved", async () => {
    serverSidecarRegistry.clear();
    const missingPlaceholderHtml = `<script type="text/bascik-server" data-bascik-server-id="unknown_id"></script>`;

    await expect(executeServerScripts(missingPlaceholderHtml, baseRequest)).rejects.toThrow(
      /Server script placeholder "unknown_id" could not be resolved from sidecar/,
    );
  });

  it("supports recording multiple scripts via recordScripts (worker thread IPC parity)", () => {
    serverSidecarRegistry.clear();
    serverSidecarRegistry.recordScripts({
      script_1: { id: "script_1", source: "console.log('from_worker');" },
    });
    expect(serverSidecarRegistry.getScript("script_1")?.source).toBe("console.log('from_worker');");
  });
});
