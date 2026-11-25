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
  type ComponentBudget,
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

/**
 * One tool part in its wrapper. A `budget` shared with the message's text
 * parts counts the note's components against the same `maxComponents`.
 */
export function renderToolPart(
  part: ToolPart,
  catalog: Catalog,
  options: TurnRenderOptions = {},
  budget?: ComponentBudget,
): string {
  const drawn = options.view?.(part);
  let inner: string;
  if (drawn !== null && drawn !== undefined) {
    inner = String(drawn);
  } else {
    const note = options.tools
      ?.find((tool) => tool.name === part.name)
      ?.note?.(part.input);
    inner = note ? renderText(note, catalog, options, budget) : "";
  }
  return `<div class="part" data-part="${escapeHtml(part.id)}" data-tool="${escapeHtml(part.name)}" data-state="${part.state}">${inner}</div>`;
}

/**
 * A stored message. Every part is drawn once, in the state it was stored in.
 * The whole message shares one `maxComponents` budget, so it stays one
 * script output Bascik can render however many components the model wrote.
 */
export function renderMessage(
  message: ChatMessage,
  catalog: Catalog,
  options: TurnRenderOptions = {},
): string {
  const budget: ComponentBudget = { used: 0 };
  return partsOf(message)
    .map((part) =>
      part.type === "file"
        ? "" // an attachment is drawn by the thread, beside its message
        : part.type === "tool"
          ? renderToolPart(part, catalog, options, budget)
          : part.spoken
            ? `<p class="spoken">${escapeHtml(part.text)}</p>`
            : renderText(part.text, catalog, options, budget),
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
  // One budget for the turn's text and tool notes, as `renderMessage` has for
  // the stored message, so the reply shows the same components live and on
  // reload.
  const budget: ComponentBudget = { used: 0 };
  // A tool part is sent again each time its state changes, but stored once.
  // Each sending is drawn from the budget as it stood when the part was
  // first sent, and the part is charged once, for its costliest sending.
  const parts = new Map<string, { start: number; charged: number }>();
  let renderer = createRenderer(catalog, options, budget);
  for await (const event of events) {
    if (event.type === "text") {
      const html = renderer.push(event.delta);
      if (html) yield html;
      continue;
    }
    // A tool call ends the text before it: what follows is a new part.
    const rest = renderer.end();
    renderer = createRenderer(catalog, options, budget);
    let seen = parts.get(event.part.id);
    if (!seen) {
      seen = { start: budget.used, charged: 0 };
      parts.set(event.part.id, seen);
    }
    const sending: ComponentBudget = { used: seen.start };
    const html = renderToolPart(event.part, catalog, options, sending);
    const cost = sending.used - seen.start;
    if (cost > seen.charged) {
      budget.used += cost - seen.charged;
      seen.charged = cost;
    }
    yield rest + html;
  }
  const rest = renderer.end();
  if (rest) yield rest;
}
