#!/usr/bin/env node
// Inventory the components in a Bascik project: tag, file, props, slots, companion files, and descriptions.
import { parseArgs } from "node:util";
import { relative } from "node:path";
import {
  componentRoots,
  fail,
  findProjectRoot,
  isMain,
  loadProjectConfig,
} from "./lib/project.mjs";
import { listComponents } from "./lib/components.mjs";

const HELP = `Usage: node list-components.mjs [<tag-filter>] [--json] [--root <dir>]

Lists every component in the project's component roots (directory.components, default src/components)
with its props, slots, companion files, script directives, and @bascik description.
Run it before creating a component so you reuse what already exists.

Options:
  --json        Print JSON
  --root <dir>  Project root (default: nearest Bascik project above the current directory)
  --help        Show this message`;

function formatComponent(c) {
  const lines = [`<${c.tag}>  ${c.file}`];
  if (c.description) lines.push(`  ${c.description}`);
  if (c.props?.length) {
    lines.push(
      `  props: ${c.props.map((p) => `${p.name}${p.target !== "content" ? ` (-> ${p.target})` : ""}${p.description ? `: ${p.description}` : ""}`).join("; ")}`,
    );
  }
  if (c.slots?.length) {
    lines.push(
      `  slots: ${c.slots.map((s) => `${s.name}${s.description ? `: ${s.description}` : ""}`).join("; ")}`,
    );
  }
  if (c.companions?.length) lines.push(`  files: ${c.companions.join(", ")}`);
  if (c.directives?.length)
    lines.push(
      `  scripts: ${c.directives.map((d) => `data-bascik-${d}`).join(", ")}`,
    );
  if (c.uses?.length)
    lines.push(`  uses: ${c.uses.map((t) => `<${t}>`).join(" ")}`);
  const usage = c.slots?.length ? `<${c.tag}>...</${c.tag}>` : `<${c.tag} />`;
  lines.push(`  usage: ${usage}`);
  if (c.nameProblem) lines.push(`  warning: ${c.nameProblem}`);
  if (c.duplicate)
    lines.push("  error: another component has the same tag name");
  if (c.error) lines.push(`  error: ${c.error}`);
  return lines.join("\n");
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      root: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) return console.log(HELP);

  const root = values.root ? findProjectRoot(values.root) : findProjectRoot();
  const config = await loadProjectConfig(root);
  if (config?.error) {
    process.stderr.write(
      `list-components: could not load ${config.path} (${config.error.message}); using default component roots.\n`,
    );
  }
  const roots = componentRoots(root, config?.module);
  let components = listComponents(roots, root);
  const filter = positionals[0]?.toLowerCase();
  if (filter) components = components.filter((c) => c.tag.includes(filter));

  if (values.json) {
    console.log(
      JSON.stringify({ root, componentRoots: roots, components }, null, 2),
    );
    return;
  }
  const rootList = roots
    .map((r) => relative(root, r).replace(/\\/g, "/") || ".")
    .join(", ");
  if (components.length === 0) {
    console.log(
      filter
        ? `No components matching "${filter}" in ${rootList}.`
        : `No components found in ${rootList}.`,
    );
    return;
  }
  console.log(
    `${components.length} component${components.length === 1 ? "" : "s"} in ${rootList}\n`,
  );
  console.log(components.map(formatComponent).join("\n\n"));
}

if (isMain(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    fail(`list-components: ${error.message}`);
  }
}
