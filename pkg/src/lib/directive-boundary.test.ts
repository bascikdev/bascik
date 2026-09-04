/**
 * Prompt 65 step 0: directive attributes match only as WHOLE attribute names.
 *
 * `\sdata-bascik-server\b` is satisfied between `r` and `-` (hyphen is a
 * non-word character), so it also matched `data-bascik-server-id`,
 * `data-bascik-server-foo`, and any hyphen-suffixed variant. The dangerous
 * consequence: re-extracting HTML that already contains a sidecar placeholder
 * re-extracted the placeholder itself and stamped an unresolvable id.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import fc from "fast-check";

vi.mock("./config.js", () => ({
  BascikConfig: {
    scripts: { onServerScriptError: "error", timeout: 30000 },
    directory: { out: "dist", pages: "src/pages", components: ["src/components"] },
    minify: { html: false, css: false, js: false, identifiers: false },
    scoping: { attributes: { class: true, id: true, name: true }, deduplicateCss: true, preserve: ["code"], scriptBlocks: true },
    isBuild: false,
  },
  shouldLog: () => false,
}));

import { htmlHasServerScripts, executeServerScripts } from "./server-scripts.ts";
import { extractServerScriptsToSidecar, serverSidecarRegistry } from "./server-sidecar.ts";
import { SERVER_ATTR_NAME, BUILD_ATTR_NAME, ROUTES_ATTR_NAME, STREAM_ATTR_NAME, SERVER_FLAG } from "./html-patterns.ts";
import { minifyHtml } from "./html-minifier.ts";
import { namespaceScriptTags } from "./javascript.ts";

const baseRequest = new Request("http://localhost/");
const baseContext = { remoteIp: "127.0.0.1" };

beforeEach(() => {
  serverSidecarRegistry.clear();
});

describe("server-script regexes treat hyphen-suffixed attributes as unrelated", () => {
  it("htmlHasServerScripts (string path) is false for data-bascik-server-foo", () => {
    expect(htmlHasServerScripts("<script data-bascik-server-foo>x</script>")).toBe(false);
  });

  it("re-extracting placeholdered HTML is a no-op and records nothing", () => {
    const first = extractServerScriptsToSidecar("<p>a</p><script data-bascik-server>return 'x';</script>", "pages/x.html");
    expect(first).toMatch(/type="text\/bascik-server" data-bascik-server-id="server_script_[0-9a-f]+"/);
    const recordedBefore = Object.keys(serverSidecarRegistry.getAllScripts());
    expect(recordedBefore).toHaveLength(1);

    const sourceBefore = serverSidecarRegistry.getScript(recordedBefore[0])!.source;

    const second = extractServerScriptsToSidecar(first, "pages/x.html");
    expect(second).toBe(first);
    expect(Object.keys(serverSidecarRegistry.getAllScripts())).toEqual(recordedBefore);
    // The re-run must not have re-recorded the placeholder's EMPTY body over
    // the real source (ids are deterministic per page+ordinal, so a key-set
    // comparison alone cannot catch that).
    expect(serverSidecarRegistry.getScript(recordedBefore[0])!.source).toBe(sourceBefore);
    expect(sourceBefore).toBe("return 'x';");
  });

  it("executeServerScripts leaves a bare data-bascik-server-id script (no placeholder type) untouched", async () => {
    const html = '<script data-bascik-server-id="x">y</script>';
    expect(await executeServerScripts(html, baseRequest, baseContext)).toBe(html);
  });

  it("html-minifier treats a hyphen-suffixed script as an ordinary client script (hoisted out of its container)", () => {
    const out = minifyHtml('<div><script data-bascik-server-anything>var a = 1;</script></div>');
    // Ordinary client scripts are hoisted to the end of the document; a real
    // directive script is left in place. Compare against both controls.
    expect(out.startsWith("<div></div>")).toBe(true);
    expect(minifyHtml('<div><script data-bascik-server>var a = 1;</script></div>').startsWith("<div><script")).toBe(true);
  });

  it("javascript scoping treats a hyphen-suffixed script as an ordinary client script", () => {
    const component = {
      name: "my-comp",
      fileContent: '<div><script data-bascik-server-anything>document.getElementById("x");</script></div>',
    } as any;
    const out = namespaceScriptTags(component).fileContent as string;
    expect(out).toContain("(function() {");
  });
});

describe("whole-attribute-name patterns", () => {
  const cases: [string, string][] = [
    ["server", SERVER_ATTR_NAME],
    ["build", BUILD_ATTR_NAME],
    ["routes", ROUTES_ATTR_NAME],
    ["stream", STREAM_ATTR_NAME],
  ];
  for (const [name, source] of cases) {
    it(`${name}: matches the bare attribute followed by space, =, /, or > and never a suffixed variant`, () => {
      const re = new RegExp(`\\s${source}`, "i");
      expect(re.test(`<script data-bascik-${name}>`)).toBe(true);
      expect(re.test(`<script data-bascik-${name} type="x">`)).toBe(true);
      expect(re.test(`<script data-bascik-${name}="page">`)).toBe(true);
      expect(re.test(`<script data-bascik-${name}/>`)).toBe(true);
      fc.assert(
        fc.property(fc.stringMatching(/^[a-z0-9-]+$/), (suffix) => {
          expect(re.test(`<script data-bascik-${name}-${suffix}>`)).toBe(false);
        }),
        { numRuns: 200 },
      );
    });
  }

  it("SERVER_FLAG (with optional =value) still rejects a suffixed variant when required to be followed by space or >", () => {
    const re = new RegExp(`\\s${SERVER_FLAG}(?=[\\s>])`, "i");
    expect(re.test("<script data-bascik-server>")).toBe(true);
    expect(re.test("<script data-bascik-server-id=\"a\">")).toBe(false);
  });
});
