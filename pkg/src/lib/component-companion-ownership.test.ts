/**
 * Which script files a component claims as companions (review findings F041 and F042).
 *
 * - A module that only a directive script's `src=` references runs in Node; it is never
 *   compiled as browser TypeScript or scanned as a browser companion.
 * - In flat layout, `card` claims `card-*` / `card.*` / `card_*` extras, but not a file that
 *   belongs to a sibling component such as `card-header` (unless `card` references it).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TypeScriptCompileContext } from "./types.ts";

const { configState } = vi.hoisted(() => ({
  configState: {
    directory: { pages: "", components: [] as string[], out: "" },
    scoping: { deduplicateCss: true, preserve: [] as string[] },
    minify: { html: false, css: false, js: false, identifiers: false },
    scripts: {
      cache: { enabled: false },
      typescript: true as unknown,
    },
    logging: { level: "info" },
    base: "/",
  },
}));

vi.mock("./config.js", () => ({
  BascikConfig: configState,
  shouldLog: () => false,
}));

vi.mock("./build-scripts.js", () => ({
  executeBuildScripts: vi.fn(async (html: string) => html),
}));

import { getComponentScripts } from "./javascript.ts";
import { listComponents, invalidateComponentListCache } from "./components.ts";

let base: string;
let root: string;
let warnSpy: ReturnType<typeof vi.spyOn>;

const write = (name: string, content: string): string => {
  const path = join(root, name);
  writeFileSync(path, content);
  return path;
};

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "bascik-companions-")));
  root = join(base, "src/components");
  mkdirSync(root, { recursive: true });
  configState.directory.pages = join(base, "src/pages");
  configState.directory.out = join(base, "dist");
  configState.directory.components = [root];
  configState.scripts.typescript = true;
  invalidateComponentListCache();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  invalidateComponentListCache();
  rmSync(base, { recursive: true, force: true });
});

/** A compiler that, like esbuild with a browser target, rejects top-level await for the browser. */
const runtimeSensitiveCompiler = () => {
  const calls: TypeScriptCompileContext[] = [];
  const compiler = (code: string, context: TypeScriptCompileContext) => {
    calls.push(context);
    if (context.runtime === "browser" && /^\s*const .* = await /m.test(code))
      throw new Error(
        "Top-level await is not available in the configured target environment",
      );
    return code.replace(/: string/g, "");
  };
  return { calls, compiler };
};

const serverModule = [
  'import { readFile } from "node:fs/promises";',
  'const text: string = await readFile(new URL(import.meta.url), "utf8");',
  "export default () => `<p>${text.length}</p>`;",
].join("\n");

describe("F041: a directive script's src module is not a browser companion", () => {
  it("is never compiled with runtime browser or put in the script map", async () => {
    const { calls, compiler } = runtimeSensitiveCompiler();
    configState.scripts.typescript = compiler;
    const html =
      '<div class="card"></div>\n<script data-bascik-server src="./card.server.ts"></script>';
    const htmlPath = write("card.html", html);
    const serverPath = write("card.server.ts", serverModule);

    const res = await getComponentScripts(htmlPath, [serverPath], { html });
    expect(calls.filter((call) => call.runtime === "browser")).toEqual([]);
    expect(res.scriptMap.has("card.server.ts")).toBe(false);
  });

  it("does not fail listComponents for every component", async () => {
    const { calls, compiler } = runtimeSensitiveCompiler();
    configState.scripts.typescript = compiler;
    write(
      "card.html",
      '<div class="card"></div>\n<script data-bascik-server src="./card.server.ts"></script>',
    );
    write("card.server.ts", serverModule);
    write("other-widget.html", "<p>other</p>");

    const list = await listComponents();
    expect(Object.keys(list).sort()).toEqual(["card", "other-widget"]);
    expect(calls.filter((call) => call.runtime === "browser")).toEqual([]);
  });

  it("still compiles a file a browser <script src> references too", async () => {
    const { calls, compiler } = runtimeSensitiveCompiler();
    configState.scripts.typescript = compiler;
    const html =
      '<script data-bascik-build src="./card.shared.ts"></script><script type="module" src="./card.shared.ts"></script>';
    const htmlPath = write("card.html", html);
    const shared = write("card.shared.ts", "const label: string = 'x';\n");

    const res = await getComponentScripts(htmlPath, [shared], { html });
    expect(res.scriptMap.get("card.shared.ts")?.code).toBe(
      "const label = 'x';\n",
    );
    expect(calls).toEqual([
      {
        sourcePath: expect.stringMatching(/card\.shared\.ts$/),
        kind: "companion",
        runtime: "browser",
      },
    ]);
  });

  it("keeps the old behavior when the component HTML is not passed", async () => {
    const htmlPath = write("card.html", "");
    const serverPath = write("card.server.ts", "const a: string = 'x';\n");
    const res = await getComponentScripts(htmlPath, [serverPath]);
    expect(res.scriptMap.has("card.server.ts")).toBe(true);
  });
});

describe("F042: flat-layout matching leaves a sibling component's scripts alone", () => {
  it("does not claim card-header.ts for card when card-header.html exists", async () => {
    const card = write("card.html", '<script src="./card.ts"></script>');
    const header = write(
      "card-header.html",
      '<script src="./card-header.ts"></script>',
    );
    const scripts = [
      write("card.ts", "console.log('card');\n"),
      write("card-header.ts", "console.log('header');\n"),
      write("card-extra.js", "console.log('extra');\n"),
      write("card-header.extra.js", "console.log('header extra');\n"),
    ];
    const componentFileNames = [card, header];

    const forCard = await getComponentScripts(card, scripts, {
      componentFileNames,
    });
    expect([
      ...new Set([...forCard.scriptMap.values()].map((s) => s.relPath)),
    ]).toEqual([
      expect.stringMatching(/card\.ts$/),
      expect.stringMatching(/card-extra\.js$/),
    ]);

    const forHeader = await getComponentScripts(header, scripts, {
      componentFileNames,
    });
    expect(forHeader.scriptMap.has("card-header.ts")).toBe(true);
    expect(forHeader.scriptMap.has("card-header.extra.js")).toBe(true);
  });

  it("still claims a sibling's script that the component references by src", async () => {
    const html = '<script src="./card-header.ts"></script>';
    const card = write("card.html", html);
    const header = write("card-header.html", "<p></p>");
    const headerScript = write("card-header.ts", "console.log('header');\n");
    const res = await getComponentScripts(card, [headerScript], {
      html,
      componentFileNames: [card, header],
    });
    expect(res.scriptMap.has("card-header.ts")).toBe(true);
  });

  it("does not fail card for a TypeScript error in card-header.ts", async () => {
    const card = write("card.html", "<p>card</p>");
    const header = write("card-header.html", "<p>header</p>");
    const headerScript = write("card-header.ts", "enum E { A }\n");
    await expect(
      getComponentScripts(card, [headerScript], {
        componentFileNames: [card, header],
      }),
    ).resolves.toEqual({ scriptMap: new Map() });
  });

  it("scans card-header.ts only for card-header, so its warning prints once", async () => {
    const card = write("card.html", "<p>card</p>");
    const header = write(
      "card-header.html",
      '<div></div><script src="./card-header.ts"></script>',
    );
    write(
      "card-header.ts",
      "document.querySelector('[data-x]');\nconsole.log('header');\n",
    );
    await getComponentScripts(card, [join(root, "card-header.ts")], {
      componentFileNames: [card, header],
    }).then((res) => expect(res.scriptMap.size).toBe(0));

    await listComponents();
    const headerWarnings = warnSpy.mock.calls.filter((args: unknown[]) =>
      String(args[0]).includes("card-header.ts"),
    );
    expect(headerWarnings).toHaveLength(1);
  });
});
