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
 *
 * The parts live in `render/`: `tag.ts` reads one opening tag, `markup.ts`
 * holds inline formatting and the pass-through elements, `renderer.ts` is
 * the streaming state machine, and `types.ts` holds the shared types.
 */
import type { Catalog } from "./catalog.ts";
import { createRenderer } from "./render/renderer.ts";
import type { ComponentBudget, RendererOptions } from "./render/types.ts";

export { inline, SAFE_ELEMENTS } from "./render/markup.ts";
export { createRenderer } from "./render/renderer.ts";
export type {
  ComponentBudget,
  FenceRenderer,
  Renderer,
  RendererOptions,
} from "./render/types.ts";

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
