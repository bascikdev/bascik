/**
 * `shared-name-group`: name groups a component holds whole, and how many times a page renders the component.
 *
 * `name` is a page-level contract (WHATWG HTML): radios with one name and one form owner (or none, in one tree)
 * are one radio group, `<details>` with one name are one exclusive accordion, and `usemap="#x"` uses the first
 * `<map name="x">` in the tree. Bascik ships `name` as written unless a project opts in to
 * `scoping.attributes.name`, so a component that holds a whole group, used twice on a page, makes one group of
 * both copies.
 *
 * A group is held whole when the component has two or more radios (outside a `<form>` of its own, with no
 * `form` attribute) or two or more `<details>` with one literal name, or any `<map name>`. One radio or one
 * `<details>` per component is the opposite case, a group built from many instances, and is left alone. A name
 * bound to a prop (`data-bascik-attr-name`) differs per copy and is left alone too.
 */
import * as path from "node:path";
import { findComponentUsages } from "./component-usages.js";
import { scanHtmlTags } from "./references.js";
import {
  isInsideComponentRoots,
  isUsageSourcePath,
  type ProjectSnapshot,
} from "./project.js";

export type NameGroupKind = "radio" | "details" | "map";

/** A name group a component holds whole. */
export interface NameGroup {
  kind: NameGroupKind;
  /** The literal name. */
  name: string;
  /** How many elements in the component carry it. */
  count: number;
  /** The first element's `name` attribute, from its first character to the end of its value. */
  attributeStart: number;
  attributeEnd: number;
}

interface TagAttribute {
  /** Lower-cased. */
  name: string;
  value: string | undefined;
  start: number;
  end: number;
}

const isAttributeSpace = (code: number): boolean =>
  code === 9 || code === 10 || code === 12 || code === 13 || code === 32;

/** The attributes of the open tag whose attribute part runs from `from` to its `>` at `end - 1`, as a browser reads them. */
function readAttributes(
  html: string,
  from: number,
  end: number,
): TagAttribute[] {
  const attributes: TagAttribute[] = [];
  const stop = end - 1;
  let at = from;
  while (at < stop) {
    const code = html.charCodeAt(at);
    if (isAttributeSpace(code) || code === 47 /* / */) {
      at++;
      continue;
    }
    const start = at;
    // An attribute name starts with any character, `=` included, and runs to space, `/`, `>` or `=`.
    at++;
    while (at < stop) {
      const c = html.charCodeAt(at);
      if (isAttributeSpace(c) || c === 47 || c === 61 /* = */) break;
      at++;
    }
    const name = html.slice(start, at).toLowerCase();
    let cursor = at;
    while (cursor < stop && isAttributeSpace(html.charCodeAt(cursor))) cursor++;
    let value: string | undefined;
    if (cursor < stop && html.charCodeAt(cursor) === 61) {
      cursor++;
      while (cursor < stop && isAttributeSpace(html.charCodeAt(cursor)))
        cursor++;
      const quote = html[cursor];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, cursor + 1);
        const valueEnd = close === -1 || close > stop ? stop : close;
        value = html.slice(cursor + 1, valueEnd);
        cursor = Math.min(valueEnd + 1, stop);
      } else {
        const valueStart = cursor;
        while (cursor < stop && !isAttributeSpace(html.charCodeAt(cursor)))
          cursor++;
        value = html.slice(valueStart, cursor);
      }
      at = cursor;
    }
    attributes.push({ name, value, start, end: at });
  }
  return attributes;
}

/** The first attribute named `name`: a browser keeps the first of duplicates. */
const attributeNamed = (
  attributes: TagAttribute[],
  name: string,
): TagAttribute | undefined =>
  attributes.find((attribute) => attribute.name === name);

/**
 * The name groups `html` (a component's source) holds whole, in source order of their first element. Tags in
 * comments and in `<script>`, `<style>` and `<textarea>` bodies do not count.
 */
export function findNameGroups(html: string): NameGroup[] {
  if (!/\bname\s*=/i.test(html)) return [];
  const groups = new Map<string, NameGroup>();
  let formDepth = 0;
  for (const tag of scanHtmlTags(html)) {
    const tagName = tag.name.toLowerCase();
    if (tagName === "form") {
      formDepth = tag.closing ? Math.max(0, formDepth - 1) : formDepth + 1;
      continue;
    }
    if (
      tag.closing ||
      (tagName !== "input" && tagName !== "details" && tagName !== "map")
    )
      continue;
    const attributes = readAttributes(
      html,
      tag.nameStart + tag.name.length,
      tag.end,
    );
    // A bound name differs per copy (the binding wins over a literal name).
    if (attributeNamed(attributes, "data-bascik-attr-name")) continue;
    const nameAttribute = attributeNamed(attributes, "name");
    const name = nameAttribute?.value;
    if (!nameAttribute || !name) continue;
    let kind: NameGroupKind;
    if (tagName === "input") {
      const type = attributeNamed(attributes, "type")?.value;
      if (type?.trim().toLowerCase() !== "radio") continue;
      // Inside the component's own form, each copy's radios have their own form owner. A `form` attribute
      // ties the radio to a form elsewhere, which this file cannot judge.
      if (formDepth > 0 || attributeNamed(attributes, "form")) continue;
      kind = "radio";
    } else {
      kind = tagName === "details" ? "details" : "map";
    }
    const key = `${kind}\u0000${name}`;
    const group = groups.get(key);
    if (group) group.count++;
    else
      groups.set(key, {
        kind,
        name,
        count: 1,
        attributeStart: nameAttribute.start,
        attributeEnd: nameAttribute.end,
      });
  }
  return [...groups.values()].filter(
    (group) => group.kind === "map" || group.count >= 2,
  );
}

/** The page that renders a component most often, and how often. */
export interface PageInstances {
  /** Absolute path. */
  page: string;
  count: number;
}

/**
 * The page that renders `componentName` most often, counting instances through nested components (once in a
 * wrapper a page uses twice is twice), with open buffers' unsaved text in place of the files on disk. Pages
 * are the HTML the project tracks outside the component roots. Undefined when no page renders it.
 */
export function countInstancesOnPages(
  componentName: string,
  snapshot: ProjectSnapshot,
  openDocumentTexts: { fsPath: string; text: string }[],
): PageInstances | undefined {
  const target = componentName.toLowerCase();
  const isComponentFile = (file: string) =>
    isInsideComponentRoots(file.replace(/\\/g, "/"), snapshot.componentRoots);
  const pages = new Map<string, string>();
  for (const [file, html] of snapshot.htmlUsageByFile)
    if (!isComponentFile(file)) pages.set(file, html);
  const openText = new Map<string, string>();
  for (const { fsPath, text } of openDocumentTexts) {
    openText.set(fsPath, text);
    if (
      fsPath.toLowerCase().endsWith(".html") &&
      !isComponentFile(fsPath) &&
      (pages.has(fsPath) || isUsageSourcePath(fsPath, snapshot))
    )
      pages.set(fsPath, text);
  }
  const names = new Set(snapshot.componentMap.keys());
  const sourceOf = (name: string): string | undefined => {
    const file = snapshot.componentMap.get(name);
    if (!file) return undefined;
    return openText.get(file) ?? snapshot.componentSourceByFile?.get(file);
  };

  // Instances of the target one instance of `name` renders. A component reached again while it is being
  // counted (components that use each other) adds nothing: the compiler stops such a loop at its limits.
  const within = new Map<string, number>();
  const visiting = new Set<string>();
  const instancesWithin = (name: string): number => {
    const known = within.get(name);
    if (known !== undefined) return known;
    if (visiting.has(name)) return 0;
    const source = sourceOf(name);
    if (source === undefined) return 0;
    visiting.add(name);
    let count = 0;
    for (const usage of findComponentUsages(source, names))
      count += usage.name === target ? 1 : instancesWithin(usage.name);
    visiting.delete(name);
    within.set(name, count);
    return count;
  };

  let best: PageInstances | undefined;
  for (const [page, html] of [...pages].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    let count = 0;
    for (const usage of findComponentUsages(html, names))
      count += usage.name === target ? 1 : instancesWithin(usage.name);
    if (count > 0 && (!best || count > best.count)) best = { page, count };
  }
  return best;
}

const PROP_FIX =
  'give each copy its own name through a prop: data-bascik-attr-name="group" in place of name here, and data-bascik-prop-group="..." with a different value on each';

/** The warning for `group` in `component`, which `instances.page` renders `instances.count` times. */
export function sharedNameGroupMessage(
  group: NameGroup,
  component: string,
  instances: PageInstances,
  projectRoot: string,
): string {
  const page = path.relative(projectRoot, instances.page).replace(/\\/g, "/");
  const used = `<${component}> is used ${instances.count} times on ${page}`;
  const name = `name="${group.name}"`;
  switch (group.kind) {
    case "radio":
      return `${name} is on ${group.count} radios with no <form> of their own, and ${used}, so the copies act as one radio group on the page: choosing in one copy clears the others. Wrap the radios in the component's own <form>, or ${PROP_FIX} <${component}>.`;
    case "details":
      return `${name} is on ${group.count} <details>, and ${used}, so the copies act as one exclusive accordion on the page: opening an item in one copy closes the open item in the others. To give each copy its own group, ${PROP_FIX} <${component}>. For one accordion across the copies on purpose, ignore this with bascik-ignore shared-name-group.`;
    case "map":
      return `<map ${name}> is declared once per copy, and ${used}, so the page has ${instances.count} maps named "${group.name}" and every usemap="#${group.name}" uses the first. Give each copy its own map name through props (data-bascik-attr-name on the <map>, data-bascik-attr-usemap on the <img>), or move the map out of the component.`;
  }
}
