import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `BascikConfig` is frozen, so each test picks the `scoping.preserve` list through this mock.
let preserveList: string[] = ["code"];
vi.mock("./config.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config.ts")>();
  return {
    ...actual,
    BascikConfig: {
      ...actual.BascikConfig,
      scoping: {
        ...actual.BascikConfig.scoping,
        get preserve() {
          return preserveList;
        },
      },
    },
  };
});

const { listComponents } = await import("./components.ts");

describe("listComponents – selectors that only target preserved elements", () => {
  // Finding 22: a scoping.preserve tag or a data-bascik-preserve element keeps its literal class and id,
  // while the component's CSS and class queries are renamed, so a rule aimed at it silently never applies.
  const warningsFor = async (
    name: string,
    files: Record<string, string>,
    preserve?: string[],
  ): Promise<string[]> => {
    const cwd = await mkdtemp(join(tmpdir(), "bascik-ptargets-"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    preserveList = preserve ?? ["code"];
    try {
      await mkdir(join(cwd, `src/components/${name}`), { recursive: true });
      for (const [file, text] of Object.entries(files)) {
        await writeFile(join(cwd, `src/components/${name}/${file}`), text);
      }
      await listComponents([join(cwd, "src/components")]);
      return warnSpy.mock.calls
        .map((c) => c.join(" "))
        .filter((msg) => /\(\w+-preserved-target\)/.test(msg));
    } finally {
      preserveList = ["code"];
      warnSpy.mockRestore();
      await rm(cwd, { recursive: true, force: true });
    }
  };
  const located = (warnings: string[]) =>
    warnings.map((w) =>
      /\((\S+)\) in \S*?([\w-]+\.\w+:\d+)/.exec(w)?.slice(1).join(" "),
    );

  it("warns at the rule's line for a preserved tag, a descendant selector, and a class and id on it", async () => {
    const warnings = await warningsFor("code-note", {
      "code-note.html":
        '<div class="note">\n  <code class="inline" id="snippet">x</code>\n</div>\n<style>\n  code { color: red; }\n  .note code { color: red; }\n  .inline { color: red; }\n  #snippet { color: red; }\n  .note { color: blue; }\n</style>\n',
    });
    expect(located(warnings)).toEqual([
      "css-preserved-target code-note.html:5",
      "css-preserved-target code-note.html:6",
      "css-preserved-target code-note.html:7",
      "css-preserved-target code-note.html:8",
    ]);
    expect(warnings[2]).toContain('".inline"');
  });

  it("warns for a wildcard preserve entry, data-bascik-preserve, and the companion stylesheet", async () => {
    const warnings = await warningsFor(
      "chart-box",
      {
        "chart-box.html":
          '<x-chart class="chart-a"></x-chart>\n<section data-bascik-preserve="id class" id="kept-id" class="kept"><b>b</b></section>\n<style>\n  .chart-a { color: red; }\n  section .kept { color: red; }\n</style>\n',
        "chart-box.css": "\n#kept-id { color: red; }\n",
      },
      ["code", "x-*"],
    );
    expect(located(warnings)).toEqual([
      "css-preserved-target chart-box.html:4",
      // `section` and `.kept` are both preserved-only, so the line warns once for each.
      "css-preserved-target chart-box.html:5",
      "css-preserved-target chart-box.html:5",
      "css-preserved-target chart-box.css:2",
    ]);
  });

  it("warns for a client-script class query that only preserved elements answer", async () => {
    const warnings = await warningsFor("query-code", {
      "query-code.html":
        '<code class="inline" id="snippet">x</code>\n<style>\n  :where(.inline) { color: red; }\n</style>\n<script>\n  document.getElementById("snippet");\n  document.querySelector(".inline");\n</script>\n',
      "query-code.js": '\nroot.getElementsByClassName("inline");\n',
    });
    expect(located(warnings)).toEqual([
      "js-preserved-target query-code.html:7",
      "js-preserved-target query-code.js:2",
    ]);
  });

  it("stays quiet when a scoped element shares the class or tag", async () => {
    const warnings = await warningsFor("shared-class", {
      "shared-class.html":
        '<code class="shared"><span>x</span></code><em class="shared"></em><span>y</span>\n<style>\n  .shared { color: red; }\n  span { color: red; }\n</style>\n<script>\n  document.querySelector(".shared");\n</script>\n',
    });
    expect(warnings).toEqual([]);
  });
});
