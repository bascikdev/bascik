/**
 * The catalog: the components a model is allowed to write.
 *
 * A Bascik component file already says everything a model needs: its tag name
 * (the file name), what it is for (the `@bascik` comment), its props
 * (`data-bascik-prop-*` receivers and `data-bascik-attr-*` bindings) and
 * whether it takes content (`data-bascik-slot`). So the catalog is read from
 * the component folder; there is no second schema to keep in sync.
 */
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

export interface CatalogEntry {
  /** The tag name, for example `book-card`. */
  name: string;
  /** The component's `@bascik` comment: what it is for and when to use it. */
  description: string;
  /** Prop names, in the order the component file first mentions them. */
  props: string[];
  /** True when the component has a default slot, so the tag may hold content. */
  slot: boolean;
}

export type Catalog = ReadonlyMap<string, CatalogEntry>;

const TAG_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/;
const DESCRIPTION = /<!--\s*@bascik\b([\s\S]*?)-->/;
const PROP_USE =
  /\bdata-bascik-prop-([a-z][a-z0-9-]*)|\bdata-bascik-attr-[a-z][a-z0-9-]*\s*=\s*["']([a-z][a-z0-9-]*)["']/g;

/** Describe one component from its file name and source text. */
export function describeComponent(
  fileName: string,
  source: string,
): CatalogEntry | null {
  const name = basename(fileName, ".html");
  if (!TAG_NAME.test(name)) return null;
  const description = (DESCRIPTION.exec(source)?.[1] ?? "")
    .replace(/\s+/g, " ")
    .trim();
  // Props are read from the markup only: a mention inside the description or
  // any other comment is prose, not a receiver.
  const markup = source.replace(/<!--[\s\S]*?-->/g, "");
  const props: string[] = [];
  for (const match of markup.matchAll(PROP_USE)) {
    const prop = match[1] ?? match[2];
    if (prop && !props.includes(prop)) props.push(prop);
  }
  return {
    name,
    description,
    props,
    slot: /\bdata-bascik-slot(?![-\w])/.test(markup),
  };
}

/**
 * Read every component in a folder (`<name>.html` or `<name>/<name>.html`).
 * Point it at a folder that holds only the components a model may write.
 */
export async function readCatalog(directory: string): Promise<Catalog> {
  const catalog = new Map<string, CatalogEntry>();
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const file = entry.isDirectory()
      ? join(directory, entry.name, `${entry.name}.html`)
      : entry.name.endsWith(".html")
        ? join(directory, entry.name)
        : null;
    if (!file) continue;
    let source: string;
    try {
      source = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const described = describeComponent(file, source);
    if (described) catalog.set(described.name, described);
  }
  return catalog;
}

/** One line a model can copy: `<book-card title="…" author="…">content</book-card>`. */
export function signature(entry: CatalogEntry): string {
  const props = entry.props.map((prop) => ` ${prop}="…"`).join("");
  return entry.slot
    ? `<${entry.name}${props}>content</${entry.name}>`
    : `<${entry.name}${props} />`;
}

/**
 * The part of a system prompt that teaches a model the output format and the
 * catalog. Deterministic for a given catalog, so it caches as a prompt prefix.
 */
export function catalogPrompt(catalog: Catalog): string {
  const lines = [
    "You answer in a chat interface that renders your reply as it streams.",
    "",
    "Write prose as plain text. You may use **bold**, `code`, lines starting with `# ` for headings, `- ` for bullets, and ``` fences for code. No other Markdown and no HTML: any tag that is not listed below is shown to the reader as literal text.",
    "",
    "When a visual answers better than prose, write one of these components. Each starts on its own line. Attribute values are plain text in double quotes. A component marked `content` may hold text or other listed components.",
    "",
  ];
  for (const entry of catalog.values()) {
    lines.push(signature(entry));
    if (entry.description) lines.push(`  ${entry.description}`);
    lines.push("");
  }
  lines.push(
    "Use only the attributes shown. Prefer a component over a long list or table of the same information, and keep the prose around it short.",
  );
  return lines.join("\n");
}
