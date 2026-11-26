/**
 * The markup the renderer writes itself, apart from catalog components: the
 * inline formatting of a run of text, and the plain HTML elements a renderer
 * may be told to pass through bare.
 */
import { esc } from "@bascik/bascik/html";

/** Escape a finished run of text and apply `**bold**` and `` `code` ``. */
export function inline(text: string): string {
  return esc(text)
    .replace(/`([^`\n]+)`/g, (_, code: string) => `<code>${code}</code>`)
    .replace(
      /\*\*([^*\n]+)\*\*/g,
      (_, bold: string) => `<strong>${bold}</strong>`,
    );
}

/**
 * Plain HTML elements a renderer may be told to pass through, for structure a
 * model already writes well and a component cannot express without one
 * instance per cell. They are passed on bare: every attribute is dropped.
 */
export const SAFE_ELEMENTS: ReadonlySet<string> = new Set([
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "ul",
  "ol",
  "li",
]);
