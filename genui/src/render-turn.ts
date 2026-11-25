/**
 * Message parts as HTML: a live turn as it streams, and a stored message.
 *
 * Text parts go through the renderer, the trust boundary for what a model
 * writes. A tool part is drawn by the app: its `view` returns HTML for the
 * part's state (a progress line, an approval form, a result). Every tool part
 * is wrapped in `<div class="part" data-state="…">`, and a part whose state
 * changes while the reply streams is sent again, so CSS can hide the running
 * version once the finished one follows it:
 *
 *   .part[data-state="running"]:has(~ .part:not([data-state="running"])) { display: none }
 */
import type { Catalog } from "./catalog.ts";
import {
  partsOf,
  type ChatMessage,
  type Tool,
  type ToolPart,
} from "./model.ts";
import {
  createRenderer,
  escapeHtml,
  renderText,
  type RendererOptions,
} from "./render.ts";
import type { TurnEvent } from "./turn.ts";

export interface TurnRenderOptions extends RendererOptions {
  /** The tools, for the `note` each call is shown as when `view` draws nothing. */
  tools?: readonly Tool[];
  /**
   * Draw a tool part in its current state. The result is sent as HTML, so
   * build it with an escaping helper; null or undefined falls back to the
   * tool's `note`.
   */
  view?: (part: ToolPart) => { toString(): string } | string | null | undefined;
}

/** One tool part in its wrapper. */
export function renderToolPart(
  part: ToolPart,
  catalog: Catalog,
  options: TurnRenderOptions = {},
): string {
  const drawn = options.view?.(part);
  let inner: string;
  if (drawn !== null && drawn !== undefined) {
    inner = String(drawn);
  } else {
    const note = options.tools
      ?.find((tool) => tool.name === part.name)
      ?.note?.(part.input);
    inner = note ? renderText(note, catalog, options) : "";
  }
  return `<div class="part" data-part="${escapeHtml(part.id)}" data-tool="${escapeHtml(part.name)}" data-state="${part.state}">${inner}</div>`;
}

/** A stored message. Every part is drawn once, in the state it was stored in. */
export function renderMessage(
  message: ChatMessage,
  catalog: Catalog,
  options: TurnRenderOptions = {},
): string {
  return partsOf(message)
    .map((part) =>
      part.type === "tool"
        ? renderToolPart(part, catalog, options)
        : part.spoken
          ? `<p class="spoken">${escapeHtml(part.text)}</p>`
          : renderText(part.text, catalog, options),
    )
    .join("");
}

/**
 * A turn as it happens. Every value this yields is complete HTML, so a
 * `data-bascik-stream` script can `yield*` it as is.
 */
export async function* renderTurn(
  events: AsyncIterable<TurnEvent>,
  catalog: Catalog,
  options: TurnRenderOptions = {},
): AsyncGenerator<string, void, undefined> {
  let renderer = createRenderer(catalog, options);
  for await (const event of events) {
    if (event.type === "text") {
      const html = renderer.push(event.delta);
      if (html) yield html;
      continue;
    }
    // A tool call ends the text before it: what follows is a new part.
    const rest = renderer.end();
    renderer = createRenderer(catalog, options);
    yield rest + renderToolPart(event.part, catalog, options);
  }
  const rest = renderer.end();
  if (rest) yield rest;
}
