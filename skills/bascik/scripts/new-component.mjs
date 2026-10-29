#!/usr/bin/env node
// Create a Bascik component that follows the conventions: hyphenated lowercase name, folder layout,
// <style> above the markup, <script> below it, id-based element lookup, a data-testid on the root, TypeScript
// scripts unless JavaScript is asked for, and an @bascik metadata comment.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { join, relative, resolve } from "node:path";
import {
  componentRoots,
  fail,
  findProjectRoot,
  isMain,
  loadProjectConfig,
} from "./lib/project.mjs";
import { listComponents, tagNameProblem } from "./lib/components.mjs";

const HELP = `Usage: node new-component.mjs <tag-name> [options]

Creates src/components/<tag-name>/<tag-name>.html (in the first component root) following Bascik conventions.

Options:
  --description <text>  One-line description for the @bascik metadata comment
  --props <a,b>         Text props to scaffold (data-bascik-prop-*)
  --slot                Add a default slot (data-bascik-slot)
  --slots <a,b>         Add named slots
  --css                 Put styles in a companion <tag-name>.css instead of an inline <style>
  --no-style            Do not create any styles
  --script <kind>       none (default); inline (<script type="text/typescript">) or ts (a companion .ts loaded
                        with <script src>); inline-js or js only when the person asked for JavaScript
  --flat                Create <root>/<tag-name>.html without a folder
  --root-dir <dir>      Component root to write into (default: first directory.components entry)
  --dry-run             Print the files without writing them
  --force               Overwrite existing files
  --help                Show this message

Examples:
  node new-component.mjs feature-card --props title,body --slot
  node new-component.mjs nav-toggle --script ts --css
  node new-component.mjs menu-button --script inline`;

const list = (value) =>
  String(value ?? "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);

/** Build the files for a component. Exported for tests. */
export function buildComponentFiles(tag, options = {}) {
  const props = options.props ?? [];
  const namedSlots = options.slots ?? [];
  const defaultSlot = Boolean(options.slot);
  const style = options.style ?? "inline"; // inline | css | none
  const script = options.script ?? "none"; // none | inline | inline-js | js | ts

  for (const name of [...props, ...namedSlots]) {
    if (!/^[a-z][a-z0-9-]*$/.test(name))
      throw new Error(
        `"${name}" is not a valid prop or slot name (lowercase letters, digits, hyphens).`,
      );
  }

  const meta = [
    `<!-- @bascik`,
    options.description?.trim() ||
      `TODO: describe what <${tag}> renders and when to use it.`,
  ];
  for (const prop of props)
    meta.push(`@prop ${prop} - TODO: describe ${prop}.`);
  if (defaultSlot)
    meta.push("@slot default - TODO: describe the default slot content.");
  for (const slot of namedSlots)
    meta.push(`@slot ${slot} - TODO: describe the ${slot} slot.`);
  meta.push("-->");

  const css = [`.${tag} {`, "  display: block;", "}", ""].join("\n");
  const body = [`<div class="${tag}" id="root" data-testid="${tag}">`];
  for (const prop of props) body.push(`  <p data-bascik-prop-${prop}></p>`);
  for (const slot of namedSlots)
    body.push(`  <div data-bascik-slot="${slot}"></div>`);
  if (defaultSlot) body.push("  <div data-bascik-slot></div>");
  body.push("</div>");

  const comment = [
    "// Find elements by id: Bascik rewrites the id per instance, so every copy of this component",
    "// controls only its own elements. Never use querySelector with a class to find a per-instance element.",
  ];
  const typed = script === "inline" || script === "ts";
  const scriptBody = [
    ...comment,
    typed
      ? 'const root = document.getElementById("root") as HTMLElement;'
      : 'const root = document.getElementById("root");',
  ];

  const files = {};
  const html = [...meta];
  if (style === "inline")
    html.push(
      "<style>",
      ...css
        .trimEnd()
        .split("\n")
        .map((line) => `  ${line}`),
      "</style>",
    );
  html.push(...body);
  if (script === "inline" || script === "inline-js")
    html.push(
      script === "inline" ? '<script type="text/typescript">' : "<script>",
      ...scriptBody.map((line) => `  ${line}`),
      "</script>",
    );
  if (script === "js" || script === "ts")
    html.push(`<script src="${tag}.${script}"></script>`);
  files[`${tag}.html`] = `${html.join("\n")}\n`;
  if (style === "css") files[`${tag}.css`] = css;
  if (script === "js" || script === "ts") {
    files[`${tag}.${script}`] = `${scriptBody.join("\n")}\n`;
  }
  return files;
}

/** The usage snippet for a component. Exported for tests. */
export function usageSnippet(tag, options = {}) {
  const attrs = (options.props ?? [])
    .map((prop) => ` data-bascik-prop-${prop}="..."`)
    .join("");
  const named = (options.slots ?? [])
    .map((slot) => `\n  <div data-bascik-slot="${slot}">...</div>`)
    .join("");
  if (!options.slot && !named) return `<${tag}${attrs} />`;
  return `<${tag}${attrs}>${named}${options.slot ? "\n  ..." : ""}\n</${tag}>`;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      description: { type: "string" },
      props: { type: "string" },
      slot: { type: "boolean", default: false },
      slots: { type: "string" },
      css: { type: "boolean", default: false },
      "no-style": { type: "boolean", default: false },
      script: { type: "string", default: "none" },
      flat: { type: "boolean", default: false },
      "root-dir": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) return console.log(HELP);
  const tag = positionals[0];
  const problem = tagNameProblem(tag);
  if (problem) fail(`new-component: ${problem}.\n\n${HELP}`, 2);
  if (!["none", "inline", "inline-js", "js", "ts"].includes(values.script))
    fail(
      "new-component: --script must be none, inline, ts, inline-js, or js.",
      2,
    );

  const root = findProjectRoot();
  const config = await loadProjectConfig(root);
  if (config?.error)
    fail(
      `new-component: could not load ${config.path}: ${config.error.message}`,
    );
  const roots = componentRoots(root, config?.module);

  const existing = listComponents(roots, root).find((c) => c.tag === tag);
  if (existing && !values.force) {
    fail(
      `new-component: <${tag}> already exists at ${existing.file}. Component names must be unique across all roots. Use --force to overwrite.`,
    );
  }

  const options = {
    description: values.description,
    props: list(values.props),
    slot: values.slot,
    slots: list(values.slots),
    style: values["no-style"] ? "none" : values.css ? "css" : "inline",
    script: values.script,
  };
  let files;
  try {
    files = buildComponentFiles(tag, options);
  } catch (error) {
    fail(`new-component: ${error.message}`, 2);
  }

  const targetRoot = values["root-dir"]
    ? resolve(root, values["root-dir"])
    : roots[0];
  const dir = values.flat ? targetRoot : join(targetRoot, tag);
  const written = [];
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    const rel = relative(root, path).replace(/\\/g, "/");
    if (values["dry-run"]) {
      console.log(`--- ${rel}\n${content}`);
      continue;
    }
    if (existsSync(path) && !values.force)
      fail(`new-component: ${rel} already exists. Use --force to overwrite.`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, content, "utf8");
    written.push(rel);
  }

  if (!values["dry-run"])
    console.log(`Created:\n${written.map((file) => `  ${file}`).join("\n")}`);
  console.log(
    `\nUse it:\n  ${usageSnippet(tag, options).split("\n").join("\n  ")}`,
  );
  console.log(
    "\nNext: replace the TODO lines in the @bascik comment, then check the output with preview.mjs.",
  );
}

if (isMain(import.meta.url)) await main();
