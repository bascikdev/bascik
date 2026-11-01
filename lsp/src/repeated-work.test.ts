/**
 * Work the linter must not repeat (Collin 2026-10-31): after the markup
 * rules reached build code and Node modules, `bascik --check` on the docs
 * site took twice as long, mostly from scanning the same text again. A
 * module walk reads each module once per reach, `--check` walks twice and
 * the language server walks after every module write, and one script was
 * scanned by four passes in turn. These tests count the calls, so a change
 * that brings the repeats back fails here rather than only in a profile.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const spies = vi.hoisted(() => ({
  findModuleSpecifiers: vi.fn(),
  findBindingRanges: vi.fn(),
  findBindings: vi.fn(),
}));

vi.mock("./module-specifiers.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./module-specifiers.js")>();
  spies.findModuleSpecifiers.mockImplementation(actual.findModuleSpecifiers);
  return { ...actual, findModuleSpecifiers: spies.findModuleSpecifiers };
});
vi.mock("./server-script-templates.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./server-script-templates.js")>();
  spies.findBindingRanges.mockImplementation(actual.findBindingRanges);
  spies.findBindings.mockImplementation(actual.findBindings);
  return {
    ...actual,
    findBindingRanges: spies.findBindingRanges,
    findBindings: spies.findBindings,
  };
});

const { scanJavaScript } = await import("./module-specifiers.js");
const { findScriptModules } = await import("./script-modules.js");
const { analyzeServerScriptSource } = await import("./server-script-rules.js");

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bascik-repeated-work-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("work the linter does once", () => {
  it("a module three kinds of script import, walked twice, is scanned for imports once", () => {
    const lib = path.join(root, "src/lib/shared-once.ts");
    fs.mkdirSync(path.dirname(lib), { recursive: true });
    // A text no other test uses, so an earlier scan of it cannot hide a repeat.
    const libText = `export const sharedOnce = ${Date.now()};\n`;
    fs.writeFileSync(lib, libText);
    const page = path.join(root, "src/pages/index.html");
    const html: [string, string][] = [
      [
        page,
        [
          `<script data-bascik-build>import { sharedOnce } from "../lib/shared-once.ts";</script>`,
          `<script data-bascik-server>import { sharedOnce } from "../lib/shared-once.ts"; export default () => "";</script>`,
          `<script type="module">import { sharedOnce } from "../lib/shared-once.ts";</script>`,
        ].join("\n"),
      ],
    ];
    const walk = () =>
      findScriptModules({
        projectRoot: root,
        importRoot: path.join(root, "src"),
        html,
      });
    const first = walk();
    const second = walk();
    expect([...first].some((f) => f.endsWith("shared-once.ts"))).toBe(true);
    expect(second.requestTime.size).toBe(first.requestTime.size);
    const scansOfLib = spies.findModuleSpecifiers.mock.calls.filter(
      ([text]) => text === libText,
    );
    expect(scansOfLib).toHaveLength(1);
  });

  it("one script's bindings are found once per analysis", () => {
    const body = `export function card(name: string) {\n  const label = name.trim();\n  return \`<p>\${label}</p>\`;\n}\n`;
    const diags = analyzeServerScriptSource(body, {
      hasSrcAttribute: false,
      directive: "module",
    });
    expect(diags.map((d) => d.code)).toEqual([
      "server-script-unescaped-markup",
    ]);
    expect(spies.findBindingRanges).toHaveBeenCalledTimes(1);
    // findBindings is handed those ranges rather than finding them again.
    const ranges = spies.findBindingRanges.mock.results[0].value;
    expect(spies.findBindings.mock.calls).toEqual([[body, ranges]]);
  });

  it("build-time code with no markup template skips the template passes", () => {
    const body = `export const usage = \`bascik --out \${process.argv[2]}\`;\nexport const add = (a: number, b: number) => a + b;\n`;
    expect(
      analyzeServerScriptSource(body, {
        hasSrcAttribute: false,
        directive: "module",
      }),
    ).toEqual([]);
    expect(spies.findBindingRanges).not.toHaveBeenCalled();
  });

  it("request-time code with no `<` still gets the fragment sink rules", () => {
    const body = `export default (request: Request) => \` href="\${new URL(request.url).searchParams.get("u")}"\`;\n`;
    expect(
      analyzeServerScriptSource(body, {
        hasSrcAttribute: false,
        directive: "server",
      }).map((d) => d.code),
    ).toContain("server-script-sink-url-attribute");
  });

  it("the same text scanned twice shares one scan", () => {
    const text = `const x = ${Date.now()};\n`;
    expect(scanJavaScript(text)).toBe(scanJavaScript(`${text}`));
  });
});
