import { afterEach, describe, expect, it } from "vitest";
import type { TypeScriptFeatureQuery } from "./typescript-features.js";
import { TypeScriptProject, TypeScriptProjects } from "./typescript-service.js";
import {
  BASCIK_TYPES_PATHS,
  createFixture,
  type Fixture,
  NODE_TYPES_DIR,
  offsetOf,
  TYPESCRIPT_7_DIR,
  typescript6 as ts,
} from "./typescript.test.util.js";

const fixtures: Fixture[] = [];
const registry = ts.createDocumentRegistry();
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.remove();
});

const FROTHER = `/** A Milk frother's settings. */
export interface Frother {
  /** Revolutions per minute. */
  speed: number;
  label: string;
}

export const frother: Frother = { speed: 1200, label: "Milk frother" };

/** Froths milk at a level from 1 to 3. */
export function froth(level: number, foam = true): string {
  return foam ? "foam".repeat(level) : "";
}
`;

const STEAM = "export const steamTemperature = 65;\n";

/** A project with two helpers: `src/lib/frother.ts` (imported through `@/`) and `src/lib/steam.ts` (relative). */
function project(extra: Record<string, string> = {}): {
  root: Fixture;
  service: TypeScriptProject;
} {
  const root = createFixture({
    "tsconfig.json": JSON.stringify({
      compilerOptions: { paths: BASCIK_TYPES_PATHS },
    }),
    "src/lib/frother.ts": FROTHER,
    "src/lib/steam.ts": STEAM,
    ...extra,
  });
  fixtures.push(root);
  const service = new TypeScriptProject({
    ts,
    projectRoot: root.root,
    importRoot: root.file("src"),
    registry,
  });
  return { root, service };
}

const PAGE = `<!doctype html>
<main>Milk frother</main>
<script type="text/typescript">
  import { frother, froth } from "@/lib/frother.ts";
  import { steamTemperature } from "../lib/steam.ts";
  const rpm: number = frother.speed + steamTemperature;
  function warm(degrees: number): number {
    return degrees + rpm;
  }
  warm(froth(2).length);
  document.title = frother.label;
</script>
<script>
  const plainName = "not TypeScript";
</script>
`;

/** Asks the project a feature at `needle` (plus `delta`) in `html`, written to `src/pages/index.html`. */
function ask<K extends TypeScriptFeatureQuery["kind"]>(
  setup: { root: Fixture; service: TypeScriptProject },
  html: string,
  kind: K,
  needle: string,
  delta = 0,
  options: Omit<Partial<TypeScriptFeatureQuery>, "kind" | "offset"> = {},
  pageOptions: { isolatedClientBlocks?: boolean } = {},
) {
  const htmlPath = setup.root.write("src/pages/index.html", html);
  return setup.service.feature(htmlPath, html, pageOptions, {
    ...options,
    kind,
    offset: offsetOf(html, needle, delta),
  });
}

const names = (entries: { name: string }[] | undefined) =>
  (entries ?? []).map((entry) => entry.name);

describe("TypeScript language features for a client without its own TypeScript mode", () => {
  it("hovers a symbol imported through @/ with its type and documentation, over the name's range", () => {
    const setup = project();
    const hover = ask(setup, PAGE, "hover", "froth(2)", 1);
    expect(hover?.markdown).toContain(
      "froth(level: number, foam?: boolean): string",
    );
    expect(hover?.markdown).toContain("Froths milk at a level from 1 to 3.");
    expect(PAGE.slice(hover!.start, hover!.end)).toBe("froth");
  });

  it("hovers names the page declares itself", () => {
    const setup = project();
    const hover = ask(setup, PAGE, "hover", "rpm;", 0);
    expect(hover?.markdown).toContain("const rpm: number");
  });

  it("goes to the definition in @/lib and in ../lib", () => {
    const setup = project();
    const [froth] = ask(setup, PAGE, "definition", "froth(2)", 1) ?? [];
    expect(froth).toEqual({
      fsPath: setup.root.file("src/lib/frother.ts"),
      start: { line: 10, character: 16 },
      end: { line: 10, character: 21 },
    });
    const [steam] =
      ask(setup, PAGE, "definition", "steamTemperature;", 2) ?? [];
    expect(steam?.fsPath).toBe(setup.root.file("src/lib/steam.ts"));
    expect(steam?.start).toEqual({ line: 0, character: 13 });
  });

  it("goes from an import path to the file", () => {
    const setup = project();
    const [file] = ask(setup, PAGE, "definition", "/lib/frother.ts", 3) ?? [];
    expect(file?.fsPath).toBe(setup.root.file("src/lib/frother.ts"));
  });

  it("goes to a name the page declares, in the HTML", () => {
    const setup = project();
    const [warm] = ask(setup, PAGE, "definition", "warm(froth", 1) ?? [];
    expect(warm?.fsPath).toBe(setup.root.file("src/pages/index.html"));
    // `function warm(` is on line 6 of the page.
    expect(warm?.start).toEqual({ line: 6, character: 11 });
  });

  it("completes the members of an imported object, with their types", () => {
    const setup = project();
    const html = PAGE.replace("frother.speed", "frother.sp");
    const entries = ask(setup, html, "completion", "frother.sp", 8);
    expect(names(entries)).toEqual(expect.arrayContaining(["speed", "label"]));
    const speed = entries?.find((entry) => entry.name === "speed");
    expect(speed?.detail).toContain("(property) Frother.speed: number");
    expect(speed?.documentation).toBe("Revolutions per minute.");
  });

  it("completes members while the block does not parse (a dot just typed)", () => {
    const setup = project();
    const html = PAGE.replace(
      "document.title = frother.label;",
      "const settings = frother.",
    );
    const entries = ask(setup, html, "completion", "frother.\n", 8, {
      triggerCharacter: ".",
    });
    expect(names(entries)).toEqual(expect.arrayContaining(["speed", "label"]));
  });

  it("completes import paths under @/ and relative ones, with their extension", () => {
    const setup = project();
    const aliased = PAGE.replace('"@/lib/frother.ts"', '"@/lib/"');
    const entries = ask(setup, aliased, "completion", '"@/lib/"', 7, {
      triggerCharacter: "/",
    });
    expect(names(entries)).toEqual(
      expect.arrayContaining(["frother.ts", "steam.ts"]),
    );
    const frother = entries!.find((entry) => entry.name === "frother.ts")!;
    // The replacement is the path segment being typed, inside the quotes.
    expect(frother.replacement?.start).toBe(frother.replacement?.end);
    const relative = PAGE.replace('"../lib/steam.ts"', '"../lib/s"');
    const relativeEntries = ask(setup, relative, "completion", '"../lib/s"', 9);
    expect(names(relativeEntries)).toContain("steam.ts");
  });

  it("gives the signature of an imported function, with the active parameter", () => {
    const setup = project();
    const html = PAGE.replace("froth(2)", "froth(2, )");
    const help = ask(setup, html, "signatureHelp", "froth(2, )", 9);
    expect(help?.signatures[0].label).toBe(
      "froth(level: number, foam?: boolean): string",
    );
    expect(help?.activeParameter).toBe(1);
    const [start, end] = help!.signatures[0].parameters[1].label;
    expect(help!.signatures[0].label.slice(start, end)).toBe("foam?: boolean");
    expect(help?.signatures[0].documentation).toBe(
      "Froths milk at a level from 1 to 3.",
    );
  });

  it("answers nothing outside the TypeScript blocks: markup, a plain script, the open tag", () => {
    const setup = project();
    expect(ask(setup, PAGE, "hover", "Milk frother</main>", 2)).toBeUndefined();
    expect(ask(setup, PAGE, "hover", "plainName", 2)).toBeUndefined();
    expect(ask(setup, PAGE, "definition", "plainName", 2)).toBeUndefined();
    expect(
      ask(setup, PAGE, "completion", 'type="text/typescript"', 7),
    ).toBeUndefined();
  });

  it("answers nothing at an offset outside the text, and never throws", () => {
    const setup = project();
    const htmlPath = setup.root.write("src/pages/index.html", PAGE);
    for (const offset of [-5, PAGE.length + 10, Number.NaN])
      expect(
        setup.service.feature(htmlPath, PAGE, {}, { kind: "hover", offset }),
      ).toBeUndefined();
  });

  it("never offers Bascik's own names, and never points into Bascik's footer", () => {
    const setup = project();
    const html = PAGE.replace(
      "document.title = frother.label;",
      "document.title = plainName;\n  ",
    );
    const entries = ask(setup, html, "completion", "plainName;\n  ", 13);
    expect(names(entries).some((name) => /^__bascik/i.test(name))).toBe(false);
    // The plain script's name is known (declared by Bascik in the footer), but has no place to go to.
    expect(names(entries)).toContain("plainName");
    expect(ask(setup, html, "definition", "plainName;", 2)).toEqual([]);
  });

  it("answers in a component's isolated blocks", () => {
    const setup = project();
    const html =
      '<button>Froth</button>\n<script type="text/typescript">\n  import { froth } from "@/lib/frother.ts";\n  froth(1);\n</script>\n';
    const htmlPath = setup.root.write("src/components/froth-button.html", html);
    const hover = setup.service.feature(
      htmlPath,
      html,
      { isolatedClientBlocks: true },
      { kind: "hover", offset: offsetOf(html, "froth(1)", 1) },
    );
    expect(hover?.markdown).toContain("froth(level: number");
  });
});

describe("TypeScript language features beside an editor's own in-file TypeScript mode", () => {
  const crossFileOnly = { crossFileOnly: true };

  it("hovers imported symbols, and leaves the page's own names and the library's globals to the editor", () => {
    const setup = project();
    expect(
      ask(setup, PAGE, "hover", "froth(2)", 1, crossFileOnly)?.markdown,
    ).toContain("froth(level: number");
    expect(
      ask(setup, PAGE, "hover", "frother.speed", 1, crossFileOnly)?.markdown,
    ).toContain("const frother: Frother");
    expect(ask(setup, PAGE, "hover", "rpm;", 0, crossFileOnly)).toBeUndefined();
    expect(
      ask(setup, PAGE, "hover", "document.title", 1, crossFileOnly),
    ).toBeUndefined();
    expect(
      ask(setup, PAGE, "hover", "warm(froth", 1, crossFileOnly),
    ).toBeUndefined();
  });

  it("hovers a page name whose type comes from another file, which the editor sees as any", () => {
    const setup = project();
    const html = PAGE.replace(
      "const rpm: number",
      "const settings = frother;\n  const rpm: number",
    );
    expect(
      ask(setup, html, "hover", "settings =", 1, crossFileOnly)?.markdown,
    ).toContain("const settings: Frother");
  });

  it("goes to definitions in other files only", () => {
    const setup = project();
    expect(
      ask(setup, PAGE, "definition", "froth(2)", 1, crossFileOnly)?.[0]?.fsPath,
    ).toBe(setup.root.file("src/lib/frother.ts"));
    expect(
      ask(setup, PAGE, "definition", "../lib/steam.ts", 3, crossFileOnly)?.[0]
        ?.fsPath,
    ).toBe(setup.root.file("src/lib/steam.ts"));
    expect(
      ask(setup, PAGE, "definition", "warm(froth", 1, crossFileOnly),
    ).toEqual([]);
    expect(
      ask(setup, PAGE, "definition", "document.title", 1, crossFileOnly),
    ).toEqual([]);
  });

  it("completes an imported object's members, and no name the editor already offers", () => {
    const setup = project();
    const member = PAGE.replace("frother.speed", "frother.sp");
    expect(
      names(ask(setup, member, "completion", "frother.sp", 8, crossFileOnly)),
    ).toEqual(expect.arrayContaining(["speed", "label"]));
    // A statement start: the page's names, its imports and the DOM's globals are the editor's to offer.
    const statement = PAGE.replace(
      "document.title = frother.label;",
      "document.title = frother.label;\n  w",
    );
    const global = names(
      ask(setup, statement, "completion", "label;\n  w", 10, crossFileOnly),
    );
    for (const name of ["warm", "rpm", "frother", "document", "window"])
      expect(global).not.toContain(name);
    // The page's own object: its members are the editor's too.
    const local = PAGE.replace(
      "document.title = frother.label;",
      "const jug = { size: 1 };\n  jug.s",
    );
    expect(ask(setup, local, "completion", "jug.s", 4, crossFileOnly)).toEqual(
      [],
    );
  });

  it("completes import paths, which the editor cannot", () => {
    const setup = project();
    const html = PAGE.replace('"@/lib/frother.ts"', '"@/lib/"');
    expect(
      names(
        ask(setup, html, "completion", '"@/lib/"', 7, {
          ...crossFileOnly,
          triggerCharacter: "/",
        }),
      ),
    ).toEqual(expect.arrayContaining(["frother.ts", "steam.ts"]));
  });

  it("answers everything in a block VS Code does not embed as TypeScript (its type not quoted and lowercase)", () => {
    const setup = project();
    for (const type of [
      '"text/TypeScript"',
      "text/typescript",
      '" text/typescript"',
      'TYPE="text/typescript"',
    ]) {
      const attribute = type.startsWith("TYPE") ? type : `type=${type}`;
      const html = PAGE.replace(
        '<script type="text/typescript">',
        `<script ${attribute}>`,
      ).replace(
        "document.title = frother.label;",
        "const jug = { size: 1 };\n  jug.",
      );
      expect(
        ask(setup, html, "hover", "rpm;", 0, crossFileOnly)?.markdown,
      ).toContain("const rpm: number");
      expect(
        names(
          ask(setup, html, "completion", "jug.", 4, {
            ...crossFileOnly,
            triggerCharacter: ".",
          }),
        ),
      ).toContain("size");
    }
  });

  it("gives signatures of imported functions only", () => {
    const setup = project();
    const html = PAGE.replace("froth(2)", "froth(2, )");
    expect(
      ask(setup, html, "signatureHelp", "froth(2, )", 9, crossFileOnly)
        ?.signatures[0].label,
    ).toContain("froth(level: number");
    const local = PAGE.replace("warm(froth(2).length)", "warm()");
    expect(
      ask(setup, local, "signatureHelp", "warm()", 5, crossFileOnly),
    ).toBeUndefined();
  });

  it("hovers what a server script gets from @bascik/bascik and @types/node", () => {
    const setup = project();
    setup.root.link("node_modules/@types/node", NODE_TYPES_DIR);
    const service = new TypeScriptProject({
      ts,
      projectRoot: setup.root.root,
      importRoot: setup.root.file("src"),
      registry,
    });
    const html =
      '<script type="text/typescript" data-bascik-server>\n  export default async function (request, context) {\n    return process.cwd() + context.remoteIp;\n  }\n</script>\n';
    const parameter = ask(
      { root: setup.root, service },
      html,
      "hover",
      "+ context",
      2,
      crossFileOnly,
    );
    expect(parameter?.markdown).toContain("context: ServerScriptContext");
    expect(
      ask(
        { root: setup.root, service },
        html,
        "hover",
        "process.cwd",
        1,
        crossFileOnly,
      )?.markdown,
    ).toContain("process");
  });

  // VS Code's in-file mode ignores Bascik's directives: every block gets lib.es2020.full (the DOM), so Node globals
  // the DOM also declares (console, setTimeout, fetch, URL, Response) are answered there already.
  describe("a server script in a project with @types/node", () => {
    const SERVER = `<script type="text/typescript" data-bascik-server>
  import { froth } from "@/lib/frother.ts";
  export default async function (request, context) {
    console.log(froth(1), process.cwd());
    setTimeout(() => {}, 1);
    const url = new URL(request.url);
    const reply = await fetch(url);
    return url.pathname + reply.status + context.remoteIp;
  }
</script>
`;
    function serverProject() {
      const setup = project();
      setup.root.link("node_modules/@types/node", NODE_TYPES_DIR);
      const service = new TypeScriptProject({
        ts,
        projectRoot: setup.root.root,
        importRoot: setup.root.file("src"),
        registry,
      });
      return { root: setup.root, service };
    }

    it("leaves globals the editor's DOM library declares to the editor, and answers Node's own", () => {
      const setup = serverProject();
      for (const [needle, delta] of [
        ["console.log", 1],
        ["setTimeout(", 1],
        ["new URL", 5],
        ["fetch(url", 1],
      ] as const) {
        expect(
          ask(setup, SERVER, "hover", needle, delta, crossFileOnly),
          needle,
        ).toBeUndefined();
        expect(
          ask(setup, SERVER, "definition", needle, delta, crossFileOnly),
          needle,
        ).toEqual([]);
      }
      expect(
        ask(setup, SERVER, "hover", "process.cwd", 1, crossFileOnly)?.markdown,
      ).toContain("process");
      expect(
        ask(setup, SERVER, "definition", "process.cwd", 1, crossFileOnly)
          ?.length,
      ).toBeGreaterThan(0);
    });

    it("leaves members of values the editor types itself to the editor", () => {
      const setup = serverProject();
      // console.log and url.pathname: the editor knows console and URL.
      expect(
        ask(setup, SERVER, "hover", "log(froth", 1, crossFileOnly),
      ).toBeUndefined();
      expect(
        ask(setup, SERVER, "hover", "pathname", 1, crossFileOnly),
      ).toBeUndefined();
      expect(
        ask(setup, SERVER, "hover", "url = new", 1, crossFileOnly),
      ).toBeUndefined();
      // request and context are untyped to the editor: Bascik's footer gives them their types.
      expect(
        ask(setup, SERVER, "hover", "request.url", 9, crossFileOnly)?.markdown,
      ).toContain("url");
      expect(
        ask(setup, SERVER, "hover", "context.remoteIp", 1, crossFileOnly)
          ?.markdown,
      ).toContain("ServerScriptContext");
      expect(
        ask(setup, SERVER, "hover", "cwd()", 1, crossFileOnly)?.markdown,
      ).toContain("cwd");
    });

    it("completes only the globals and members the editor does not offer", () => {
      const setup = serverProject();
      const statement = SERVER.replace(
        "setTimeout(() => {}, 1);",
        "setTimeout(() => {}, 1);\n    con",
      );
      const globals = names(
        ask(setup, statement, "completion", "\n    con\n", 8, crossFileOnly),
      );
      for (const name of ["console", "setTimeout", "fetch", "URL", "Response"])
        expect(globals).not.toContain(name);
      for (const name of ["process", "Buffer"]) expect(globals).toContain(name);
      const consoleMembers = SERVER.replace(
        "setTimeout(() => {}, 1);",
        "setTimeout(() => {}, 1);\n    console.",
      );
      // The DOM's console members are the editor's; the ones only Node's console has are Bascik's.
      const members = names(
        ask(setup, consoleMembers, "completion", "\n    console.\n", 13, {
          ...crossFileOnly,
          triggerCharacter: ".",
        }),
      );
      for (const name of ["log", "error", "warn", "table"])
        expect(members).not.toContain(name);
      expect(members).toContain("Console");
      const processMembers = SERVER.replace(
        "setTimeout(() => {}, 1);",
        "setTimeout(() => {}, 1);\n    process.",
      );
      expect(
        names(
          ask(setup, processMembers, "completion", "\n    process.\n", 13, {
            ...crossFileOnly,
            triggerCharacter: ".",
          }),
        ),
      ).toContain("cwd");
    });

    it("gives signatures only for calls the editor cannot resolve", () => {
      const setup = serverProject();
      const html = SERVER.replace("setTimeout(() => {}, 1);", "setTimeout();");
      expect(
        ask(setup, html, "signatureHelp", "setTimeout()", 11, crossFileOnly),
      ).toBeUndefined();
      const imported = SERVER.replace("froth(1)", "froth()");
      expect(
        ask(setup, imported, "signatureHelp", "froth()", 6, crossFileOnly)
          ?.signatures[0].label,
      ).toContain("froth(level: number");
    });
  });
});

describe("TypeScriptProjects language features", () => {
  it("is unavailable without a usable TypeScript, and says why", () => {
    const root = createFixture({ "src/pages/index.html": PAGE });
    fixtures.push(root);
    const projects = new TypeScriptProjects({
      clientPath: TYPESCRIPT_7_DIR,
      fallbackFrom: root.root,
    });
    const result = projects.feature(
      {
        projectRoot: root.root,
        importRoot: root.file("src"),
        htmlPath: root.file("src/pages/index.html"),
        text: PAGE,
      },
      { kind: "hover", offset: offsetOf(PAGE, "rpm") },
    );
    expect(result.status).toBe("unavailable");
    projects.dispose();
  });

  it("stops a feature request that went stale", () => {
    const root = createFixture({
      "src/lib/frother.ts": FROTHER,
      "src/pages/index.html": PAGE,
    });
    fixtures.push(root);
    const projects = new TypeScriptProjects({
      resolve: () => ({
        ok: true,
        ts,
        version: ts.version,
        packageDir: "typescript-6",
        source: "client",
        skipped: [],
      }),
      isCancellationRequested: () => true,
    });
    const result = projects.feature(
      {
        projectRoot: root.root,
        importRoot: root.file("src"),
        htmlPath: root.file("src/pages/index.html"),
        text: PAGE,
      },
      { kind: "completion", offset: offsetOf(PAGE, "frother.speed", 8) },
    );
    expect(result).toEqual({ status: "cancelled" });
    projects.dispose();
  });
});
