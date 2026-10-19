// Lightweight, dependency-free analysis of Bascik component templates. Heuristic by design: the authoritative
// analysis lives in @bascik/language-server and the compiler. This is enough to inventory a project.
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { walkFiles } from "./project.mjs";

/** WHATWG reserved names that contain a hyphen but are not valid custom element names. */
export const RESERVED_HYPHENATED = new Set([
  "annotation-xml",
  "color-profile",
  "font-face",
  "font-face-src",
  "font-face-uri",
  "font-face-format",
  "font-face-name",
  "missing-glyph",
]);

/** Lowercase, starts with a letter, at least one hyphen, no trailing or doubled hyphens. */
export const TAG_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/;

/** Explain why `name` is not a good component tag name, or return undefined when it is fine. */
export function tagNameProblem(name) {
  if (!name) return "a tag name is required";
  if (name !== name.toLowerCase())
    return `use lowercase: "${name.toLowerCase()}"`;
  if (!name.includes("-"))
    return `custom element names need a hyphen, for example "my-${name}" or "site-${name}"`;
  if (!TAG_NAME_PATTERN.test(name))
    return "use letters and digits separated by single hyphens, starting with a letter";
  if (RESERVED_HYPHENATED.has(name))
    return `"${name}" is reserved by the HTML standard`;
  return undefined;
}

const blank = (match) => " ".repeat(match.length);

/** Replace the contents of comments, <script>, <style>, and <textarea> with spaces so they are never parsed as markup. */
export function maskRawText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(
      /(<(script|style|textarea)\b[^>]*>)([\s\S]*?)(<\/\2\s*>)/gi,
      (_m, open, _tag, body, close) => open + blank(body) + close,
    );
}

/** Blank out the inner content of nested custom elements (usage sites of other components). */
function maskNestedComponents(html) {
  // The opening tag must not be self-closing, or the match would run on to a later closing tag.
  const pattern =
    /(<([a-z][a-z0-9]*-[a-z0-9-]*)(?:\s[^>]*)?(?<!\/)>)([\s\S]*?)(<\/\2\s*>)/gi;
  return html.replace(
    pattern,
    (_match, open, _tag, inner, close) => open + blank(inner) + close,
  );
}

/** Parse the leading <!-- @bascik ... --> comment. */
export function parseMetadataComment(html) {
  const match =
    /^\s*(?:<!--(?![\s\S]*?@bascik)[\s\S]*?-->\s*)*<!--\s*@bascik\b([\s\S]*?)-->/.exec(
      html,
    );
  if (!match) return { description: "", props: {}, slots: {} };
  const description = [];
  const props = {};
  const slots = {};
  for (const raw of match[1].split("\n")) {
    const line = raw.trim();
    const member = /^@(prop|slot)\s+([\w-]+)\s*(?:-\s*(.*))?$/.exec(line);
    if (member) {
      (member[1] === "prop" ? props : slots)[member[2]] = (
        member[3] ?? ""
      ).trim();
    } else if (line && !line.startsWith("@")) {
      description.push(line);
    }
  }
  return { description: description.join(" "), props, slots };
}

/** Analyze one component template's source. */
export function analyzeTemplate(html) {
  const meta = parseMetadataComment(html);
  const masked = maskRawText(html);
  const own = maskNestedComponents(masked);

  const props = new Map();
  for (const m of masked.matchAll(
    /\bdata-bascik-prop-([a-z0-9][a-z0-9-]*)(?=[\s/>])(?!\s*=)/gi,
  )) {
    props.set(m[1].toLowerCase(), {
      name: m[1].toLowerCase(),
      target: "content",
    });
  }
  for (const m of masked.matchAll(
    /\bdata-bascik-attr-([a-z0-9][a-z0-9-]*)\s*=\s*["']([a-z0-9-]+)["']/gi,
  )) {
    const name = m[2].toLowerCase();
    const existing = props.get(name);
    props.set(name, {
      name,
      target: existing ? `${existing.target}, ${m[1]}` : m[1],
    });
  }

  const slots = new Set();
  if (/\bdata-bascik-slot(?=[\s/>])(?!\s*=)/i.test(masked))
    slots.add("default");
  for (const m of own.matchAll(/\bdata-bascik-slot\s*=\s*["']([^"']+)["']/gi))
    slots.add(m[1]);

  const directives = new Set();
  for (const m of masked.matchAll(
    /<script\b[^>]*\bdata-bascik-(build|routes|server|stream|dev)\b/gi,
  )) {
    directives.add(m[1].toLowerCase());
  }
  const scriptSources = [
    ...masked.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi),
  ].map((m) => m[1]);
  const nested = [
    ...new Set(
      [...own.matchAll(/<([a-z][a-z0-9]*-[a-z0-9-]*)\b/gi)].map((m) =>
        m[1].toLowerCase(),
      ),
    ),
  ];

  return {
    description: meta.description,
    props: [...props.values()].map((p) => ({
      ...p,
      description: meta.props[p.name] ?? "",
    })),
    slots: [...slots].map((name) => ({
      name,
      description: meta.slots[name] ?? "",
    })),
    hasStyle: /<style\b/i.test(html),
    hasClientScript:
      /<script(?![^>]*\bdata-bascik-(?:build|routes|server|stream))(?![^>]*\btype\s*=\s*["']application\/)[^>]*>/i.test(
        masked,
      ),
    directives: [...directives],
    scriptSources,
    uses: nested,
  };
}

/** Inventory every component under the given roots. */
export function listComponents(roots, projectRoot) {
  const components = [];
  for (const root of roots) {
    for (const file of walkFiles(root, [".html"])) {
      const tag = basename(file, ".html").toLowerCase();
      const dir = dirname(file);
      const base = basename(file, ".html");
      const companions = [".css", ".ts", ".js", ".mjs"]
        .map((ext) => join(dir, base + ext))
        .filter((path) => existsSync(path))
        .map((path) => relative(projectRoot, path).replace(/\\/g, "/"));
      let analysis;
      try {
        analysis = analyzeTemplate(readFileSync(file, "utf8"));
      } catch (error) {
        analysis = { error: String(error.message) };
      }
      components.push({
        tag,
        file: relative(projectRoot, file).replace(/\\/g, "/"),
        nameProblem: tagNameProblem(tag),
        companions,
        ...analysis,
      });
    }
  }
  const counts = new Map();
  for (const c of components) counts.set(c.tag, (counts.get(c.tag) ?? 0) + 1);
  for (const c of components) if (counts.get(c.tag) > 1) c.duplicate = true;
  return components.sort((a, b) => a.tag.localeCompare(b.tag));
}
