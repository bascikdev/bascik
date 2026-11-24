/**
 * Turns what a model writes into what a Bascik stream script may yield.
 *
 * A model streams text in slices that end anywhere: in the middle of a word,
 * of a tag, of an attribute. A stream script must yield whole elements. The
 * renderer sits between the two: it takes slices in and gives back HTML that
 * is always complete, so each value can be yielded the moment it exists.
 *
 * It is also the trust boundary. Model output is untrusted text, so:
 *   - a tag is passed on only when its name is in the catalog,
 *   - only the props the component declares are kept, as escaped values,
 *   - everything else, including every other `<`, is escaped as text.
 * Bascik then renders the surviving tags with its own request-time renderer,
 * which treats each prop as text and checks every URL and attribute binding.
 */
import type { Catalog, CatalogEntry } from "./catalog.ts";

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => ESCAPES[character]!);

/** Escape a finished run of text and apply `**bold**` and `` `code` ``. */
export function inline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`\n]+)`/g, (_, code: string) => `<code>${code}</code>`)
    .replace(
      /\*\*([^*\n]+)\*\*/g,
      (_, bold: string) => `<strong>${bold}</strong>`,
    );
}

/** An element is not all here yet: wait for more of the stream. */
const WAIT = Symbol("wait");
type Parsed = { html: string; end: number } | typeof WAIT | null;

const MAX_DEPTH = 4;
/** Past this an unfinished element is shown as text, so a stream cannot buffer without bound. */
const MAX_PENDING = 32_768;

const NAME = /<([a-z][a-z0-9-]*)/y;
const ATTRIBUTE = /[A-Za-z_][-\w:.]*/y;
const BARE_VALUE = /[^\s>]+/y;

function skipSpace(source: string, at: number): number {
  while (at < source.length && /\s/.test(source[at]!)) at++;
  return at;
}

function openTag(entry: CatalogEntry, props: Map<string, string>): string {
  let tag = `<${entry.name}`;
  for (const prop of entry.props) {
    const value = props.get(prop);
    if (value !== undefined) {
      tag += ` data-bascik-prop-${prop}="${escapeHtml(value)}"`;
    }
  }
  return `${tag}>`;
}

/** Parse the catalog element that starts at `source[at]`, which is `<`. */
function parseElement(
  catalog: Catalog,
  source: string,
  at: number,
  depth: number,
): Parsed {
  NAME.lastIndex = at;
  const named = NAME.exec(source);
  if (!named) return null;
  let position = NAME.lastIndex;
  if (position >= source.length) return WAIT;
  const entry = catalog.get(named[1]!);
  if (!entry || depth > MAX_DEPTH || !/[\s/>]/.test(source[position]!)) {
    return null;
  }

  const props = new Map<string, string>();
  let selfClosed = false;
  for (;;) {
    position = skipSpace(source, position);
    if (position >= source.length) return WAIT;
    if (source[position] === ">") {
      position++;
      break;
    }
    if (source[position] === "/") {
      if (position + 1 >= source.length) return WAIT;
      if (source[position + 1] !== ">") return null;
      position += 2;
      selfClosed = true;
      break;
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

  const open = openTag(entry, props);
  const close = `</${entry.name}>`;
  if (selfClosed) return { html: open + close, end: position };

  let children = "";
  let text = "";
  const flushText = (): void => {
    if (text.trim()) children += inline(text.trim());
    text = "";
  };
  for (;;) {
    const next = source.indexOf("<", position);
    if (next < 0) return WAIT;
    text += source.slice(position, next);
    const rest = source.slice(next);
    if (rest.startsWith(close)) {
      flushText();
      // A component with no slot has nowhere to put content, so it is dropped.
      return {
        html: open + (entry.slot ? children : "") + close,
        end: next + close.length,
      };
    }
    if (close.startsWith(rest)) return WAIT;
    const child = parseElement(catalog, source, next, depth + 1);
    if (child === WAIT) return WAIT;
    if (child === null) {
      text += "<";
      position = next + 1;
    } else {
      flushText();
      children += child.html;
      position = child.end;
    }
  }
}

export interface Renderer {
  /** Add a slice of model output; returns the HTML that is now complete (possibly ""). */
  push(delta: string): string;
  /** The stream is over: returns what was still waiting, rendered as it stands. */
  end(): string;
}

export function createRenderer(catalog: Catalog): Renderer {
  let buffer = "";
  let lineStart = true;
  let afterBlock = true;
  let newlines = 0;

  /** True while `partial` (which starts with `<`) could still become a catalog tag. */
  const couldBeTag = (partial: string): boolean => {
    const name = partial.slice(1);
    for (const known of catalog.keys()) {
      if (known.startsWith(name)) return true;
    }
    return false;
  };

  function drain(final: boolean): string {
    let out = "";
    // Newlines are held until the next thing is known: text keeps them (at
    // most one blank line), a block element replaces them.
    const text = (html: string): void => {
      if (newlines && !afterBlock) out += "\n".repeat(Math.min(newlines, 2));
      newlines = 0;
      afterBlock = false;
      out += html;
    };
    // A block starts on its own line. After text, an empty <div> ends the
    // line, so an inline component such as a button does not continue the
    // sentence, and no blank line is added above a component that is a block.
    const block = (html: string): void => {
      if (newlines && !afterBlock) out += "<div></div>";
      newlines = 0;
      afterBlock = true;
      out += html;
    };

    for (;;) {
      const source = buffer;
      if (!source) break;

      if (lineStart) {
        if (source.startsWith("```")) {
          const firstLine = source.indexOf("\n");
          const close = firstLine < 0 ? -1 : source.indexOf("\n```", firstLine);
          if (close < 0 && !final) break;
          const code =
            firstLine < 0
              ? ""
              : source.slice(firstLine + 1, close < 0 ? undefined : close);
          block(`<pre><code>${escapeHtml(code)}</code></pre>`);
          buffer = close < 0 ? "" : source.slice(close + 4);
          lineStart = false;
          continue;
        }
        if (!final && (source === "`" || source === "``")) break;
        const heading = /^(#{1,4}) /.exec(source);
        if (heading) {
          const lineEnd = source.indexOf("\n");
          if (lineEnd < 0 && !final) break;
          const line = source.slice(
            heading[0].length,
            lineEnd < 0 ? undefined : lineEnd,
          );
          const level = heading[1]!.length < 3 ? 3 : 4;
          block(`<h${level}>${inline(line.trim())}</h${level}>`);
          buffer = lineEnd < 0 ? "" : source.slice(lineEnd);
          lineStart = false;
          continue;
        }
        if (!final && /^#{1,4}$/.test(source)) break;
        if (/^[-*] /.test(source)) {
          text("• ");
          buffer = source.slice(2);
          lineStart = false;
          continue;
        }
        if (!final && (source === "-" || source === "*")) break;
        lineStart = false;
      }

      const special = source.search(/[<`*\n]/);
      if (special < 0) {
        text(escapeHtml(source));
        buffer = "";
        break;
      }
      if (special > 0) {
        text(escapeHtml(source.slice(0, special)));
        buffer = source.slice(special);
        continue;
      }

      const character = source[0];
      if (character === "\n") {
        newlines++;
        lineStart = true;
        buffer = source.slice(1);
        continue;
      }

      if (character === "`" || source.startsWith("**")) {
        const marker = character === "`" ? "`" : "**";
        const tag = character === "`" ? "code" : "strong";
        const lineEnd = source.indexOf("\n");
        const close = source.indexOf(marker, marker.length);
        if (close > marker.length && (lineEnd < 0 || close < lineEnd)) {
          const inner = escapeHtml(source.slice(marker.length, close));
          text(`<${tag}>${inner}</${tag}>`);
          buffer = source.slice(close + marker.length);
          continue;
        }
        // No closing marker on this line: wait while the line is still open.
        if (lineEnd < 0 && !final && close < 0) break;
        text(escapeHtml(marker));
        buffer = source.slice(marker.length);
        continue;
      }

      if (character === "*") {
        if (source.length === 1 && !final) break;
        text("*");
        buffer = source.slice(1);
        continue;
      }

      // character === "<"
      let parsed: Parsed = null;
      if (/^<[a-z0-9-]*$/.test(source)) {
        parsed = !final && couldBeTag(source) ? WAIT : null;
      } else {
        parsed = parseElement(catalog, source, 0, 1);
      }
      if (parsed === WAIT) {
        if (!final && source.length < MAX_PENDING) break;
        parsed = null;
      }
      if (parsed === null) {
        text("&lt;");
        buffer = source.slice(1);
      } else {
        block(parsed.html);
        buffer = source.slice(parsed.end);
      }
    }
    return out;
  }

  return {
    push(delta) {
      buffer += delta;
      return drain(false);
    },
    end() {
      return drain(true);
    },
  };
}

/** Render a finished message, such as one read back from conversation history. */
export function renderText(text: string, catalog: Catalog): string {
  const renderer = createRenderer(catalog);
  return renderer.push(text) + renderer.end();
}

/**
 * Render a model's stream as it arrives. Every value this yields is complete
 * HTML, so a `data-bascik-stream` script can `yield*` it as is.
 */
export async function* renderStream(
  deltas: AsyncIterable<string>,
  catalog: Catalog,
): AsyncGenerator<string, void, undefined> {
  const renderer = createRenderer(catalog);
  for await (const delta of deltas) {
    const html = renderer.push(delta);
    if (html) yield html;
  }
  const rest = renderer.end();
  if (rest) yield rest;
}
