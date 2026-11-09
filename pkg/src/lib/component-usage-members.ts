/**
 * What a usage passes that its template never declares (findings 47 and 23).
 *
 * A named slot the template does not declare, a prop no receiver or binding
 * reads, and children given to a template with no default slot are all
 * dropped from the output. `bascik --check` reports them through the language
 * server's `undeclared-slot` and `undeclared-prop` rules; these helpers let
 * the build and dev server say the same thing as they render, with the same
 * reading of the template: comments, `<script>`, `<style>`, and `<textarea>`
 * content declare nothing.
 */
import { maskRawTextContent } from "./component-masking.ts";

export interface DeclaredMembers {
  /** Lowercase named slots. */
  slots: Set<string>;
  /** Lowercase prop names read by a receiver or an attribute binding. */
  props: Set<string>;
  /** Whether a valueless (or empty) `data-bascik-slot` marker is present. */
  hasDefaultSlot: boolean;
}

const SLOT_MARKER_RE =
  /data-bascik-slot(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`/>]+)))?/gi;
const PROP_RECEIVER_RE = /data-bascik-prop-([\w-]+)/gi;
const ATTR_BINDING_RE =
  /data-bascik-attr-[\w:.-]+\s*=\s*(?:"([\w-]+)"|'([\w-]+)'|([\w-]+))/gi;

/** The slots and props a component template declares. */
export const declaredMembers = (template: string): DeclaredMembers => {
  const masked = maskRawTextContent(template);
  const slots = new Set<string>();
  const props = new Set<string>();
  let hasDefaultSlot = false;
  for (const match of masked.matchAll(SLOT_MARKER_RE)) {
    const name = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (name === "") hasDefaultSlot = true;
    else slots.add(name.toLowerCase());
  }
  for (const match of masked.matchAll(PROP_RECEIVER_RE))
    props.add(match[1].toLowerCase());
  for (const match of masked.matchAll(ATTR_BINDING_RE))
    props.add((match[1] ?? match[2] ?? match[3]).toLowerCase());
  return { slots, props, hasDefaultSlot };
};

/** Everything either reading declares. */
export const mergeDeclared = (
  a: DeclaredMembers,
  b: DeclaredMembers,
): DeclaredMembers => ({
  slots: new Set([...a.slots, ...b.slots]),
  props: new Set([...a.props, ...b.props]),
  hasDefaultSlot: a.hasDefaultSlot || b.hasDefaultSlot,
});

/** Whether default slot content carries anything but whitespace and comments. */
export const hasRenderableContent = (content: string): boolean =>
  content.replace(/<!--[\s\S]*?(?:-->|$)/g, "").trim() !== "";

/**
 * The innermost `bascik-source-file` marker open at `index`: the page or the
 * component template a usage was written in.
 */
export const sourceFileAt = (
  html: string,
  index: number,
  fallback: string,
): string => {
  const marker =
    /<!--bascik-source-file:(.*?)-->|<!--bascik-source-file-end:(.*?)-->/g;
  const stack: string[] = [];
  const prefix = html.slice(0, index);
  for (const match of prefix.matchAll(marker)) {
    if (match[1] !== undefined) stack.push(match[1]);
    else {
      const at = stack.lastIndexOf(match[2]);
      if (at !== -1) stack.splice(at, 1);
      else stack.pop();
    }
  }
  return stack[stack.length - 1] || fallback;
};
