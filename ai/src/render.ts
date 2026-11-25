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

/** A tag is not all here yet: wait for more of the stream. */
const WAIT = Symbol("wait");

interface OpenTag {
  entry: CatalogEntry;
  /** The opening tag as Bascik will read it. */
  html: string;
  selfClosed: boolean;
  /** Index just past the tag in the source. */
  end: number;
}

/** A catalog element whose closing tag has not arrived yet. */
interface Frame {
  entry: CatalogEntry;
  open: string;
  /** Finished child HTML. */
  children: string;
  /** Text seen since the last child. */
  text: string;
  /** False when the component budget ran out at its opening tag. */
  kept: boolean;
}

const MAX_DEPTH = 6;
/** An opening tag longer than this is shown as text. */
const MAX_TAG = 8_192;
/** Past this much buffered content, open elements are closed where they stand. */
const MAX_PENDING = 262_144;

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
      tag += ` data-bascik-prop-${prop}="${escapeHtml(value)}"`;
    }
  }
  return `${tag}>`;
}

/**
 * Parse the opening tag at the start of `source`, which begins with `<`.
 * Null means this is not a catalog tag and the `<` is text.
 */
function parseOpenTag(
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

export interface Renderer {
  /** Add a slice of model output; returns the HTML that is now complete (possibly ""). */
  push(delta: string): string;
  /** The stream is over: returns what was still waiting, rendered as it stands. */
  end(): string;
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

/**
 * Draws the content of a finished code fence. It is given the model's own
 * text, which is untrusted, and returns HTML that is sent as is: the function
 * is responsible for what it returns. Null (or a throw) means the content
 * could not be drawn, and the fence is shown as code.
 */
export type FenceRenderer = (source: string) => string | null;

export interface RendererOptions {
  /** Names from `SAFE_ELEMENTS` to pass through, for example the table elements. */
  elements?: readonly string[];
  /**
   * Code fences that are drawn instead of shown, by the language named on the
   * opening line: `{ mermaid: mermaidFence() }` turns a ```mermaid fence into
   * a diagram. Such a fence is held back until it closes.
   */
  fences?: Readonly<Record<string, FenceRenderer>>;
  /**
   * The most components one reply may hold (default 300), counted across the
   * whole message, top-level and nested alike. Bascik refuses a script output
   * that expands to more than its own budget, which would lose the whole
   * reply (and, for a stored reply, every message after it on each load), so
   * the renderer stops adding components here and says how many it left out.
   */
  maxComponents?: number;
}

/**
 * How many components renderers have used so far. Renderers given the same
 * budget share `maxComponents`, as the text parts of one message do.
 */
export interface ComponentBudget {
  used: number;
}

export function createRenderer(
  components: Catalog,
  options: RendererOptions = {},
  budget: ComponentBudget = { used: 0 },
): Renderer {
  // Passed-through elements are looked up like components with no props.
  const catalog = new Map(components);
  for (const name of options.elements ?? []) {
    if (!SAFE_ELEMENTS.has(name)) {
      throw new Error(
        `"${name}" is not an element a renderer can pass through.`,
      );
    }
    catalog.set(name, { name, description: "", props: [], slot: true });
  }
  const fences = new Map(Object.entries(options.fences ?? {}));
  const maxComponents = options.maxComponents ?? 300;
  /** Components left out since the last note that said so. */
  let omitted = 0;
  let buffer = "";
  let lineStart = true;
  let afterBlock = true;
  let newlines = 0;
  /** Catalog elements that are open, outermost first. */
  const stack: Frame[] = [];
  /** Characters held in open elements, to bound memory. */
  let pending = 0;
  /** A known tag is incomplete: nothing can change until a `>` arrives. */
  let awaitingTagEnd = false;
  /**
   * The buffer's length the last time a search for a closing fence or marker
   * failed, so the next search starts there and never rereads the buffer.
   */
  let searchedTo = 0;
  let inFence = false;
  /** Set inside a fence that is drawn: its renderer and the lines so far. */
  let drawn: { render: FenceRenderer; lines: string[]; size: number } | null =
    null;

  /** True while `partial` (which starts with `<`) could still become a catalog tag. */
  const couldBeTag = (partial: string): boolean => {
    const name = partial.slice(1);
    for (const known of catalog.keys()) {
      if (known.startsWith(name)) return true;
    }
    return false;
  };

  /**
   * Read the tag at the start of the buffer. Returns the tag, null when the
   * `<` is text, or WAIT. The work is bounded by the length of one tag, so a
   * long element is never read twice.
   */
  const readOpenTag = (
    source: string,
    final: boolean,
  ): OpenTag | typeof WAIT | null => {
    let tag: OpenTag | typeof WAIT | null;
    if (/^<[a-z0-9-]*$/.test(source)) {
      tag = !final && couldBeTag(source) ? WAIT : null;
    } else {
      tag = parseOpenTag(catalog, source);
      if (tag === WAIT && !final && source.length < MAX_TAG) {
        awaitingTagEnd = true;
      }
    }
    if (tag === WAIT && (final || source.length >= MAX_TAG)) return null;
    if (tag && tag !== WAIT && stack.length >= MAX_DEPTH && !tag.selfClosed) {
      return null;
    }
    return tag;
  };

  const closeFrame = (frame: Frame): string => {
    const text = frame.text.trim();
    const children = frame.children + (text ? inline(text) : "");
    // A component with no slot has nowhere to put content, so it is dropped.
    return `${frame.open}${frame.entry.slot ? children : ""}</${frame.entry.name}>`;
  };

  function drain(final: boolean): string {
    let out = "";
    // Newlines are held until the next thing is known: text keeps them (at
    // most one blank line), a block element replaces them. A kept newline is
    // a <br>, so the page never has to treat whitespace as content: the
    // whitespace Bascik writes around a rendered component stays invisible.
    /** Say how many components were left out, before anything else is shown. */
    const note = (): void => {
      if (!omitted) return;
      const count = omitted;
      omitted = 0;
      text(
        `${count} more ${count === 1 ? "item was" : "items were"} left out to keep this reply a reasonable size.`,
      );
    };
    const text = (html: string): void => {
      note();
      if (newlines) {
        // After a component, an empty <div> starts the new line: a component
        // may be inline, such as a button, and a block needs no blank line.
        out += afterBlock
          ? "<div></div>"
          : "<br>".repeat(Math.min(newlines, 2));
      }
      newlines = 0;
      afterBlock = false;
      out += html;
    };
    // A block starts on its own line. After text, an empty <div> ends the
    // line, so an inline component such as a button does not continue the
    // sentence, and no blank line is added above a component that is a block.
    const block = (html: string): void => {
      note();
      if (newlines && !afterBlock) out += "<div></div>";
      newlines = 0;
      afterBlock = true;
      out += html;
    };
    /**
     * Count a component against the budget as its tag opens, so a container
     * comes before what it holds. False when it is past the budget.
     */
    const take = (name: string): boolean =>
      !components.has(name) || ++budget.used <= maxComponents;
    /** A finished element goes to its parent, or out when it has none. */
    const deliver = (html: string, kept: boolean): void => {
      const parent = stack.at(-1);
      if (!kept) omitted++;
      if (parent) {
        if (!kept) return;
        parent.children += html;
        pending += html.length;
      } else {
        pending = 0;
        if (!kept) return;
        // What was left out inside this element is said after it.
        const inside = omitted;
        omitted = 0;
        block(html);
        omitted += inside;
        note();
      }
    };
    const codeLine = (line: string): void =>
      block(`<code data-line>${escapeHtml(line) || "<br>"}</code>`);
    /** The drawn fence is over: draw it, or show it as the code it is. */
    const closeDrawn = (): void => {
      if (!drawn) return;
      const { render, lines } = drawn;
      drawn = null;
      let html: string | null = null;
      try {
        html = render(lines.join("\n"));
      } catch {
        // Not something this renderer can draw.
      }
      if (html) block(html);
      else lines.forEach(codeLine);
    };
    const closeAll = (): void => {
      while (stack.length) {
        const frame = stack.pop()!;
        deliver(closeFrame(frame), frame.kept);
      }
    };

    for (;;) {
      const source = buffer;
      if (!source) break;
      const searched = searchedTo;
      searchedTo = 0;

      // Inside a code fence: every finished line is one element, so code
      // streams line by line and a long block is never held back.
      if (inFence) {
        const lineEnd = source.indexOf("\n", Math.max(0, searched - 1));
        if (lineEnd < 0 && !final && source.length < MAX_TAG) {
          searchedTo = source.length;
          break;
        }
        const line = lineEnd < 0 ? source : source.slice(0, lineEnd);
        buffer = lineEnd < 0 ? "" : source.slice(lineEnd + 1);
        if (line.trim() === "```") {
          closeDrawn();
          inFence = false;
          lineStart = true;
        } else if (drawn) {
          drawn.lines.push(line);
          drawn.size += line.length + 1;
          // Too long to be a drawing: show it as code from here on.
          if (drawn.size > MAX_PENDING) {
            const { lines } = drawn;
            drawn = null;
            lines.forEach(codeLine);
          }
        } else {
          codeLine(line);
        }
        continue;
      }

      // Inside a catalog element: collect text and children until it closes.
      const frame = stack.at(-1);
      if (frame) {
        if (pending > MAX_PENDING) {
          closeAll();
          continue;
        }
        const next = source.indexOf("<");
        if (next !== 0) {
          const run = next < 0 ? source : source.slice(0, next);
          frame.text += run;
          pending += run.length;
          buffer = next < 0 ? "" : source.slice(next);
          continue;
        }
        const close = `</${frame.entry.name}>`;
        if (source.startsWith(close)) {
          stack.pop();
          deliver(closeFrame(frame), frame.kept);
          buffer = source.slice(close.length);
          continue;
        }
        if (!final && close.startsWith(source)) break;
        const tag = readOpenTag(source, final);
        if (tag === WAIT) break;
        if (tag === null) {
          frame.text += "<";
          buffer = source.slice(1);
          continue;
        }
        const before = frame.text.trim();
        if (before) frame.children += inline(before);
        frame.text = "";
        if (tag.selfClosed) {
          deliver(`${tag.html}</${tag.entry.name}>`, take(tag.entry.name));
        } else {
          stack.push({
            entry: tag.entry,
            open: tag.html,
            children: "",
            text: "",
            kept: take(tag.entry.name),
          });
        }
        buffer = source.slice(tag.end);
        continue;
      }

      if (lineStart) {
        if (source.startsWith("```")) {
          // The rest of the opening line names a language. It is not shown,
          // and it picks the renderer of a fence that is drawn.
          const firstLine = source.indexOf("\n");
          if (firstLine < 0 && !final && source.length < 200) break;
          if (firstLine >= 0 || final) {
            const language = source
              .slice(3, firstLine < 0 ? undefined : firstLine)
              .trim()
              .toLowerCase();
            const render = fences.get(language);
            drawn = render ? { render, lines: [], size: 0 } : null;
            inFence = true;
            block("");
            buffer = firstLine < 0 ? "" : source.slice(firstLine + 1);
            continue;
          }
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
        const from = Math.max(marker.length, searched - marker.length);
        const lineEnd = source.indexOf("\n", from - 1);
        const close = source.indexOf(marker, from);
        if (close > marker.length && (lineEnd < 0 || close < lineEnd)) {
          const inner = escapeHtml(source.slice(marker.length, close));
          text(`<${tag}>${inner}</${tag}>`);
          buffer = source.slice(close + marker.length);
          continue;
        }
        // No closing marker on this line: wait while the line is still open.
        if (lineEnd < 0 && !final && close < 0 && source.length < MAX_TAG) {
          searchedTo = source.length;
          break;
        }
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
      const tag = readOpenTag(source, final);
      if (tag === WAIT) break;
      if (tag === null) {
        text("&lt;");
        buffer = source.slice(1);
      } else if (tag.selfClosed) {
        deliver(`${tag.html}</${tag.entry.name}>`, take(tag.entry.name));
        buffer = source.slice(tag.end);
      } else {
        stack.push({
          entry: tag.entry,
          open: tag.html,
          children: "",
          text: "",
          kept: take(tag.entry.name),
        });
        buffer = source.slice(tag.end);
      }
    }
    // A stream that ends inside an element (a reply cut off at a length
    // limit, for example) closes it where it stands, as a browser would.
    if (final) {
      closeDrawn();
      closeAll();
      note();
    }
    return out;
  }

  return {
    push(delta) {
      buffer += delta;
      if (awaitingTagEnd) {
        if (!delta.includes(">") && buffer.length < MAX_TAG) return "";
        awaitingTagEnd = false;
      }
      return drain(false);
    },
    end() {
      awaitingTagEnd = false;
      return drain(true);
    },
  };
}

/** Render a finished message, such as one read back from conversation history. */
export function renderText(
  text: string,
  catalog: Catalog,
  options?: RendererOptions,
  budget?: ComponentBudget,
): string {
  const renderer = createRenderer(catalog, options, budget);
  return renderer.push(text) + renderer.end();
}

/**
 * Render a model's stream as it arrives. Every value this yields is complete
 * HTML, so a `data-bascik-stream` script can `yield*` it as is. It takes what
 * a `Model` yields and renders the text; a model that calls tools needs
 * `runTurn` and `renderTurn` instead, and its calls are skipped here.
 */
export async function* renderStream(
  deltas: AsyncIterable<string | object>,
  catalog: Catalog,
  options?: RendererOptions,
): AsyncGenerator<string, void, undefined> {
  const renderer = createRenderer(catalog, options);
  for await (const delta of deltas) {
    if (typeof delta !== "string") continue;
    const html = renderer.push(delta);
    if (html) yield html;
  }
  const rest = renderer.end();
  if (rest) yield rest;
}
