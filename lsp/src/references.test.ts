/**
 * Find All References for Bascik components (textDocument/references).
 *
 * The cursor resolves a component when it sits on a component tag name (opening or closing, in a page or a
 * component), or on a line of a component's own file that identifies it: its first line, its `<!-- @bascik`
 * doc comment, or its root element's tag line. The answer is one Location per usage tag, spanning the tag
 * name in the opening tag, pages first, then components, each by path and then position.
 *
 * What counts as a usage matches what the compiler expands. A probe build (Node 24, 2026-10-29) of a page
 * using `<my-card>` in every context below showed the compiler leaves it alone in a comment, an attribute
 * value, and the body of `<textarea>`, `<script>` and `<style>`, and expands it inside `<pre>`, `<code>`
 * and `<template>`, self-closing (`<my-card/>`), and in upper case. Escaped text (`&lt;my-card&gt;`) is
 * not a tag at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  FileChangeType,
  type Location,
  type Position,
  type Range,
} from "vscode-languageserver";
import { BascikLanguageServer } from "./server.js";

type Handler = (...args: any[]) => any;

/** The slice of a language server connection that the server uses, recording the handlers it registers. */
function createFakeConnection() {
  const handlers = new Map<string, Handler>();
  const register = (name: string) =>
    vi.fn((handler: Handler) => {
      handlers.set(name, handler);
      return { dispose() {} };
    });
  const connection = {
    onInitialize: register("initialize"),
    onInitialized: register("initialized"),
    onCompletion: register("completion"),
    onHover: register("hover"),
    onDefinition: register("definition"),
    onReferences: register("references"),
    onCodeAction: register("codeAction"),
    onDidChangeWatchedFiles: register("watchedFiles"),
    onDidOpenTextDocument: register("didOpen"),
    onDidChangeTextDocument: register("didChange"),
    onDidCloseTextDocument: register("didClose"),
    onWillSaveTextDocument: register("willSave"),
    onWillSaveTextDocumentWaitUntil: register("willSaveWaitUntil"),
    onDidSaveTextDocument: register("didSave"),
    sendDiagnostics: vi.fn(),
    listen: vi.fn(),
    client: { register: vi.fn(async () => ({ dispose() {} })) },
    workspace: {
      onDidChangeWorkspaceFolders: register("workspaceFolders"),
    },
  };
  return { connection, handlers };
}

const PRODUCT_CARD = `<!-- @bascik
  A product with its price and a buy button.
-->
<article class="card">
  <h2 data-bascik-prop-title></h2>
  <buy-button></buy-button>
</article>
`;

const BUY_BUTTON = `<button type="button">Buy</button>\n`;

const CARD_GRID = `<section class="grid">
  <product-card data-bascik-prop-title="One"></product-card>
  <product-card data-bascik-prop-title="Two" />
</section>
`;

const INDEX = `<!doctype html>
<html>
<body>
  <card-grid></card-grid>
  <product-card data-bascik-prop-title="Home"></product-card>
</body>
</html>
`;

const ABOUT = `<main>
  <p>About us</p>
  <product-card data-bascik-prop-title="About"></product-card>
</main>
`;

const POST = `<article>
  <product-card data-bascik-prop-title="a > b"></product-card>
</article>
`;

describe("Find All References for components", () => {
  let root: string;
  let server: BascikLanguageServer;
  let fake: ReturnType<typeof createFakeConnection>;

  const file = (relative: string) => path.join(root, relative);
  const write = async (relative: string, content: string) => {
    const target = file(relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
    return target;
  };
  const uri = (target: string) => pathToFileURL(target).toString();

  const initialize = async () => {
    const result = await fake.handlers.get("initialize")!({
      workspaceFolders: [{ uri: uri(root), name: "site" }],
      capabilities: {
        workspace: {
          didChangeWatchedFiles: {
            dynamicRegistration: true,
            relativePatternSupport: true,
          },
          workspaceFolders: true,
        },
      },
    });
    fake.handlers.get("initialized")!();
    return result;
  };

  /** Opens a file in the editor with its disk text, or the given text. */
  const open = async (
    relative: string,
    text?: string,
    languageId = "html",
  ): Promise<string> => {
    const target = file(relative);
    const content = text ?? (await fs.readFile(target, "utf8"));
    fake.handlers.get("didOpen")!({
      textDocument: { uri: uri(target), languageId, version: 1, text: content },
    });
    return content;
  };
  const change = (relative: string, text: string, version = 2) =>
    fake.handlers.get("didChange")!({
      textDocument: { uri: uri(file(relative)), version },
      contentChanges: [{ text }],
    });
  const close = (relative: string) =>
    fake.handlers.get("didClose")!({
      textDocument: { uri: uri(file(relative)) },
    });

  const references = async (
    relative: string,
    position: Position,
    includeDeclaration = false,
  ): Promise<Location[] | null | undefined> =>
    fake.handlers.get("references")!({
      textDocument: { uri: uri(file(relative)) },
      position,
      context: { includeDeclaration },
    });

  /** The position `offset` characters into the `occurrence`-th `needle` in `text`. */
  const at = (
    text: string,
    needle: string,
    offset = 0,
    occurrence = 0,
  ): Position => {
    let index = -1;
    for (let i = 0; i <= occurrence; i++) {
      index = text.indexOf(needle, index + 1);
      if (index < 0) throw new Error(`"${needle}" #${occurrence} not found`);
    }
    const before = text.slice(0, index + offset);
    const lines = before.split("\n");
    return { line: lines.length - 1, character: lines.at(-1)!.length };
  };

  /** The Location of the tag name in the `occurrence`-th opening tag that starts with `<name`. */
  const usage = (
    relative: string,
    text: string,
    name: string,
    occurrence = 0,
  ): Location => {
    const start = at(text, `<${name}`, 1, occurrence);
    const range: Range = {
      start,
      end: { line: start.line, character: start.character + name.length },
    };
    return { uri: uri(file(relative)), range };
  };

  /** Locations reduced to "path:line:character", for readable failures. */
  const brief = (locations: Location[] | null | undefined) =>
    (locations ?? []).map(
      (location) =>
        `${path.relative(root, new URL(location.uri).pathname)}:${location.range.start.line}:${location.range.start.character}-${location.range.end.line}:${location.range.end.character}`,
    );

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "bascik-lsp-references-"));
    await write("bascik.config.ts", "export default {};\n");
    await write("src/components/product-card.html", PRODUCT_CARD);
    await write("src/components/buy-button.html", BUY_BUTTON);
    await write("src/components/card-grid.html", CARD_GRID);
    await write("src/pages/index.html", INDEX);
    await write("src/pages/about.html", ABOUT);
    await write("src/pages/blog/post.html", POST);
    fake = createFakeConnection();
    server = new BascikLanguageServer(fake.connection as never);
  });

  afterEach(async () => {
    server.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  /** Every usage of product-card in the fixture, in the order the server must report them. */
  const allProductCardUsages = (): Location[] => [
    usage("src/pages/about.html", ABOUT, "product-card"),
    usage("src/pages/blog/post.html", POST, "product-card"),
    usage("src/pages/index.html", INDEX, "product-card"),
    usage("src/components/card-grid.html", CARD_GRID, "product-card", 0),
    usage("src/components/card-grid.html", CARD_GRID, "product-card", 1),
  ];

  describe("capability", () => {
    it("declares referencesProvider", async () => {
      const result = await initialize();
      expect(result.capabilities.referencesProvider).toBe(true);
    });

    it("registers a textDocument/references handler", () => {
      expect(fake.connection.onReferences).toHaveBeenCalledTimes(1);
      expect(fake.handlers.has("references")).toBe(true);
    });
  });

  describe("from a usage tag", () => {
    it("lists every usage, pages first, then components, by path and position", async () => {
      await initialize();
      await open("src/pages/index.html");
      const found = await references(
        "src/pages/index.html",
        at(INDEX, "<product-card", 4),
      );
      expect(brief(found)).toEqual(brief(allProductCardUsages()));
      expect(found).toEqual(allProductCardUsages());
    });

    it("resolves from the closing tag name too", async () => {
      await initialize();
      await open("src/pages/about.html");
      const found = await references(
        "src/pages/about.html",
        at(ABOUT, "</product-card>", 5),
      );
      expect(found).toEqual(allProductCardUsages());
    });

    it("resolves at either edge of the tag name", async () => {
      await initialize();
      await open("src/pages/about.html");
      const startOfName = at(ABOUT, "<product-card", 1);
      const endOfName = at(ABOUT, "<product-card", 1 + "product-card".length);
      expect(await references("src/pages/about.html", startOfName)).toEqual(
        allProductCardUsages(),
      );
      expect(await references("src/pages/about.html", endOfName)).toEqual(
        allProductCardUsages(),
      );
    });

    it("resolves from a usage inside another component, including a self-closing one", async () => {
      await initialize();
      await open("src/components/card-grid.html");
      const found = await references(
        "src/components/card-grid.html",
        at(CARD_GRID, "<product-card", 3, 1),
      );
      expect(found).toEqual(allProductCardUsages());
    });

    it("finds a nested component's usages from inside its parent component", async () => {
      await initialize();
      await open("src/components/product-card.html");
      const found = await references(
        "src/components/product-card.html",
        at(PRODUCT_CARD, "<buy-button", 2),
      );
      expect(found).toEqual([
        usage("src/components/product-card.html", PRODUCT_CARD, "buy-button"),
      ]);
    });

    it("matches tag names case-insensitively, as the compiler does", async () => {
      const shouting = "<main><PRODUCT-CARD></PRODUCT-CARD></main>\n";
      await write("src/pages/shouting.html", shouting);
      await initialize();
      await open("src/pages/shouting.html");
      const found = await references(
        "src/pages/shouting.html",
        at(shouting, "<PRODUCT-CARD", 3),
      );
      expect(found).toContainEqual(
        usage("src/pages/shouting.html", shouting, "PRODUCT-CARD"),
      );
      expect(found).toHaveLength(allProductCardUsages().length + 1);
    });
  });

  describe("from the component's own file", () => {
    it("resolves on the first line, which is the doc comment opener", async () => {
      await initialize();
      await open("src/components/product-card.html");
      const found = await references("src/components/product-card.html", {
        line: 0,
        character: 0,
      });
      expect(found).toEqual(allProductCardUsages());
    });

    it("resolves anywhere inside the @bascik doc comment", async () => {
      await initialize();
      await open("src/components/product-card.html");
      const found = await references(
        "src/components/product-card.html",
        at(PRODUCT_CARD, "its price", 2),
      );
      expect(found).toEqual(allProductCardUsages());
    });

    it("resolves on the root element's tag line", async () => {
      await initialize();
      await open("src/components/product-card.html");
      const found = await references(
        "src/components/product-card.html",
        at(PRODUCT_CARD, 'class="card"', 3),
      );
      expect(found).toEqual(allProductCardUsages());
    });

    it("resolves on the first line of a component with no doc comment", async () => {
      await initialize();
      await open("src/components/card-grid.html");
      await write(
        "src/pages/grid.html",
        "<main><card-grid></card-grid></main>\n",
      );
      server.invalidateSnapshots();
      const found = await references("src/components/card-grid.html", {
        line: 0,
        character: 3,
      });
      expect(brief(found)).toEqual(
        brief([
          usage("src/pages/grid.html", "<main><card-grid", "card-grid"),
          usage("src/pages/index.html", INDEX, "card-grid"),
        ]),
      );
    });

    it("returns nothing on a component's inner line that names no component", async () => {
      await initialize();
      await open("src/components/product-card.html");
      expect(
        await references(
          "src/components/product-card.html",
          at(PRODUCT_CARD, "<h2", 1),
        ),
      ).toEqual([]);
    });

    it("adds the component file's first line with includeDeclaration, ahead of the usages", async () => {
      await initialize();
      await open("src/components/product-card.html");
      const found = await references(
        "src/components/product-card.html",
        { line: 0, character: 0 },
        true,
      );
      expect(found).toHaveLength(allProductCardUsages().length + 1);
      const [declaration, ...usages] = found!;
      expect(declaration.uri).toBe(
        uri(file("src/components/product-card.html")),
      );
      expect(declaration.range.start).toEqual({ line: 0, character: 0 });
      expect(declaration.range.end.line).toBe(0);
      expect(usages).toEqual(allProductCardUsages());
    });

    it("leaves the declaration out without includeDeclaration", async () => {
      await initialize();
      await open("src/pages/index.html");
      const found = await references(
        "src/pages/index.html",
        at(INDEX, "<product-card", 2),
        false,
      );
      expect(
        found!.some(
          (location) =>
            location.uri === uri(file("src/components/product-card.html")),
        ),
      ).toBe(false);
    });
  });

  describe("what counts as a usage", () => {
    const MASKED = `<main>
  <!-- A:<product-card></product-card> -->
  <div title="<product-card></product-card>">B</div>
  <div data-note='<product-card/>'>C</div>
  <textarea>D:<product-card></product-card></textarea>
  <script>const html = "<product-card></product-card>";</script>
  <script type="application/ld+json">{"t":"<product-card>"}</script>
  <style>/* <product-card></product-card> */</style>
  <pre><code>&lt;product-card&gt;&lt;/product-card&gt;</code></pre>
  <product-card-list></product-card-list>
  <product-cards></product-cards>
  <p>product-card in prose</p>
</main>
`;

    it("ignores comments, attribute values, raw-text bodies, escaped text and longer tag names", async () => {
      await write("src/pages/masked.html", MASKED);
      await initialize();
      await open("src/pages/index.html");
      const found = await references(
        "src/pages/index.html",
        at(INDEX, "<product-card", 2),
      );
      expect(brief(found)).toEqual(brief(allProductCardUsages()));
    });

    const EXPANDED = `<main>
  <pre>A:<product-card></product-card></pre>
  <code>B:<product-card></product-card></code>
  <template>C:<product-card></product-card></template>
  D:<product-card/>
</main>
`;

    it("counts tags inside <pre>, <code> and <template> and self-closing tags, which the compiler expands", async () => {
      await write("src/pages/expanded.html", EXPANDED);
      await initialize();
      await open("src/pages/index.html");
      const found = await references(
        "src/pages/index.html",
        at(INDEX, "<product-card", 2),
      );
      const expanded = [0, 1, 2, 3].map((n) =>
        usage("src/pages/expanded.html", EXPANDED, "product-card", n),
      );
      expect(brief(found)).toEqual(
        brief([
          usage("src/pages/about.html", ABOUT, "product-card"),
          usage("src/pages/blog/post.html", POST, "product-card"),
          ...expanded,
          usage("src/pages/index.html", INDEX, "product-card"),
          usage("src/components/card-grid.html", CARD_GRID, "product-card", 0),
          usage("src/components/card-grid.html", CARD_GRID, "product-card", 1),
        ]),
      );
    });

    it("does not resolve a cursor on a component name inside an attribute value, comment or script", async () => {
      await write("src/pages/masked.html", MASKED);
      await initialize();
      await open("src/pages/masked.html");
      for (const needle of [
        "A:<product-card",
        'title="<product-card',
        "D:<product-card",
        'html = "<product-card',
        "product-card in prose",
      ]) {
        const offset = needle.indexOf("product-card") + 2;
        expect(
          await references("src/pages/masked.html", at(MASKED, needle, offset)),
          needle,
        ).toEqual([]);
      }
    });

    it("reports a component that uses itself without looping", async () => {
      const recursive = `<ul class="tree">
  <li><tree-node></tree-node></li>
</ul>
`;
      await write("src/components/tree-node.html", recursive);
      await write("src/pages/tree.html", "<tree-node></tree-node>\n");
      await initialize();
      await open("src/components/tree-node.html");
      const found = await references("src/components/tree-node.html", {
        line: 0,
        character: 0,
      });
      expect(brief(found)).toEqual(
        brief([
          usage("src/pages/tree.html", "<tree-node", "tree-node"),
          usage("src/components/tree-node.html", recursive, "tree-node"),
        ]),
      );
    });

    it("reports positions by line in a file with CRLF line endings", async () => {
      const crlf =
        "<main>\r\n  <p>x</p>\r\n  <product-card></product-card>\r\n</main>\r\n";
      await write("src/pages/windows.html", crlf);
      await initialize();
      await open("src/pages/index.html");
      const found = await references(
        "src/pages/index.html",
        at(INDEX, "<product-card", 2),
      );
      expect(found).toContainEqual({
        uri: uri(file("src/pages/windows.html")),
        range: {
          start: { line: 2, character: 3 },
          end: { line: 2, character: 15 },
        },
      });
    });

    it("finds usages in a component root outside src", async () => {
      await write(
        "bascik.config.ts",
        'export default { directory: { components: ["src/components", "shared/ui"] } };\n',
      );
      const shelf = "<div><product-card></product-card></div>\n";
      await write("shared/ui/shelf-row.html", shelf);
      await initialize();
      await open("src/pages/index.html");
      const found = await references(
        "src/pages/index.html",
        at(INDEX, "<product-card", 2),
      );
      expect(found).toContainEqual(
        usage("shared/ui/shelf-row.html", shelf, "product-card"),
      );
      // Still a component, so after every page.
      expect(found!.at(-1)!.uri).not.toContain("/src/pages/");
    });
  });

  describe("misuse returns an empty list, never an error", () => {
    it("on an unknown hyphenated tag", async () => {
      const unknown = "<main><mystery-box></mystery-box></main>\n";
      await write("src/pages/unknown.html", unknown);
      await initialize();
      await open("src/pages/unknown.html");
      await expect(
        references("src/pages/unknown.html", at(unknown, "<mystery-box", 3)),
      ).resolves.toEqual([]);
    });

    it("on a built-in element", async () => {
      await initialize();
      await open("src/pages/about.html");
      await expect(
        references("src/pages/about.html", at(ABOUT, "<main", 2)),
      ).resolves.toEqual([]);
    });

    it("on the first line of a page, which is not a component file", async () => {
      await initialize();
      await open("src/pages/index.html");
      await expect(
        references("src/pages/index.html", { line: 0, character: 2 }),
      ).resolves.toEqual([]);
    });

    it("on a page that starts with an @bascik-looking comment", async () => {
      const page = "<!-- @bascik\n  not a component\n-->\n<main></main>\n";
      await write("src/pages/doc-like.html", page);
      await initialize();
      await open("src/pages/doc-like.html");
      await expect(
        references("src/pages/doc-like.html", { line: 1, character: 4 }),
      ).resolves.toEqual([]);
    });

    it("on whitespace between tags", async () => {
      await initialize();
      await open("src/pages/index.html");
      await expect(
        references("src/pages/index.html", { line: 3, character: 0 }),
      ).resolves.toEqual([]);
    });

    it("in a TypeScript file", async () => {
      const script = 'const tag = "product-card";\n';
      await write("src/scripts/tags.ts", script);
      await initialize();
      await open("src/scripts/tags.ts", script, "typescript");
      await expect(
        references("src/scripts/tags.ts", at(script, "product-card", 2)),
      ).resolves.toEqual([]);
    });

    it("for a components.external tag", async () => {
      await write(
        "bascik.config.ts",
        'export default { components: { external: ["vendor-*"] } };\n',
      );
      const page = "<main><vendor-map></vendor-map></main>\n";
      await write("src/pages/map.html", page);
      await initialize();
      await open("src/pages/map.html");
      await expect(
        references("src/pages/map.html", at(page, "<vendor-map", 3)),
      ).resolves.toEqual([]);
    });

    it("for a component whose file was deleted after startup", async () => {
      await initialize();
      await open("src/pages/about.html");
      expect(
        await references("src/pages/about.html", at(ABOUT, "<product-card", 2)),
      ).toHaveLength(allProductCardUsages().length);
      const removed = file("src/components/product-card.html");
      await fs.rm(removed);
      await server.handleWatchedFileChanges([
        { fsPath: removed, type: FileChangeType.Deleted },
      ]);
      await expect(
        references("src/pages/about.html", at(ABOUT, "<product-card", 2)),
      ).resolves.toEqual([]);
    });
  });

  describe("files changing after startup", () => {
    it("includes a page added on disk", async () => {
      await initialize();
      await open("src/pages/index.html");
      const before = await references(
        "src/pages/index.html",
        at(INDEX, "<product-card", 2),
      );
      expect(before).toHaveLength(allProductCardUsages().length);

      const added = "<main><product-card></product-card></main>\n";
      const target = await write("src/pages/added.html", added);
      await server.handleWatchedFileChanges([
        { fsPath: target, type: FileChangeType.Created },
      ]);
      const after = await references(
        "src/pages/index.html",
        at(INDEX, "<product-card", 2),
      );
      // "about.html" sorts before "added.html".
      expect(after![1]).toEqual(
        usage("src/pages/added.html", added, "product-card"),
      );
      expect(after).toHaveLength(allProductCardUsages().length + 1);
    });

    it("drops a usage removed from a page on disk, and a deleted page", async () => {
      await initialize();
      await open("src/pages/index.html");
      const aboutPath = file("src/pages/about.html");
      await fs.writeFile(aboutPath, "<main><p>No card</p></main>\n");
      const postPath = file("src/pages/blog/post.html");
      await fs.rm(postPath);
      await server.handleWatchedFileChanges([
        { fsPath: aboutPath, type: FileChangeType.Changed },
        { fsPath: postPath, type: FileChangeType.Deleted },
      ]);
      const found = await references(
        "src/pages/index.html",
        at(INDEX, "<product-card", 2),
      );
      expect(brief(found)).toEqual(
        brief([
          usage("src/pages/index.html", INDEX, "product-card"),
          usage("src/components/card-grid.html", CARD_GRID, "product-card", 0),
          usage("src/components/card-grid.html", CARD_GRID, "product-card", 1),
        ]),
      );
    });

    it("follows a usage added to a component on disk", async () => {
      await initialize();
      await open("src/pages/index.html");
      const footer = "<footer><product-card></product-card></footer>\n";
      const target = await write("src/components/site-footer.html", footer);
      await server.handleWatchedFileChanges([
        { fsPath: target, type: FileChangeType.Created },
      ]);
      const found = await references(
        "src/pages/index.html",
        at(INDEX, "<product-card", 2),
      );
      expect(found!.at(-1)).toEqual(
        usage("src/components/site-footer.html", footer, "product-card"),
      );
    });

    it("finds references for a component file created after startup", async () => {
      await initialize();
      const page = "<main><new-banner></new-banner></main>\n";
      await write("src/pages/banner.html", page);
      await open("src/pages/banner.html");
      expect(
        await references("src/pages/banner.html", at(page, "<new-banner", 3)),
      ).toEqual([]);
      const component = await write(
        "src/components/new-banner.html",
        "<aside>Sale</aside>\n",
      );
      await server.handleWatchedFileChanges([
        { fsPath: component, type: FileChangeType.Created },
      ]);
      expect(
        await references("src/pages/banner.html", at(page, "<new-banner", 3)),
      ).toEqual([usage("src/pages/banner.html", page, "new-banner")]);
    });
  });

  describe("unsaved buffers", () => {
    it("uses an open buffer's unsaved text over the file on disk", async () => {
      await initialize();
      await open("src/pages/about.html");
      const edited = `<main>
  <p>About us</p>
  <section>
    <product-card data-bascik-prop-title="First"></product-card>
    <product-card data-bascik-prop-title="Second"></product-card>
  </section>
</main>
`;
      change("src/pages/about.html", edited);
      const found = await references(
        "src/pages/index.html",
        at(INDEX, "<product-card", 2),
      );
      expect(brief(found)).toEqual(
        brief([
          usage("src/pages/about.html", edited, "product-card", 0),
          usage("src/pages/about.html", edited, "product-card", 1),
          usage("src/pages/blog/post.html", POST, "product-card"),
          usage("src/pages/index.html", INDEX, "product-card"),
          usage("src/components/card-grid.html", CARD_GRID, "product-card", 0),
          usage("src/components/card-grid.html", CARD_GRID, "product-card", 1),
        ]),
      );
    });

    it("drops a usage deleted in an unsaved buffer, and restores the disk text when the buffer closes unsaved", async () => {
      await initialize();
      await open("src/pages/about.html");
      change("src/pages/about.html", "<main><p>About us</p></main>\n");
      const whileEditing = await references(
        "src/pages/index.html",
        at(INDEX, "<product-card", 2),
      );
      expect(
        whileEditing!.some(
          (location) => location.uri === uri(file("src/pages/about.html")),
        ),
      ).toBe(false);

      close("src/pages/about.html");
      const afterClose = await references(
        "src/pages/index.html",
        at(INDEX, "<product-card", 2),
      );
      expect(afterClose).toEqual(allProductCardUsages());
    });

    it("resolves the cursor against the unsaved text of the requesting buffer", async () => {
      await initialize();
      await open("src/pages/about.html");
      const edited = "<main>\n  <buy-button></buy-button>\n</main>\n";
      change("src/pages/about.html", edited);
      const found = await references(
        "src/pages/about.html",
        at(edited, "<buy-button", 3),
      );
      expect(brief(found)).toEqual(
        brief([
          usage("src/pages/about.html", edited, "buy-button"),
          usage("src/components/product-card.html", PRODUCT_CARD, "buy-button"),
        ]),
      );
    });

    it("includes a usage in an unsaved new buffer whose file is not on disk yet", async () => {
      await initialize();
      const draft = "<main><product-card></product-card></main>\n";
      fake.handlers.get("didOpen")!({
        textDocument: {
          uri: uri(file("src/pages/draft.html")),
          languageId: "html",
          version: 1,
          text: draft,
        },
      });
      const found = await references(
        "src/pages/draft.html",
        at(draft, "<product-card", 3),
      );
      expect(found).toContainEqual(
        usage("src/pages/draft.html", draft, "product-card"),
      );
      expect(found).toHaveLength(allProductCardUsages().length + 1);
    });
  });

  describe("orphaned buffers, symlinked paths and the pages directory", () => {
    it("drops a deleted page that the editor still holds open, as it does after listing it in Peek References", async () => {
      await initialize();
      // VS Code opens a model for every file it previews, and keeps it after the file is deleted on disk.
      await open("src/pages/about.html");
      const aboutPath = file("src/pages/about.html");
      await fs.rm(aboutPath);
      await server.handleWatchedFileChanges([
        { fsPath: aboutPath, type: FileChangeType.Deleted },
      ]);
      const found = await references(
        "src/pages/index.html",
        at(INDEX, "<product-card", 2),
      );
      expect(brief(found)).toEqual(
        brief(
          allProductCardUsages().filter(
            (location) => location.uri !== uri(aboutPath),
          ),
        ),
      );
    });

    it("counts a deleted page's buffer again once it is edited, and once the file comes back", async () => {
      await initialize();
      await open("src/pages/about.html");
      const aboutPath = file("src/pages/about.html");
      await fs.rm(aboutPath);
      await server.handleWatchedFileChanges([
        { fsPath: aboutPath, type: FileChangeType.Deleted },
      ]);
      // Typing in the orphaned buffer makes it unsaved work, which counts like any unsaved buffer.
      change("src/pages/about.html", ABOUT, 2);
      expect(
        await references("src/pages/index.html", at(INDEX, "<product-card", 2)),
      ).toEqual(allProductCardUsages());

      await fs.rm(aboutPath, { force: true });
      await server.handleWatchedFileChanges([
        { fsPath: aboutPath, type: FileChangeType.Deleted },
      ]);
      await write("src/pages/about.html", ABOUT);
      await server.handleWatchedFileChanges([
        { fsPath: aboutPath, type: FileChangeType.Created },
      ]);
      expect(
        await references("src/pages/index.html", at(INDEX, "<product-card", 2)),
      ).toEqual(allProductCardUsages());
    });

    it("drops a deleted component's orphaned buffer from the usages", async () => {
      await initialize();
      await open("src/components/card-grid.html");
      const gridPath = file("src/components/card-grid.html");
      await fs.rm(gridPath);
      await server.handleWatchedFileChanges([
        { fsPath: gridPath, type: FileChangeType.Deleted },
      ]);
      const found = await references(
        "src/pages/index.html",
        at(INDEX, "<product-card", 2),
      );
      expect(found!.some((location) => location.uri === uri(gridPath))).toBe(
        false,
      );
    });

    it.skipIf(process.platform === "win32")(
      "applies a delete event spelled through the real path of a symlinked workspace",
      async () => {
        const link = `${root}-link`;
        await fs.symlink(root, link);
        try {
          await fake.handlers.get("initialize")!({
            workspaceFolders: [{ uri: uri(link), name: "site" }],
            capabilities: {},
          });
          fake.handlers.get("initialized")!();
          const index = path.join(link, "src/pages/index.html");
          fake.handlers.get("didOpen")!({
            textDocument: {
              uri: uri(index),
              languageId: "html",
              version: 1,
              text: INDEX,
            },
          });
          const query = () =>
            fake.handlers.get("references")!({
              textDocument: { uri: uri(index) },
              position: at(INDEX, "<product-card", 2),
              context: { includeDeclaration: false },
            }) as Promise<Location[]>;
          const before = await query();
          const realAbout = path.join(
            await fs.realpath(root),
            "src/pages/about.html",
          );
          expect(
            before.some(
              (location) =>
                location.uri === uri(path.join(link, "src/pages/about.html")),
            ),
          ).toBe(true);
          await fs.rm(realAbout);
          // The watcher reports the resolved path, not the workspace folder's spelling.
          await server.handleWatchedFileChanges([
            { fsPath: realAbout, type: FileChangeType.Deleted },
          ]);
          const after = await query();
          expect(after.map((location) => location.uri)).not.toContain(
            uri(path.join(link, "src/pages/about.html")),
          );
          expect(after).toHaveLength(before.length - 1);

          const added = "<main><product-card></product-card></main>\n";
          const realAdded = path.join(
            await fs.realpath(root),
            "src/pages/added.html",
          );
          await fs.writeFile(realAdded, added);
          await server.handleWatchedFileChanges([
            { fsPath: realAdded, type: FileChangeType.Created },
          ]);
          expect(await query()).toHaveLength(before.length);
        } finally {
          await fs.rm(link, { force: true });
        }
      },
    );

    it("reads pages from a configured directory.pages outside src", async () => {
      await write(
        "bascik.config.ts",
        'export default { directory: { pages: "pages" } };\n',
      );
      await fs.rm(file("src/pages"), { recursive: true });
      const home = "<main><product-card></product-card></main>\n";
      await write("pages/home.html", home);
      await initialize();
      await open("pages/home.html");
      const position = at(home, "<product-card", 2);
      expect(brief(await references("pages/home.html", position))).toEqual(
        brief([
          usage("pages/home.html", home, "product-card"),
          usage("src/components/card-grid.html", CARD_GRID, "product-card", 0),
          usage("src/components/card-grid.html", CARD_GRID, "product-card", 1),
        ]),
      );

      const extra = "<p><product-card></product-card></p>\n";
      const extraPath = await write("pages/extra.html", extra);
      await server.handleWatchedFileChanges([
        { fsPath: extraPath, type: FileChangeType.Created },
      ]);
      const unsaved =
        "<main><product-card></product-card><product-card/></main>\n";
      change("pages/home.html", unsaved);
      expect(brief(await references("pages/home.html", position))).toEqual(
        brief([
          usage("pages/extra.html", extra, "product-card"),
          usage("pages/home.html", unsaved, "product-card", 0),
          usage("pages/home.html", unsaved, "product-card", 1),
          usage("src/components/card-grid.html", CARD_GRID, "product-card", 0),
          usage("src/components/card-grid.html", CARD_GRID, "product-card", 1),
        ]),
      );
    });

    it("finds no usage in a colon-qualified tag or inside a legacy escaped script, as the compiler expands none", async () => {
      await initialize();
      // `<product-card:wide>` is the tag `product-card:wide` to a browser and
      // to the compiler, so only the last tag is a usage.
      const page = `<main>
  <product-card:wide></product-card:wide>
  <script><!-- document.write("<script>x</script>"); <product-card></product-card> --></script>
  <product-card></product-card>
</main>
`;
      await write("src/pages/edge.html", page);
      await server.handleWatchedFileChanges([
        { fsPath: file("src/pages/edge.html"), type: FileChangeType.Created },
      ]);
      const found = await references("src/components/product-card.html", {
        line: 0,
        character: 0,
      });
      const inEdge = found!.filter(
        (location) => location.uri === uri(file("src/pages/edge.html")),
      );
      expect(inEdge).toEqual([
        usage("src/pages/edge.html", page, "product-card", 2),
      ]);
    });
  });
});
