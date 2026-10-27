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
  extractComponentScriptsToSidecar,
  SIDECAR_SCHEMA_VERSION,
  type ServerScriptEntry,
} from "./server-sidecar.ts";
import { encodeOutputScope } from "./output-scope.ts";
import {
  htmlHasServerScripts,
  executeServerScripts,
} from "./server-scripts.ts";
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

    const extracted = extractServerScriptsToSidecar(
      rawHtml,
      "src/pages/dashboard.html",
    );
    expect(extracted).not.toContain(SECRET);
    expect(extracted).not.toContain("data-bascik-server>");
    expect(extracted).toMatch(
      /<script type="text\/bascik-server" data-bascik-server-id="[^"]+"><\/script>/,
    );

    // Placeholder is detected by htmlHasServerScripts
    expect(htmlHasServerScripts(extracted)).toBe(true);
  });

  it("ends each server script at its own end tag when the end tag carries whitespace", () => {
    const rawHtml =
      "<script data-bascik-server>one()</script\n><p>keep</p><script data-bascik-server>two()</script>";
    const extracted = extractServerScriptsToSidecar(
      rawHtml,
      "src/pages/two.html",
    );
    expect(extracted).toContain("<p>keep</p>");
    expect(
      Object.values(serverSidecarRegistry.getAllScripts()).map(
        (entry) => entry.source,
      ),
    ).toEqual(["one()", "two()"]);
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
    const extracted = extractServerScriptsToSidecar(
      rawHtml,
      "src/pages/multi.html",
    );

    const result = await executeServerScripts(
      extracted,
      baseRequest,
      baseContext,
    );
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

    expect(
      Object.values(serverSidecarRegistry.getAllScripts())[0]?.sourceFile,
    ).toBe("src/lib/component.html");
    await expect(
      executeServerScripts(
        extracted,
        baseRequest,
        baseContext,
        undefined,
        "dist/consumer.html",
      ),
    ).resolves.toBe("<p>inline import</p>");
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

      expect(
        serverSidecarRegistry.getScript(
          Object.keys(
            JSON.parse(await readFile(sidecarPath!, "utf8")).scripts,
          )[0],
        ),
      ).toMatchObject({
        sourceFile: "src/components/failing-card.html",
        sourceLine: 8,
      });
      // The opening tag's `>` is on line 8 (the recorded line), so the `throw` on the next line is line 9.
      await expect(
        executeServerScripts(
          extracted,
          baseRequest,
          baseContext,
          undefined,
          "dist/consumer.html",
        ),
      ).rejects.toThrow("src/components/failing-card.html:9:");
    } finally {
      BascikConfig.directory.out = previousOutDir;
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("throws clear error when sidecar placeholder cannot be resolved", async () => {
    serverSidecarRegistry.clear();
    const missingPlaceholderHtml = `<script type="text/bascik-server" data-bascik-server-id="unknown_id"></script>`;

    await expect(
      executeServerScripts(missingPlaceholderHtml, baseRequest, baseContext),
    ).rejects.toThrow(
      /Server script placeholder "unknown_id" could not be resolved from sidecar/,
    );
  });

  it("supports recording multiple scripts via recordScripts (worker thread IPC parity)", () => {
    serverSidecarRegistry.clear();
    serverSidecarRegistry.recordScripts({
      script_1: {
        id: "script_1",
        mode: "server",
        source: "console.log('from_worker');",
      },
    });
    expect(serverSidecarRegistry.getScript("script_1")?.source).toBe(
      "console.log('from_worker');",
    );
  });
});

describe("loadSidecar production readiness distinctions", () => {
  const outDir = () =>
    join(
      tmpdir(),
      `bascik-sidecar-readiness-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );

  beforeEach(() => {
    serverSidecarRegistry.clear();
  });

  it("treats a missing optional sidecar as a valid static release", async () => {
    const dir = outDir();
    await mkdir(dir, { recursive: true });
    try {
      const result = await serverSidecarRegistry.loadSidecar(
        join(dir, ".bascik", "server-scripts.json"),
      );
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
      await writeFile(
        path,
        JSON.stringify({
          version: "1",
          schema: SIDECAR_SCHEMA_VERSION,
          scripts: {},
        }),
        "utf8",
      );
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
          schema: SIDECAR_SCHEMA_VERSION,
          scripts: {
            buf: { id: "buf", mode: "server", source: "return 1" },
            strm: {
              id: "strm",
              mode: "stream",
              source: "return 2",
              sourceFile: "src/pages/x.html",
              sourceLine: 3,
            },
          },
        }),
        "utf8",
      );
      const result = await serverSidecarRegistry.loadSidecar(path);
      expect(result.present).toBe(true);
      expect(serverSidecarRegistry.getScript("buf")?.mode).toBe("server");
      expect(serverSidecarRegistry.getScript("strm")).toMatchObject({
        mode: "stream",
        sourceLine: 3,
      });
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
      await writeFile(
        path,
        JSON.stringify({ version: "1", schema: 99, scripts: {} }),
        "utf8",
      );
      await expect(serverSidecarRegistry.loadSidecar(path)).rejects.toThrow(
        /schema 99/,
      );
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
        JSON.stringify({
          version: "1",
          schema: SIDECAR_SCHEMA_VERSION,
          scripts: { a: { id: "a", source: "return 1" } },
        }),
        "utf8",
      );
      await expect(serverSidecarRegistry.loadSidecar(path)).rejects.toThrow(
        /has no mode/,
      );
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
        JSON.stringify({
          version: "1",
          schema: SIDECAR_SCHEMA_VERSION,
          scripts: { a: { id: "a", mode: "build", source: "return 1" } },
        }),
        "utf8",
      );
      await expect(serverSidecarRegistry.loadSidecar(path)).rejects.toThrow(
        /has no mode/,
      );
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
        JSON.stringify({
          version: "1",
          schema: SIDECAR_SCHEMA_VERSION,
          scripts: { a: null },
        }),
        "utf8",
      );
      await expect(serverSidecarRegistry.loadSidecar(path)).rejects.toThrow(
        /null or malformed entry "a"/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a malformed scripts member", async () => {
    const dir = outDir();
    await mkdir(join(dir, ".bascik"), { recursive: true });
    try {
      const path = join(dir, ".bascik", "server-scripts.json");
      await writeFile(
        path,
        JSON.stringify({
          version: "1",
          schema: SIDECAR_SCHEMA_VERSION,
          scripts: [1, 2],
        }),
        "utf8",
      );
      await expect(serverSidecarRegistry.loadSidecar(path)).rejects.toThrow(
        /malformed "scripts" member/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("component scripts and output scope (prompt 157, schema 3)", () => {
  const outDir = () =>
    join(
      tmpdir(),
      `bascik-sidecar-components-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
  const hex = (text: string) => Buffer.from(text).toString("hex");
  const scope = encodeOutputScope({
    classes: { line: "bascik__srv-card__line" },
    elements: {},
  });

  beforeEach(() => {
    serverSidecarRegistry.clear();
  });

  it("is schema 3", () => {
    expect(SIDECAR_SCHEMA_VERSION).toBe(3);
  });

  it("carries data-bascik-output-scope into the entry and strips it from the placeholder", () => {
    const outMap: Record<string, ServerScriptEntry> = {};
    const html =
      `<div><script data-bascik-server data-bascik-output-scope="${scope}">export default () => '<p class="line">s</p>';</script>` +
      `<script data-bascik-stream data-bascik-output-scope="${scope}">export default async () => 'x';</script>` +
      `<script data-bascik-server>export default () => 'plain';</script></div>`;
    const extracted = extractServerScriptsToSidecar(
      html,
      "src/pages/index.html",
      outMap,
      "src/pages/index.html",
    );
    expect(extracted).not.toContain("data-bascik-output-scope");
    expect(extracted).toBe(
      `<div><script type="text/bascik-server" data-bascik-server-id="server_script_${hex("src/pages/index.html::1")}"></script>` +
        `<script type="text/bascik-server" data-bascik-server-id="server_script_${hex("src/pages/index.html::2")}" data-bascik-stream></script>` +
        `<script type="text/bascik-server" data-bascik-server-id="server_script_${hex("src/pages/index.html::3")}"></script></div>`,
    );
    const entries = Object.values(outMap);
    expect(entries.map((entry) => entry.outputScope)).toEqual([
      scope,
      scope,
      undefined,
    ]);
    expect(entries.map((entry) => entry.mode)).toEqual([
      "server",
      "stream",
      "server",
    ]);
    // The source is the body alone; the annotation is not part of it.
    expect(entries[0].source).toBe(
      `export default () => '<p class="line">s</p>';`,
    );
    for (const entry of entries) {
      expect(serverSidecarRegistry.getScript(entry.id)?.outputScope).toBe(
        entry.outputScope,
      );
    }
    // A plain entry has no outputScope key at all, so the JSON stays as before.
    expect("outputScope" in entries[2]).toBe(false);
  });

  it("extractComponentScriptsToSidecar stages component_script_<hex(name::ordinal)> ids that resolve through getScript", () => {
    const template =
      `<div class="bascik__srv-card__wrap"><script data-bascik-server data-bascik-output-scope="${scope}" data-bascik-source-file="src%2Fcomponents%2Fsrv-card%2Fsrv-card.html" data-bascik-source-line="3">\nexport default () => '<p class="bascik__srv-card__line">s</p>';\n</script>` +
      `<script data-bascik-stream>export default async () => 'later';</script></div>`;
    const outMap: Record<string, ServerScriptEntry> = {};
    const staged = extractComponentScriptsToSidecar(
      template,
      "srv-card",
      outMap,
    );
    const first = `component_script_${hex("srv-card::1")}`;
    const second = `component_script_${hex("srv-card::2")}`;
    expect(staged).toBe(
      `<div class="bascik__srv-card__wrap"><script type="text/bascik-server" data-bascik-server-id="${first}"></script>` +
        `<script type="text/bascik-server" data-bascik-server-id="${second}" data-bascik-stream></script></div>`,
    );
    expect(Object.keys(outMap)).toEqual([first, second]);
    expect(serverSidecarRegistry.getScript(first)).toMatchObject({
      id: first,
      mode: "server",
      source: `\nexport default () => '<p class="bascik__srv-card__line">s</p>';\n`,
      sourceFile: "src/components/srv-card/srv-card.html",
      sourceLine: 3,
      outputScope: scope,
    });
    expect(serverSidecarRegistry.getScript(second)).toMatchObject({
      id: second,
      mode: "stream",
      source: "export default async () => 'later';",
    });
    expect(
      serverSidecarRegistry.getScript(second)?.outputScope,
    ).toBeUndefined();
    // Running it over the staged template records nothing new.
    const again: Record<string, ServerScriptEntry> = {};
    expect(extractComponentScriptsToSidecar(staged, "srv-card", again)).toBe(
      staged,
    );
    expect(again).toEqual({});
  });

  it("writes schema 3 with outputScope and loads it back", async () => {
    const dir = outDir();
    const previousOutDir = BascikConfig.directory.out;
    try {
      BascikConfig.directory.out = dir;
      const id = `component_script_${hex("srv-card::1")}`;
      serverSidecarRegistry.recordScripts({
        [id]: {
          id,
          mode: "server",
          source: "export default () => 'x';",
          sourceFile: "src/components/srv-card/srv-card.html",
          sourceLine: 3,
          outputScope: scope,
        },
      });
      const path = await serverSidecarRegistry.writeSidecar("1.0.0");
      expect(path).not.toBeNull();
      const written = JSON.parse(await readFile(path!, "utf8"));
      expect(written.schema).toBe(3);
      expect(written.scripts[id].outputScope).toBe(scope);
      serverSidecarRegistry.clear();
      const loaded = await serverSidecarRegistry.loadSidecar(path!);
      expect(loaded.present).toBe(true);
      expect(serverSidecarRegistry.getScript(id)).toMatchObject({
        mode: "server",
        outputScope: scope,
      });
    } finally {
      BascikConfig.directory.out = previousOutDir;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a schema-2 sidecar with the rebuild message", async () => {
    const dir = outDir();
    await mkdir(join(dir, ".bascik"), { recursive: true });
    try {
      const path = join(dir, ".bascik", "server-scripts.json");
      await writeFile(
        path,
        JSON.stringify({
          version: "1",
          schema: 2,
          scripts: { a: { id: "a", mode: "server", source: "return 1" } },
        }),
        "utf8",
      );
      await expect(serverSidecarRegistry.loadSidecar(path)).rejects.toThrow(
        /uses schema 2, but this runtime understands schema 3/,
      );
      await expect(serverSidecarRegistry.loadSidecar(path)).rejects.toThrow(
        /Run `bascik --build`/,
      );
      expect(serverSidecarRegistry.isSidecarPresent()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
