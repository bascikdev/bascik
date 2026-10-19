// scripts/llms-txt.ts: write dist/llms.txt (https://llmstxt.org) from the built pages' titles and descriptions.
// Register it as a post-phase exec script so it reads the finished output:
//
//   pipeline: { exec: [{ script: 'scripts/llms-txt.ts', phase: 'post' }] }
//
// An authored src/pages/llms.txt always wins: this script leaves it alone.
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const outDir = process.env.BASCIK_OUT_DIR ?? "dist";
const pagesDir = process.env.BASCIK_PAGES_DIR ?? "src/pages";
const siteUrl = process.env.BASCIK_SITE_URL?.replace(/\/+$/, "");
const base = (process.env.BASCIK_BASE || "/").replace(/\/$/, "");

const decode = (text: string) =>
  text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();

async function htmlFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await htmlFiles(full)));
    else if (entry.name.endsWith(".html")) out.push(full);
  }
  return out;
}

/** "/", "/about", or "/blog/post/" for a dist-relative HTML file. */
const pathOf = (file: string): string => {
  const rel = relative(outDir, file).split(sep).join("/");
  if (rel === "index.html") return "/";
  if (rel.endsWith("/index.html"))
    return `/${rel.slice(0, -"index.html".length)}`;
  return `/${rel.replace(/\.html$/, "")}`;
};

if (existsSync(join(pagesDir, "llms.txt"))) {
  console.log(
    "[llms-txt] src/pages/llms.txt exists; leaving the authored file in place.",
  );
} else {
  const pages: Array<{ path: string; title: string; description: string }> = [];
  for (const file of await htmlFiles(outDir)) {
    const name = relative(outDir, file);
    if (name === "404.html" || name === "500.html") continue;
    const html = await readFile(file, "utf8");
    // Minified output may drop attribute quotes, so they are optional here.
    if (/<meta[^>]+name=["']?robots["']?[^>]+noindex/i.test(html)) continue;
    const title = decode(/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? "");
    const description = decode(
      /<meta[^>]+name=["']?description["']?[^>]+content=(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i
        .exec(html)
        ?.slice(1)
        .find((v) => v !== undefined) ?? "",
    );
    if (title) pages.push({ path: pathOf(file), title, description });
  }
  pages.sort((a, b) =>
    a.path === "/" ? -1 : b.path === "/" ? 1 : a.path.localeCompare(b.path),
  );

  const url = (path: string) => `${siteUrl ?? ""}${base}${path}`;
  const home = pages.find((page) => page.path === "/");
  const lines = [`# ${home?.title ?? "Site"}`, ""];
  if (home?.description) lines.push(`> ${home.description}`, "");

  // Group sections by first path segment: /blog/ and /blog/a land under "Blog"; /about stays under "Pages".
  const groups = new Map<string, typeof pages>();
  for (const page of pages) {
    const parts = page.path.split("/").filter(Boolean);
    const segment =
      parts.length > 1 || (parts.length === 1 && page.path.endsWith("/"))
        ? parts[0]
        : "";
    const group = segment
      ? segment.replace(/[-_]/g, " ").replace(/^./, (c) => c.toUpperCase())
      : "Pages";
    groups.set(group, [...(groups.get(group) ?? []), page]);
  }
  for (const [group, entries] of groups) {
    lines.push(`## ${group}`, "");
    for (const page of entries)
      lines.push(
        `- [${page.title}](${url(page.path)})${page.description ? `: ${page.description}` : ""}`,
      );
    lines.push("");
  }
  await writeFile(join(outDir, "llms.txt"), lines.join("\n"));
  console.log(`[llms-txt] wrote llms.txt with ${pages.length} pages`);
}
