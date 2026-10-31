// The data-testid advisory for verify.mjs. Dependency-free; Node.js 22.22+.
// Lists the elements an end-to-end test needs a stable hook for and that have no data-testid: every component root,
// every control or ARIA widget, every element in the tab order, every form and dialog, and every landmark. A link that
// only navigates is left out: a test finds it by its role and name. Advisory by design: it never fails a check.
import { readFileSync } from "node:fs";
import { basename, dirname, relative } from "node:path";
import { listComponents } from "./components.mjs";
import { parseMarkup, walkElements } from "./markup.mjs";
import { componentRoots, pagesDirectory, walkFiles } from "./project.mjs";

const CONTROLS = new Set([
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "form",
  "dialog",
]);
const WIDGET_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "dialog",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "slider",
  "spinbutton",
  "switch",
  "tab",
]);
const LANDMARKS = new Set(["nav", "main", "aside"]);
/** A <header> or <footer> inside one of these is part of that section, not the page's banner or contentinfo. */
const SECTIONING = new Set(["article", "aside", "main", "nav", "section"]);
const NOT_ROOT = new Set(["style", "script", "link", "meta", "template"]);

const hasTestId = (node) =>
  "data-testid" in node.attrs || "data-bascik-attr-data-testid" in node.attrs;

const insideSection = (node) => {
  for (let up = node.parent; up && up.tag !== "#root"; up = up.parent)
    if (SECTIONING.has(up.tag)) return true;
  return false;
};

/** The part name to suggest for an element that needs a test id: its widget role, or its tag. */
function partOf(node) {
  const role = (node.attrs.role ?? "").trim().toLowerCase();
  if (WIDGET_ROLES.has(role)) return role;
  if (node.tag === "input")
    return node.attrs.name || node.attrs.type || "input";
  return node.tag;
}

/** Whether a test needs a data-testid on this element to find it reliably. */
function needsTestId(node) {
  if (
    node.tag === "input" &&
    (node.attrs.type ?? "").toLowerCase() === "hidden"
  )
    return false;
  if (CONTROLS.has(node.tag) || LANDMARKS.has(node.tag)) return true;
  if ((node.tag === "header" || node.tag === "footer") && !insideSection(node))
    return true;
  if (WIDGET_ROLES.has((node.attrs.role ?? "").trim().toLowerCase()))
    return true;
  return (node.attrs.tabindex ?? "").trim() === "0";
}

/** The component's root: its first element that is not a style, script, link, meta, or template tag. */
const rootOf = (tree) => tree.children.find((node) => !NOT_ROOT.has(node.tag));

/** The prefix to suggest for a page's test ids: its route, with "home" for the site's index page. */
function pageName(pagesDir, file) {
  const route = relative(pagesDir, file)
    .replace(/\\/g, "/")
    .replace(/\.html$/, "");
  if (route === "index") return "home";
  const name = basename(route) === "index" ? dirname(route) : route;
  return name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

/**
 * Elements without a data-testid in the project's components and pages, as `{ file, line, message }`, in file order.
 * A data-testid bound from a prop (data-bascik-attr-data-testid) counts. A component's own usage tags are skipped:
 * their test id comes from the component's root, or from a data-testid on the usage tag, which replaces it.
 */
export function testIdAdvisory(root, configModule) {
  const gaps = [];
  const fileOf = (path) => relative(root, path).replace(/\\/g, "/");
  const read = (path) => {
    try {
      return parseMarkup(readFileSync(path, "utf8"));
    } catch {
      return undefined;
    }
  };

  const components = listComponents(componentRoots(root, configModule), root);
  const trees = new Map(
    components.map((component) => [
      component.tag,
      read(`${root}/${component.file}`),
    ]),
  );
  /**
   * Whether a component renders a root a test can find. A component of head tags only (meta, link, script) has
   * none, and neither has one whose root is the usage tag of such a component, such as a shared <site-head>
   * that starts with <theme-init />. An unknown tag counts as body markup, so a typo'd name still gets a gap.
   */
  const rendersRoot = (tag, seen = new Set()) => {
    if (!trees.has(tag)) return true;
    if (seen.has(tag)) return true;
    seen.add(tag);
    const tree = trees.get(tag);
    const top = tree && rootOf(tree);
    if (!top) return !tree;
    return top.tag.includes("-") ? rendersRoot(top.tag, seen) : true;
  };

  for (const component of components) {
    const tree = trees.get(component.tag);
    if (!tree) continue;
    const name = component.tag;
    const top = rootOf(tree);
    if (top && !hasTestId(top) && rendersRoot(name))
      gaps.push({
        file: component.file,
        line: top.line,
        message: `<${top.tag}> root of <${name}> has no data-testid; add data-testid="${name}"`,
      });
    walkElements(tree, (node) => {
      if (node === top || node.tag.includes("-")) return;
      if (needsTestId(node) && !hasTestId(node))
        gaps.push({
          file: component.file,
          line: node.line,
          message: `<${node.tag}> in <${name}> has no data-testid; add data-testid="${name}-${partOf(node)}"`,
        });
    });
  }

  const pagesDir = pagesDirectory(root, configModule);
  for (const path of walkFiles(pagesDir, [".html"])) {
    const tree = read(path);
    if (!tree) continue;
    const name = pageName(pagesDir, path);
    walkElements(tree, (node) => {
      if (node.tag === "head") return false;
      if (node.tag.includes("-")) return;
      if (needsTestId(node) && !hasTestId(node))
        gaps.push({
          file: fileOf(path),
          line: node.line,
          message: `<${node.tag}> has no data-testid; add data-testid="${name}-${partOf(node)}"`,
        });
    });
  }
  return gaps;
}

/** The advisory as printed by verify.mjs, or "" when nothing is missing. */
export function formatTestIdAdvisory(gaps, docsUrl = "https://bascik.dev") {
  if (gaps.length === 0) return "";
  const count = `${gaps.length} element${gaps.length === 1 ? "" : "s"}`;
  return [
    `\n== NOTE  data-testid advisory: ${count} without a test id (advisory, does not change the exit code)`,
    ...gaps.map((gap) => `${gap.file}:${gap.line}  ${gap.message}`),
    `Tests find these with getByTestId(...), which still matches after a production build hashes class names and ids. ${docsUrl}/testing/e2e-testing`,
  ].join("\n");
}
