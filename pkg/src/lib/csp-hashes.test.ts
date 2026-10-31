import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./config.js", () => ({
  BascikConfig: {
    directory: { out: "dist", pages: "pages", components: ["components"] },
    generate: { cspHashes: true, manifest: true },
    isBuild: true,
  },
}));

import {
  __cspRegexFallbackForTests,
  computePageCspHashes,
  cspHashCollector,
  widenRouteCspHashes,
  type CspHashesManifest,
} from "./csp-hashes.ts";
import { BascikConfig } from "./config.ts";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { privateDirFor } from "./private-dir.ts";

describe("computePageCspHashes end tags", () => {
  const sha = (body: string) =>
    `sha256-${createHash("sha256").update(body, "utf8").digest("base64")}`;

  it("hashes exactly the body the browser sees for every accepted end tag spelling", () => {
    const html =
      "<script>a()</script\n><p>x</p><script>b()</script/><script>c()</script\t foo>" +
      "<style>.a{}</style ><style>.b{}</style\n>";
    const hashes = computePageCspHashes(html);
    expect(hashes.scripts).toEqual([sha("a()"), sha("b()"), sha("c()")].sort());
    expect(hashes.styles).toEqual([sha(".a{}"), sha(".b{}")].sort());
  });

  it("hashes the body after an open tag whose quoted attribute value contains >", () => {
    const hashes = computePageCspHashes(
      '<script data-x="1>2">run()</script><style media="(width > 1px)">.a{}</style>',
    );
    expect(hashes.scripts).toEqual([sha("run()")]);
    expect(hashes.styles).toEqual([sha(".a{}")]);
  });

  it("treats src and type as whole attribute names", () => {
    const hashes = computePageCspHashes(
      '<script data-src="a.js">one()</script><script data-type="text/bascik-server">two()</script>' +
        '<script src="b.js"></script><script type="text/bascik-server" data-bascik-server-id="x"></script>',
    );
    expect(hashes.scripts).toEqual([sha("one()"), sha("two()")].sort());
  });

  it("does not end a script at a lookalike tag", () => {
    expect(
      computePageCspHashes("<script>a('</scripts>')</script>").scripts,
    ).toEqual([sha("a('</scripts>')")]);
  });

  it("ignores script and style tags inside HTML comments, <textarea>, and JavaScript string literals", () => {
    const html =
      "<!-- <script>commented()</script><style>.commented{}</style> -->" +
      "<textarea><script>typed()</script><style>.typed{}</style></textarea>" +
      '<script>const s = "<style>.fake{}</style>";</script>' +
      "<style>.real{}</style>";
    const hashes = computePageCspHashes(html);
    expect(hashes.scripts).toEqual([
      sha('const s = "<style>.fake{}</style>";'),
    ]);
    expect(hashes.styles).toEqual([sha(".real{}")]);
  });

  // A script body is raw text: `<!--`, `<textarea>`, or `<title>` inside it is
  // JavaScript, not markup. Masking those before finding scripts hashed the
  // wrong bytes or dropped later scripts, so a strict CSP blocked valid code.
  it("hashes the exact body of a script whose string literals contain comment or RCDATA markup", () => {
    const bodies = [
      'const s = "<!-- x -->";',
      'el.innerHTML = "<!--";',
      'x = "<textarea>"; y = "</textarea>";',
      'a = "<title>"',
      "b()",
    ];
    const html =
      `<script>${bodies[0]}</script><script>${bodies[1]}</script>` +
      `<script>${bodies[2]}</script><script>${bodies[3]}</script>` +
      `<script>${bodies[4]}</script><title>t</title><style>.after{}</style>`;
    const hashes = computePageCspHashes(html);
    expect(hashes.scripts).toEqual(bodies.map(sha).sort());
    expect(hashes.styles).toEqual([sha(".after{}")]);
  });

  it("reads src and type the way the tokenizer does, including spaced and unquoted values", () => {
    const hashes = computePageCspHashes(
      '<script src = "a.js"></script><script SRC=b.js></script>' +
        '<script type = "text/bascik-server" data-bascik-server-id="x"></script>' +
        "<script type=text/bascik-server data-bascik-server-id=y></script>" +
        "<script type = module>inline()</script>",
    );
    expect(hashes.scripts).toEqual([sha("inline()")]);
  });

  it("hashes scripts inside <template> and SVG, and skips a script the document never closes", () => {
    const hashes = computePageCspHashes(
      "<template><script>cloned()</script></template>" +
        "<svg><script>svgRun()</script></svg>" +
        "<script>never()",
    );
    expect(hashes.scripts).toEqual([sha("cloned()"), sha("svgRun()")].sort());
  });
});

describe("computePageCspHashes line endings (F085)", () => {
  const sha = (body: string) =>
    `sha256-${createHash("sha256").update(body, "utf8").digest("base64")}`;

  // The HTML parser turns CR LF and lone CR into LF before a script or style
  // body exists, and the browser hashes that text, so a page written on
  // Windows must get the hash of the LF spelling.
  it("hashes a CRLF or lone-CR script and style as the browser does, over LF", () => {
    const lf = computePageCspHashes(
      "<script>\nconst a = 1;\nrun(a);\n</script><style>\n.a { color: red }\n</style>",
    );
    expect(lf.scripts).toEqual([sha("\nconst a = 1;\nrun(a);\n")]);
    expect(lf.styles).toEqual([sha("\n.a { color: red }\n")]);
    const crlf = computePageCspHashes(
      "<script>\r\nconst a = 1;\r\nrun(a);\r\n</script><style>\r\n.a { color: red }\r\n</style>",
    );
    const cr = computePageCspHashes(
      "<script>\rconst a = 1;\rrun(a);\r</script><style>\r.a { color: red }\r</style>",
    );
    expect(crlf).toEqual(lf);
    expect(cr).toEqual(lf);
  });

  it("misuse: mixed endings in one body (an editor that saved half the file) still hash the LF text", () => {
    const hashes = computePageCspHashes(
      "<script>a();\r\nb();\rc();\nd();\r\r\ne();</script>",
    );
    expect(hashes.scripts).toEqual([sha("a();\nb();\nc();\nd();\n\ne();")]);
  });

  it("the regex fallback normalizes the same way", () => {
    const { scripts, styles } = __cspRegexFallbackForTests(
      "<script>\r\nrun();\r\n</script><style>\r.a{}\r</style>",
    );
    expect([...scripts]).toEqual([sha("\nrun();\n")]);
    expect([...styles]).toEqual([sha("\n.a{}\n")]);
  });
});

describe("csp-hashes manifest", () => {
  beforeEach(() => {
    cspHashCollector.clear();
    (BascikConfig as any).generate.cspHashes = true;
  });

  it("generate.cspHashes: false writes no file", async () => {
    (BascikConfig as any).generate.cspHashes = false;
    const res = await cspHashCollector.writeCspHashes();
    expect(res).toBeNull();
  });

  it("generate.cspHashes: true writes .bascik/dist/csp-hashes.json with correct format and post-minification hashes", async () => {
    const outDir = join(tmpdir(), `bascik-csp-test-${Date.now()}`);
    (BascikConfig as any).directory.out = outDir;

    const html =
      `<!DOCTYPE html><html><head><style>.card{color:red;}</style></head>` +
      `<body><script>console.log("hello");</script></body></html>`;

    cspHashCollector.recordPage("/index", html);
    const writtenPath = await cspHashCollector.writeCspHashes();
    expect(writtenPath).not.toBeNull();

    const content = await readFile(writtenPath!, "utf8");
    const manifest = JSON.parse(content);

    const expectedStyleHash = `sha256-${createHash("sha256").update(Buffer.from(".card{color:red;}", "utf8")).digest("base64")}`;
    const expectedScriptHash = `sha256-${createHash("sha256").update(Buffer.from('console.log("hello");', "utf8")).digest("base64")}`;

    expect(manifest["/index"]).toBeDefined();
    expect(manifest["/index"].styles).toContain(expectedStyleHash);
    expect(manifest["/index"].scripts).toContain(expectedScriptHash);

    await rm(outDir, { recursive: true, force: true });
    await rm(privateDirFor(outDir), { recursive: true, force: true });
  });

  it("deduplicates identical inline script/style blocks within a page", () => {
    const html =
      `<style>body{}</style><style>body{}</style>` +
      `<script>run();</script><script>run();</script>`;

    cspHashCollector.recordPage("/dup", html);
    const manifest = cspHashCollector.getManifest();
    expect(manifest["/dup"].styles).toHaveLength(1);
    expect(manifest["/dup"].scripts).toHaveLength(1);
  });

  it("excludes external scripts and stylesheets", () => {
    const html = `<link rel="stylesheet" href="/styles.css"><script src="/app.js"></script>`;
    cspHashCollector.recordPage("/external", html);
    const manifest = cspHashCollector.getManifest();
    expect(manifest["/external"].styles).toEqual([]);
    expect(manifest["/external"].scripts).toEqual([]);
  });

  it("excludes inert server-script placeholders from script hashes", () => {
    const html = `<script type="text/bascik-server" data-bascik-server-id="123"></script>`;
    cspHashCollector.recordPage("/server-placeholder", html);
    const manifest = cspHashCollector.getManifest();
    expect(manifest["/server-placeholder"].scripts).toEqual([]);
  });

  it("produces deterministic, byte-identical manifest across runs", async () => {
    const outDir = join(tmpdir(), `bascik-csp-test-${Date.now()}`);
    (BascikConfig as any).directory.out = outDir;

    const html = `<style>.a{}</style><script>console.log(1);</script>`;
    cspHashCollector.recordPage("/a", html);
    cspHashCollector.recordPage("/b", html);

    await cspHashCollector.writeCspHashes();
    const run1 = await readFile(
      join(privateDirFor(outDir), "csp-hashes.json"),
      "utf8",
    );

    await cspHashCollector.writeCspHashes();
    const run2 = await readFile(
      join(privateDirFor(outDir), "csp-hashes.json"),
      "utf8",
    );

    expect(run1).toBe(run2);
    await rm(outDir, { recursive: true, force: true });
    await rm(privateDirFor(outDir), { recursive: true, force: true });
  });
});

/**
 * Prompt 157 (D5): a page whose server or stream script may return a
 * component tag can render any manifest component at request time, so its
 * route lists every CSP-stable component style hash and first-instance script
 * hash. The hashes fold into the route's own entry; there is no new section.
 */
describe("widenRouteCspHashes (prompt 157)", () => {
  const base: CspHashesManifest = {
    "/a": { scripts: ["sha256-a-script"], styles: ["sha256-a-style"] },
    "/b": { scripts: [], styles: ["sha256-b-style"] },
  };
  const component = {
    scripts: ["sha256-comp-script"],
    styles: ["sha256-comp-style", "sha256-a-style"],
  };

  it("adds the component hashes to the named routes only, deduplicated and sorted, and leaves the rest untouched", () => {
    const widened = widenRouteCspHashes(base, ["/a"], component);
    expect(widened["/a"]).toEqual({
      scripts: ["sha256-a-script", "sha256-comp-script"].sort(),
      styles: ["sha256-a-style", "sha256-comp-style"].sort(),
    });
    expect(widened["/b"]).toEqual(base["/b"]);
    // Pure: the input manifest is not mutated.
    expect(base["/a"].styles).toEqual(["sha256-a-style"]);
  });

  it("creates an entry for a named route the manifest does not list yet", () => {
    const widened = widenRouteCspHashes(base, ["/c"], component);
    expect(widened["/c"]).toEqual({
      scripts: ["sha256-comp-script"],
      styles: ["sha256-a-style", "sha256-comp-style"].sort(),
    });
  });

  it("returns an equal manifest when there is nothing to add", () => {
    expect(
      widenRouteCspHashes(base, ["/a", "/b"], { scripts: [], styles: [] }),
    ).toEqual(base);
    expect(widenRouteCspHashes(base, [], component)).toEqual(base);
  });
});
