/**
 * Reads one opening tag from model output. A tag survives only when its name
 * is in the catalog, and only the props its component declares are kept, as
 * escaped `data-bascik-prop-*` values. Anything else means the `<` is text.
 */
import { esc } from "@bascik/bascik/html";
import type { Catalog, CatalogEntry } from "../catalog.ts";
import type { OpenTag } from "./types.ts";

/** A tag is not all here yet: wait for more of the stream. */
export const WAIT = Symbol("wait");

const NAME = /<([a-z][a-z0-9-]*)/y;
const ATTRIBUTE = /[A-Za-z_][-\w:.]*/y;
const BARE_VALUE = /[^\s>]+/y;

function skipSpace(source: string, at: number): number {
  while (at < source.length && /\s/.test(source[at]!)) at++;
  return at;
}

function openTagHtml(entry: CatalogEntry, props: Map<string, string>): string {
  let tag = `<${entry.name}`;
  for (const prop of entry.props) {
    const value = props.get(prop);
    if (value !== undefined) {
      tag += ` data-bascik-prop-${prop}="${esc(value)}"`;
    }
  }
  return `${tag}>`;
}

/**
 * Parse the opening tag at the start of `source`, which begins with `<`.
 * Null means this is not a catalog tag and the `<` is text.
 */
export function parseOpenTag(
  catalog: Catalog,
  source: string,
): OpenTag | typeof WAIT | null {
  NAME.lastIndex = 0;
  const named = NAME.exec(source);
  if (!named) return null;
  let position = NAME.lastIndex;
  if (position >= source.length) return WAIT;
  const entry = catalog.get(named[1]!);
  if (!entry || !/[\s/>]/.test(source[position]!)) return null;

  const props = new Map<string, string>();
  for (;;) {
    position = skipSpace(source, position);
    if (position >= source.length) return WAIT;
    if (source[position] === ">") {
      return {
        entry,
        html: openTagHtml(entry, props),
        selfClosed: false,
        end: position + 1,
      };
    }
    if (source[position] === "/") {
      if (position + 1 >= source.length) return WAIT;
      if (source[position + 1] !== ">") return null;
      return {
        entry,
        html: openTagHtml(entry, props),
        selfClosed: true,
        end: position + 2,
      };
    }
    ATTRIBUTE.lastIndex = position;
    const attribute = ATTRIBUTE.exec(source);
    if (!attribute) return null;
    position = skipSpace(source, ATTRIBUTE.lastIndex);
    if (position >= source.length) return WAIT;
    let value = "";
    if (source[position] === "=") {
      position = skipSpace(source, position + 1);
      if (position >= source.length) return WAIT;
      const quote = source[position]!;
      if (quote === '"' || quote === "'") {
        const close = source.indexOf(quote, position + 1);
        if (close < 0) return WAIT;
        value = source.slice(position + 1, close);
        position = close + 1;
      } else {
        BARE_VALUE.lastIndex = position;
        const bare = BARE_VALUE.exec(source);
        if (!bare) return null;
        if (BARE_VALUE.lastIndex >= source.length) return WAIT;
        value = bare[0];
        position = BARE_VALUE.lastIndex;
      }
    }
    props.set(attribute[0].toLowerCase(), value);
  }
}
