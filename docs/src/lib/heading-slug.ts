/**
 * heading-slug.ts: One definition of how a rendered heading becomes an id.
 *
 * The Markdown renderer (md-renderer.ts) stamps these ids on h2/h3 headings and
 * the "On this page" table of contents (render-nav.ts) links to them, so both
 * must derive the id from the same input: the heading's rendered inline HTML.
 */

import { decodeHtmlText } from "./html-entities.ts";

/** Plain text of a heading's rendered inline HTML (tags removed, entities decoded). */
export function headingPlainText(headingHtml: string): string {
  let stripped = headingHtml;
  let previous: string;
  do {
    previous = stripped;
    stripped = stripped.replace(/<[^>]+>/g, "");
  } while (stripped !== previous);
  return decodeHtmlText(stripped);
}

/** The id for a heading, from its rendered inline HTML. */
export function slugFromHeadingHtml(headingHtml: string): string {
  return headingPlainText(headingHtml)
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}
