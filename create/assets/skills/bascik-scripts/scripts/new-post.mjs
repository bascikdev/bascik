#!/usr/bin/env node
// Create content/posts/<slug>.md with valid front matter. Dependency-free; Node 22.22+. Run from the project root.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const HELP = `Usage: node new-post.mjs "Post title" [--description "..."] [--tags a,b] [--date YYYY-MM-DD] [--slug custom-slug] [--draft] [--dir content/posts]

Writes content/posts/<slug>.md with the front matter that the starter site's src/lib/posts.ts validates (https://github.com/bascikdev/bascik/tree/main/examples/starter-site).
The slug comes from the title unless --slug is given. Refuses to overwrite an existing post.`;

/** Lowercase words joined by hyphens, ASCII only. Exported for tests. */
export function slugify(title) {
  return title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
}

/** Quote a front matter string when it contains characters the parser would misread. */
const quote = (value) =>
  /^[\w .,!?()/-]*$/.test(value) && !/^(true|false|-?\d+(\.\d+)?)$/.test(value)
    ? value
    : JSON.stringify(value);

/** The Markdown source for a new post. Exported for tests. */
export function postSource({
  title,
  description,
  date,
  tags = [],
  draft = false,
}) {
  const lines = [
    "---",
    `title: ${quote(title)}`,
    `description: ${quote(description)}`,
    `date: ${date}`,
  ];
  if (tags.length) lines.push(`tags: [${tags.join(", ")}]`);
  if (draft) lines.push("draft: true");
  lines.push("---", "", "Write the post here.", "");
  return lines.join("\n");
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      description: { type: "string" },
      tags: { type: "string", default: "" },
      date: { type: "string" },
      slug: { type: "string" },
      draft: { type: "boolean", default: false },
      dir: { type: "string", default: "content/posts" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help || positionals.length === 0) return console.log(HELP);

  const title = positionals.join(" ").trim();
  const slug = values.slug ?? slugify(title);
  const date = values.date ?? new Date().toISOString().slice(0, 10);
  const tags = values.tags
    .split(",")
    .map((tag) => slugify(tag))
    .filter(Boolean);
  const errors = [];
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
    errors.push(`slug "${slug}" must be lowercase words joined by hyphens`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)))
    errors.push(`date "${date}" must be YYYY-MM-DD`);
  if (errors.length) {
    process.stderr.write(`new-post: ${errors.join("; ")}\n`);
    process.exit(1);
  }

  const file = resolve(values.dir, `${slug}.md`);
  if (existsSync(file)) {
    process.stderr.write(
      `new-post: ${relative(process.cwd(), file)} already exists. Pick another title or --slug.\n`,
    );
    process.exit(1);
  }
  mkdirSync(dirname(file), { recursive: true });
  // A placeholder description keeps the post valid; the TODO makes it easy to find before publishing.
  writeFileSync(
    file,
    postSource({
      title,
      description: values.description ?? `TODO: one sentence about ${title}.`,
      date,
      tags,
      draft: values.draft,
    }),
  );
  console.log(
    `Created ${relative(process.cwd(), file) || join(values.dir, `${slug}.md`)} -> /blog/${slug}/`,
  );
}

const invokedDirectly =
  Boolean(process.argv[1]) &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) main();
