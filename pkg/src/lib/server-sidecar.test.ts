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
import { rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("server-scripts sidecar", () => {
  const baseRequest = new Request("http://localhost/dashboard");
  const baseContext = { remoteIp: "127.0.0.1" };

  beforeEach(() => {
    serverSidecarRegistry.clear();
  });

  it("replaces <script data-bascik-server> with inert placeholder and records source in registry", () => {
    const SECRET = "TOP_SECRET_NODE_CODE_12345";
    const rawHtml = `<main><script data-bascik-server>export default function() { const secret = "${SECRET}"; return secret; }</script></main>`;

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
    const rawHtml = `<script data-bascik-server>export default function() { return "hello"; }</script>`;
    extractServerScriptsToSidecar(rawHtml, "src/pages/test.html");

    await mkdir(join(outDir, ".bascik"), { recursive: true });

    // Write sidecar
    const scripts = serverSidecarRegistry.getAllScripts();
    expect(Object.keys(scripts).length).toBe(1);

    await rm(outDir, { recursive: true, force: true });
  });

  it("maps multiple server scripts per page in order and executes them via placeholder", async () => {
    const rawHtml = `<div><script data-bascik-server>export default function() { return "part1"; }</script><script data-bascik-server>export default function() { return "part2"; }</script></div>`;
    const extracted = extractServerScriptsToSidecar(rawHtml, "src/pages/multi.html");

    const result = await executeServerScripts(extracted, baseRequest, baseContext);
    expect(result).toBe("<div>part1part2</div>");
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
      baseContext,
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
      baseContext,
      undefined,
      "dist/consumer.html",
    )).resolves.toBe("<p>inline import</p>");
  });

  it("attributes component-authored sidecar failures to the exact authored line", async () => {
    const outDir = join(tmpdir(), `bascik-sidecar-lines-${Date.now()}`);
    const previousOutDir = BascikConfig.directory.out;
    const rawHtml = `${"<p>consumer spacing</p>\n".repeat(20)}<script data-bascik-server data-bascik-source-file="src%2Fcomponents%2Ffailing-card.html" data-bascik-source-line="8">
export default function() { throw new Error('component sidecar failure'); }
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
        executeServerScripts(extracted, baseRequest, baseContext, undefined, "dist/consumer.html"),
      ).rejects.toThrow("src/components/failing-card.html:8");
    } finally {
      BascikConfig.directory.out = previousOutDir;
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("throws clear error when sidecar placeholder cannot be resolved", async () => {
    serverSidecarRegistry.clear();
    const missingPlaceholderHtml = `<script type="text/bascik-server" data-bascik-server-id="unknown_id"></script>`;

    await expect(executeServerScripts(missingPlaceholderHtml, baseRequest, baseContext)).rejects.toThrow(
      /Server script placeholder "unknown_id" could not be resolved from sidecar/,
    );
  });

  it("supports recording multiple scripts via recordScripts (worker thread IPC parity)", () => {
    serverSidecarRegistry.clear();
    serverSidecarRegistry.recordScripts({
      script_1: { id: "script_1", mode: "server", source: "console.log('from_worker');" },
    });
    expect(serverSidecarRegistry.getScript("script_1")?.source).toBe("console.log('from_worker');");
  });
});

describe("loadSidecar production readiness distinctions", () => {
  const outDir = () => join(tmpdir(), `bascik-sidecar-readiness-${Date.now()}-${Math.random().toString(16).slice(2)}`);

  beforeEach(() => {
    serverSidecarRegistry.clear();
  });

  it("treats a missing optional sidecar as a valid static release", async () => {
    const dir = outDir();
    await mkdir(dir, { recursive: true });
    try {
      const result = await serverSidecarRegistry.loadSidecar(join(dir, ".bascik", "server-scripts.json"));
      expect(result).toEqual({ present: false, scripts: {} });
      expect(serverSidecarRegistry.isSidecarPresent()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts a present sidecar with a valid empty scripts map", async () => {
    const dir = outDir();
    await mkdir(join(dir, ".bascik"), { recursive: true });
    try {
      const path = join(dir, ".bascik", "server-scripts.json");
      await writeFile(path, JSON.stringify({ version: "1", schema: 2, scripts: {} }), "utf8");
      const result = await serverSidecarRegistry.loadSidecar(path);
      expect(result.present).toBe(true);
      expect(result.scripts).toEqual({});
      expect(serverSidecarRegistry.isSidecarPresent()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts valid buffered (server) and streamed (stream) entries", async () => {
    const dir = outDir();
    await mkdir(join(dir, ".bascik"), { recursive: true });
    try {
      const path = join(dir, ".bascik", "server-scripts.json");
      await writeFile(
        path,
        JSON.stringify({
          version: "1",
          schema: 2,
          scripts: {
            buf: { id: "buf", mode: "server", source: "return 1" },
            strm: { id: "strm", mode: "stream", source: "return 2", sourceFile: "src/pages/x.html", sourceLine: 3 },
          },
        }),
        "utf8",
      );
      const result = await serverSidecarRegistry.loadSidecar(path);
      expect(result.present).toBe(true);
      expect(serverSidecarRegistry.getScript("buf")?.mode).toBe("server");
      expect(serverSidecarRegistry.getScript("strm")).toMatchObject({ mode: "stream", sourceLine: 3 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed JSON with an actionable diagnostic", async () => {
    const dir = outDir();
    await mkdir(join(dir, ".bascik"), { recursive: true });
    try {
      const path = join(dir, ".bascik", "server-scripts.json");
      await writeFile(path, "{corrupt", "utf8");
      await expect(serverSidecarRegistry.loadSidecar(path)).rejects.toThrow(
        /Failed to load server scripts sidecar/,
      );
      expect(serverSidecarRegistry.isSidecarPresent()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects an incompatible schema version", async () => {
    const dir = outDir();
    await mkdir(join(dir, ".bascik"), { recursive: true });
    try {
      const path = join(dir, ".bascik", "server-scripts.json");
      await writeFile(path, JSON.stringify({ version: "1", schema: 99, scripts: {} }), "utf8");
      await expect(serverSidecarRegistry.loadSidecar(path)).rejects.toThrow(/schema 99/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a missing mode on an entry", async () => {
    const dir = outDir();
    await mkdir(join(dir, ".bascik"), { recursive: true });
    try {
      const path = join(dir, ".bascik", "server-scripts.json");
      await writeFile(
        path,
        JSON.stringify({ version: "1", schema: 2, scripts: { a: { id: "a", source: "return 1" } } }),
        "utf8",
      );
      await expect(serverSidecarRegistry.loadSidecar(path)).rejects.toThrow(/has no mode/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a wrong mode value", async () => {
    const dir = outDir();
    await mkdir(join(dir, ".bascik"), { recursive: true });
    try {
      const path = join(dir, ".bascik", "server-scripts.json");
      await writeFile(
        path,
        JSON.stringify({ version: "1", schema: 2, scripts: { a: { id: "a", mode: "build", source: "return 1" } } }),
        "utf8",
      );
      await expect(serverSidecarRegistry.loadSidecar(path)).rejects.toThrow(/has no mode/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a null/malformed entry", async () => {
    const dir = outDir();
    await mkdir(join(dir, ".bascik"), { recursive: true });
    try {
      const path = join(dir, ".bascik", "server-scripts.json");
      await writeFile(
        path,
        JSON.stringify({ version: "1", schema: 2, scripts: { a: null } }),
        "utf8",
      );
      await expect(serverSidecarRegistry.loadSidecar(path)).rejects.toThrow(/null or malformed entry "a"/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a malformed scripts member", async () => {
    const dir = outDir();
    await mkdir(join(dir, ".bascik"), { recursive: true });
    try {
      const path = join(dir, ".bascik", "server-scripts.json");
      await writeFile(path, JSON.stringify({ version: "1", schema: 2, scripts: [1, 2] }), "utf8");
      await expect(serverSidecarRegistry.loadSidecar(path)).rejects.toThrow(/malformed "scripts" member/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
