/**
 * Builds the examples bundle that `skills/bascik/scripts/add-example.mjs` downloads from
 * `https://bascik.dev/assets/examples.json`. The repo-root `examples/` folder is the only copy of the examples:
 *
 * - `examples/components/<name>/`: one standalone component per folder (kind "component")
 * - `examples/<name>/` with a package.json: a complete project (kind "site")
 *
 * Every file records which example components it uses, so copying part of a site also copies the components that
 * part needs.
 */
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const BUNDLE_VERSION = 1;

const GITHUB_EXAMPLES =
  "https://github.com/bascikdev/bascik/tree/main/examples/";

/** Components documented on another component's page instead of their own. Exported for tests. */
export const DOCUMENTED_WITH: Record<string, string> = {
  "theme-init": "theme-toggle",
};

export interface ExampleFile {
  /** Path relative to the example folder, with forward slashes. */
  path: string;
  content: string;
  /**
   * Component tags this file uses: example components, and for sites also the site's own `src/components/`.
   * A site's own component wins over an example component with the same name.
   */
  uses: string[];
}

export interface Example {
  name: string;
  kind: "component" | "site";
  title: string;
  description: string;
  /** Docs page for a component, relative to the docs origin, or the GitHub folder of a site. */
  docs: string;
  files: ExampleFile[];
}

export interface ExamplesBundle {
  version: number;
  examples: Example[];
}

async function listFiles(folder: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
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

/** "tab-group" -> "Tab Group". Exported for tests. */
export const titleOf = (name: string): string =>
  name
    .split("-")
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");

/** The first paragraph of a component's `@bascik` comment. Exported for tests. */
export function componentDescription(html: string): string {
  const comment = /<!--\s*@bascik\b([\s\S]*?)-->/.exec(html)?.[1] ?? "";
  const lines: string[] = [];
  for (const line of comment.split("\n")) {
    const text = line.trim();
    if (text.startsWith("@")) break;
    if (!text && lines.length) break;
    if (text) lines.push(text);
  }
  return lines.join(" ");
}

/** The first paragraph after the title of a README. Exported for tests. */
export function readmeDescription(markdown: string): string {
  const paragraphs = markdown
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  return (
    paragraphs.find(
      (block) => !block.startsWith("#") && !block.startsWith("```"),
    ) ?? ""
  ).replace(/\s+/g, " ");
}

/** Example component tags used in a file, excluding `self`. Exported for tests. */
export function componentTagsIn(
  source: string,
  componentNames: Set<string>,
  self?: string,
): string[] {
  const found = new Set<string>();
  // Comments and code examples mention tags without using them.
  let markup = source;
  let previous: string;
  do {
    previous = markup;
    markup = markup.replace(/<!--[\s\S]*?-->/g, "");
  } while (markup !== previous);
  for (const match of markup.matchAll(/<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)\b/g)) {
    if (componentNames.has(match[1]) && match[1] !== self) found.add(match[1]);
  }
  return [...found].sort();
}

/** Read every example under `examplesDir`. */
export async function createExamplesBundle(
  examplesDir: string,
): Promise<ExamplesBundle> {
  const componentsDir = join(examplesDir, "components");
  const componentNames = (await readdir(componentsDir, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isDirectory() &&
        existsSync(join(componentsDir, entry.name, `${entry.name}.html`)),
    )
    .map((entry) => entry.name)
    .sort();
  const names = new Set(componentNames);
  const examples: Example[] = [];

  for (const name of componentNames) {
    const folder = join(componentsDir, name);
    const files = await Promise.all(
      (await listFiles(folder)).map(async (path) => {
        const content = await readFile(join(folder, path), "utf8");
        return {
          path,
          content,
          uses: path.endsWith(".html")
            ? componentTagsIn(content, names, name)
            : [],
        };
      }),
    );
    const main = files.find((file) => file.path === `${name}.html`)!;
    const description = componentDescription(main.content);
    if (!description)
      throw new Error(
        `examples-bundle: ${name}.html needs a description in its @bascik comment`,
      );
    examples.push({
      name,
      kind: "component",
      title: titleOf(name),
      description,
      docs: `/example-components/${DOCUMENTED_WITH[name] ?? name}`,
      files,
    });
  }

  for (const entry of await readdir(examplesDir, { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      entry.name === "components" ||
      entry.name.startsWith(".")
    )
      continue;
    const folder = join(examplesDir, entry.name);
    if (!existsSync(join(folder, "package.json"))) continue;
    const paths = await listFiles(folder);
    const siteNames = new Set(names);
    for (const path of paths) {
      const local =
        /^src\/components\/(?:.*\/)?([a-z][a-z0-9]*(?:-[a-z0-9]+)+)\/\1\.html$/.exec(
          path,
        );
      if (local) siteNames.add(local[1]);
    }
    const files = await Promise.all(
      paths.map(async (path) => {
        const content = await readFile(join(folder, path), "utf8");
        const self = /\/([^/]+)\.html$/.exec(path)?.[1];
        return {
          path,
          content,
          uses: /\.(html|ts)$/.test(path)
            ? componentTagsIn(content, siteNames, self)
            : [],
        };
      }),
    );
    const readme = files.find((file) => file.path === "README.md");
    const description = readme ? readmeDescription(readme.content) : "";
    if (!description)
      throw new Error(
        `examples-bundle: ${entry.name}/README.md needs a description paragraph`,
      );
    // Sites have no docs page; their README on GitHub explains them.
    const docs = `${GITHUB_EXAMPLES}${entry.name}`;
    examples.push({
      name: entry.name,
      kind: "site",
      title: titleOf(entry.name),
      description,
      docs,
      files,
    });
  }

  return { version: BUNDLE_VERSION, examples };
}
