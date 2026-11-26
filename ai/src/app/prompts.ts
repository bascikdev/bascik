/**
 * The catalog, loaded once, and what a model is given for one request: the
 * chat's tools with the reader's memory and history tools, and the prompt,
 * typed or spoken, with what is known about the reader.
 */
import { catalogPrompt, type Catalog } from "../catalog.ts";
import { historyTool } from "../history.ts";
import { memoryPrompt, memoryTools } from "../memory.ts";
import type { Tool } from "../model.ts";
import { voicePrompt } from "../voice.ts";
import type { ChatBase, ChatPrompts } from "./context.ts";
import type { Session } from "./sessions.ts";

/** The chat's catalog, tools and prompts. */
export function chatPrompts(base: ChatBase): ChatPrompts {
  const { options, tools, memory, memoryApproval, store, followLocally } = base;
  const { renderOptions } = base;

  /** The tools of one request: the app's, and its reader's memory. */
  /**
   * The tools one request's model gets: the chat's own, and the ones made for
   * this reader. `tools` is read once; this runs at each place a model is
   * given tools, so a tool can know whose memories and conversations it may
   * look in.
   */
  const toolsFor = (session: Session, conversationId?: string): Tool[] => {
    const open = conversationId ?? session.conversationId;
    return [
      ...tools,
      ...(memory
        ? memoryTools(memory, session.reader, {
            approval: memoryApproval,
            ...(open ? { conversationId: open } : {}),
          })
        : []),
      ...(options.history
        ? [historyTool(store, { ...session, conversationId: open })]
        : []),
    ];
  };

  /* Catalog and prompts */

  let loaded: Promise<Catalog> | undefined;
  const loadCatalog = (): Promise<Catalog> =>
    Promise.resolve().then(() =>
      typeof options.catalog === "function"
        ? options.catalog()
        : options.catalog,
    );
  // Without local following, a request never waits on a load another request
  // started: only a loaded catalog is kept for the next.
  let catalogLoaded: Catalog | undefined;
  const catalog = (): Promise<Catalog> =>
    followLocally
      ? (loaded ??= loadCatalog().catch((error: unknown) => {
          loaded = undefined;
          throw error;
        }))
      : catalogLoaded
        ? Promise.resolve(catalogLoaded)
        : loadCatalog().then((value) => (catalogLoaded = value));

  const promptOptions = {
    elements: renderOptions.elements,
    fences: options.fencePrompts,
  };
  const basePrompt = async (voice: boolean): Promise<string> => {
    const catalogNow = await catalog();
    if (typeof options.system === "function") {
      return options.system({ catalog: catalogNow, voice });
    }
    return [
      options.system,
      "",
      (voice ? voicePrompt : catalogPrompt)(catalogNow, promptOptions),
    ].join("\n");
  };
  // With memory, the section about it follows, listing this reader's notes
  // (none when no reader is asking, as for `systemPrompt()`).
  const promptFor = async (
    voice: boolean,
    session?: Session,
  ): Promise<string> => {
    const base = await basePrompt(voice);
    if (!memory) return base;
    const known = session ? await memory.list(session.reader) : [];
    return `${base}\n\n${memoryPrompt(known)}`;
  };

  return { toolsFor, catalog, promptFor };
}
