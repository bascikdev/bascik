/**
 * examples.ts: build-time helpers for the Examples section.
 *
 * The repo-root `examples/` folder is the single source for every example. Pages never copy example code into
 * Markdown: they read the files at build time, so what the page shows, what `add-example.mjs` downloads
 * (`/assets/examples.json`, written by scripts/publish-examples.ts), and what the tests exercise are the same bytes.
 *
 * An example page's Markdown places example content with HTML comment markers:
 *
 *   <!-- example:demo -->                         live demo box: preview, usage, and the component file
 *   <!-- example:file starter-site/src/lib/seo.ts -->   one example file as a code block
 *   <!-- example:tree starter-site -->            the file tree of an example folder
 *
 * The usage shown in the demo box comes from the page's `<!-- demo:usage -->` code block, which is printed as live
 * markup for the preview and escaped for the Usage tab. The preview is wrapped in `[data-example-stage]`, which
 * docs/src/css/styles.css gives the starter site's design tokens and a solid page background, so the component renders
 * the way it does in a real site instead of on the docs checkerboard.
 */
import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { readDemoBlock, renderMd } from "./md-renderer.ts";
import { escapeCode, highlightCode } from "./highlight.ts";

/** The examples folder, relative to the docs project root (the build's working directory). */
export const EXAMPLES_DIR = "../examples";

const GITHUB_TREE = "https://github.com/bascikdev/bascik/tree/main/examples/";

const LANGUAGES: Record<string, string> = {
  ".html": "html",
  ".css": "css",
  ".ts": "ts",
  ".js": "js",
  ".mjs": "js",
  ".json": "json",
  ".md": "md",
  ".svg": "html",
};

const escapeAttribute = (value: string): string =>
  escapeCode(value).replace(/"/g, "&quot;");

/** Files of an example folder, relative to it, sorted, without build output or dependencies. Exported for tests. */
export async function exampleFiles(folder: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.name.startsWith(".") ||
        entry.name === "node_modules" ||
        entry.name === "dist"
      )
        continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(relative(folder, full).split(sep).join("/"));
    }
  };
  await walk(folder);
  return out.sort();
}

interface TreeNode {
  [name: string]: TreeNode | null;
}

/** An indented file tree for display, folders before files at each level. Exported for tests. */
export function fileTree(name: string, files: string[]): string {
  const root: TreeNode = {};
  for (const file of files) {
    const parts = file.split("/");
    let node = root;
    parts.forEach((part, index) => {
      if (index === parts.length - 1) node[part] = null;
      else node = (node[part] ??= {}) as TreeNode;
    });
  }
  const lines = [`${name}/`];
  const print = (node: TreeNode, depth: number) => {
    const entries = Object.entries(node).sort(([a, av], [b, bv]) =>
      (av === null) === (bv === null)
        ? a.localeCompare(b)
        : av === null
          ? 1
          : -1,
    );
    for (const [part, child] of entries) {
      lines.push(`${"  ".repeat(depth)}${part}${child ? "/" : ""}`);
      if (child) print(child, depth + 1);
    }
  };
  print(root, 1);
  return lines.join("\n");
}

/** One example file as a code block with its path in the header. */
export async function exampleFileBlock(examplePath: string): Promise<string> {
  const source = await readFile(join(EXAMPLES_DIR, examplePath), "utf8");
  const lang = LANGUAGES[extname(examplePath)] ?? "text";
  return `<code-block data-bascik-prop-lang="${lang}" data-bascik-prop-file="examples/${escapeAttribute(examplePath)}">${highlightCode(source.replace(/\n$/, ""), lang)}</code-block>`;
}

/** The live demo box for one component: preview, usage, and the full component file. */
export async function exampleDemo(
  mdPath: string,
  componentPath: string,
): Promise<string> {
  const usage = await readDemoBlock(mdPath, "usage");
  if (usage.code === undefined)
    throw new Error(
      `[examples] ${mdPath} needs a <!-- demo:usage --> code block`,
    );
  const source = await readFile(componentPath, "utf8");
  const file = relative("..", componentPath).split(sep).join("/");
  return `<component-demo data-bascik-prop-no-output="true" data-bascik-prop-file="${escapeAttribute(file)}">
  <div data-bascik-slot="example"><div data-example-stage>${usage.code}</div></div>
  <div data-bascik-slot="source-usage"><code-block data-bascik-prop-lang="html">${highlightCode(usage.code, "html")}</code-block></div>
  <div data-bascik-slot="source-html"><code-block data-bascik-prop-lang="html" data-bascik-prop-file="${escapeAttribute(file)}">${highlightCode(source.replace(/\n$/, ""), "html")}</code-block></div>
</component-demo>`;
}

/** GitHub URL of an example folder or file. */
export const githubUrl = (examplePath: string): string =>
  `${GITHUB_TREE}${examplePath}`;

/**
 * Renders an example page: its Markdown with the demo block stripped from the prose, and every example marker
 * replaced. `componentPath` is required when the Markdown contains `<!-- example:demo -->`.
 */
export async function renderExample(
  mdPath: string,
  componentPath?: string,
): Promise<string> {
  let html = await renderMd(mdPath, { stripDemoBlocks: true });
  const markers = [
    ...html.matchAll(/<!--\s*example:(demo|file|tree)\s*([^\s>]*)\s*-->/g),
  ];
  for (const marker of markers) {
    const [whole, kind, argument] = marker;
    let replacement: string;
    if (kind === "demo") {
      if (!componentPath)
        throw new Error(
          `[examples] ${mdPath} has an example:demo marker but no component path`,
        );
      replacement = await exampleDemo(mdPath, componentPath);
    } else if (kind === "file") {
      replacement = await exampleFileBlock(argument);
    } else {
      const folder = join(EXAMPLES_DIR, argument);
      replacement = `<code-block data-bascik-prop-lang="text">${escapeCode(fileTree(argument, await exampleFiles(folder)))}</code-block>`;
    }
    html = html.replace(whole, () => replacement);
  }
  return html;
}
