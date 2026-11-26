/**
 * The streaming renderer: slices of model output in, complete HTML out. It
 * holds open catalog elements, code fences and inline markers until they
 * close, and keeps every reply inside its depth, size and component budgets.
 */
import { esc } from "@bascik/bascik/html";
import type { Catalog, CatalogEntry } from "../catalog.ts";
import { inline, SAFE_ELEMENTS } from "./markup.ts";
import { parseOpenTag, WAIT } from "./tag.ts";
import type {
  ComponentBudget,
  FenceRenderer,
  OpenTag,
  Renderer,
  RendererOptions,
} from "./types.ts";

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
      block(`<code data-line>${esc(line) || "<br>"}</code>`);
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
        text(esc(source));
        buffer = "";
        break;
      }
      if (special > 0) {
        text(esc(source.slice(0, special)));
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
          const inner = esc(source.slice(marker.length, close));
          text(`<${tag}>${inner}</${tag}>`);
          buffer = source.slice(close + marker.length);
          continue;
        }
        // No closing marker on this line: wait while the line is still open.
        if (lineEnd < 0 && !final && close < 0 && source.length < MAX_TAG) {
          searchedTo = source.length;
          break;
        }
        text(esc(marker));
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
