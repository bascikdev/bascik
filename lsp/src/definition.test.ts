/**
 * Go to Definition (textDocument/definition) for component tags, script `src` attributes and
 * module specifiers in Bascik directive scripts.
 *
 * The target URI must be a real file URL (percent-encoded, drive letter as a path segment on
 * Windows), so these tests use real temporary folders whose names carry `#`, `%` and spaces,
 * and round-trip every target through fileURLToPath. On the Windows CI job the same tests
 * prove `c:\...` paths become `file:///c:/...`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDocument } from "vscode-languageserver-textdocument";
import { createDefinition } from "./analyzer.js";
import { type ProjectSnapshot } from "./project.js";

let root: string;
let componentPath: string;
let helperPath: string;
let pagePath: string;
let snapshot: ProjectSnapshot;

beforeEach(() => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "bascik-lsp-def-"));
  // A folder name the URL parser would cut at "#" or mis-decode at "%" if not encoded.
  root = path.join(parent, "my site #1 100%");
  fs.mkdirSync(path.join(root, "src", "components"), { recursive: true });
  fs.mkdirSync(path.join(root, "src", "lib"), { recursive: true });
  fs.mkdirSync(path.join(root, "src", "pages"), { recursive: true });
  componentPath = path.join(root, "src", "components", "demo-card.html");
  helperPath = path.join(root, "src", "lib", "load.ts");
  pagePath = path.join(root, "src", "pages", "index.html");
  fs.writeFileSync(componentPath, "<article></article>\n");
  fs.writeFileSync(helperPath, "export const load = () => 1;\n");
  snapshot = {
    projectRoot: root,
    componentRoots: [path.join(root, "src", "components")],
    componentMap: new Map([["demo-card", componentPath]]),
    componentMetadata: new Map(),
    importRoot: path.join(root, "src"),
    htmlUsageByFile: new Map(),
  };
});

afterEach(() => {
  fs.rmSync(path.dirname(root), { recursive: true, force: true });
});

function definitionAt(text: string, needle: string, offsetInNeedle = 1) {
  const document = TextDocument.create("file:///page.html", "html", 1, text);
  const index = text.indexOf(needle);
  expect(index).toBeGreaterThanOrEqual(0);
  return createDefinition(
    document,
    document.positionAt(index + offsetInNeedle),
    snapshot,
    pagePath,
  );
}

describe("createDefinition target URIs", () => {
  it("encodes a component path with #, % and spaces as a file URL", () => {
    const links = definitionAt("<demo-card></demo-card>", "demo-card");
    expect(links).toHaveLength(1);
    const targetUri = links![0].targetUri;
    expect(targetUri.startsWith("file:///")).toBe(true);
    expect(new URL(targetUri).hash).toBe("");
    expect(fileURLToPath(targetUri)).toBe(componentPath);
  });

  it("encodes a module specifier target in a server script", () => {
    const text =
      '<script data-bascik-server>import { load } from "@/lib/load.ts";</script>';
    const links = definitionAt(text, "@/lib/load.ts", 3);
    expect(links).toHaveLength(1);
    expect(new URL(links![0].targetUri).hash).toBe("");
    expect(fileURLToPath(links![0].targetUri)).toBe(helperPath);
  });

  it("encodes a script src target", () => {
    const text = '<script data-bascik-build src="../lib/load.ts"></script>';
    const links = definitionAt(text, "../lib/load.ts", 3);
    expect(links).toHaveLength(1);
    expect(fileURLToPath(links![0].targetUri)).toBe(helperPath);
  });
});

describe("createDefinition in stream scripts", () => {
  it("resolves imports in data-bascik-stream scripts like server scripts", () => {
    const text =
      '<script data-bascik-stream>import { load } from "@/lib/load.ts";</script>';
    const links = definitionAt(text, "@/lib/load.ts", 3);
    expect(links).toHaveLength(1);
    expect(fileURLToPath(links![0].targetUri)).toBe(helperPath);
  });

  it("returns nothing for a stream import whose target does not exist", () => {
    const text =
      '<script data-bascik-stream>import { load } from "@/lib/missing.ts";</script>';
    expect(definitionAt(text, "@/lib/missing.ts", 3)).toBeUndefined();
  });

  it("still ignores imports in plain browser scripts", () => {
    const text = '<script>import { load } from "./load.ts";</script>';
    expect(definitionAt(text, "./load.ts", 3)).toBeUndefined();
  });
});
