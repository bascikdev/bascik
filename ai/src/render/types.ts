/**
 * The types the streaming renderer is built from: the renderer itself, its
 * options and component budget, and the opening tag the tag reader hands to
 * the renderer.
 */
import type { CatalogEntry } from "../catalog.ts";

export interface OpenTag {
  entry: CatalogEntry;
  /** The opening tag as Bascik will read it. */
  html: string;
  selfClosed: boolean;
  /** Index just past the tag in the source. */
  end: number;
}

export interface Renderer {
  /** Add a slice of model output; returns the HTML that is now complete (possibly ""). */
  push(delta: string): string;
  /** The stream is over: returns what was still waiting, rendered as it stands. */
  end(): string;
}

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
