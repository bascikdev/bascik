/**
 * Measures how well a reply followed the output format: which tags the model
 * wrote, and which of them the renderer had to turn into text or trim. Use it
 * to evaluate a model or a prompt, or to log format drift in production.
 */
import type { Catalog } from "./catalog.ts";
import { renderText, type RendererOptions } from "./render.ts";

export interface ReplyReport {
  /** Catalog components written, by name. */
  components: Record<string, number>;
  /** Passed-through HTML elements written, by name. */
  elements: Record<string, number>;
  /** Tags the format does not allow. The reader saw these as literal text. */
  unknownTags: Record<string, number>;
  /** Attributes a component does not declare, as `tag.attribute`. They were dropped. */
  unknownProps: Record<string, number>;
  /** Catalog elements still open when the reply ended. */
  unclosed: number;
  /** True when nothing above went wrong. */
  clean: boolean;
}

const count = (into: Record<string, number>, key: string): void => {
  into[key] = (into[key] ?? 0) + 1;
};

export function analyzeReply(
  text: string,
  catalog: Catalog,
  options: RendererOptions = {},
): ReplyReport {
  const elements = new Set(options.elements ?? []);
  const report: ReplyReport = {
    components: {},
    elements: {},
    unknownTags: {},
    unknownProps: {},
    unclosed: 0,
    clean: true,
  };
  // Code fences and inline code are shown as written, so tags there are not
  // format mistakes.
  const prose = text
    .replace(/^```[\s\S]*?^```/gm, "")
    .replace(/`[^`\n]*`/g, "");
  const open: string[] = [];
  for (const tag of prose.matchAll(
    /<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g,
  )) {
    const name = tag[2]!.toLowerCase();
    const entry = catalog.get(name);
    const known = entry !== undefined || elements.has(name);
    if (tag[1]) {
      if (known && open.at(-1) === name) open.pop();
      continue;
    }
    if (!known) {
      count(report.unknownTags, name);
      continue;
    }
    count(entry ? report.components : report.elements, name);
    // Each match consumes a whole attribute, value included, so a word inside
    // a quoted value is never read as an attribute name.
    for (const attribute of tag[3]!.matchAll(
      /([A-Za-z_][-\w:.]*)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?/g,
    )) {
      const prop = attribute[1]!.toLowerCase();
      if (!entry?.props.includes(prop)) {
        count(report.unknownProps, `${name}.${prop}`);
      }
    }
    if (!tag[4]) open.push(name);
  }
  report.unclosed = open.length;
  // The renderer is the last word: anything it had to escape is a leak.
  const leaked = renderText(text, catalog, options).match(
    /&lt;\/?[a-z][a-z0-9-]*/g,
  );
  for (const tag of leaked ?? []) {
    const name = tag.replace(/^&lt;\/?/, "");
    if (!(name in report.unknownTags) && !/^```/m.test(text))
      count(report.unknownTags, name);
  }
  report.clean =
    Object.keys(report.unknownTags).length === 0 &&
    Object.keys(report.unknownProps).length === 0 &&
    report.unclosed === 0;
  return report;
}
