/**
 * `createChat`: resolves the options once, builds the chat's parts over what
 * they share (store, sessions, shared state, prompts, live turns, voice), and
 * returns the `Chat` with its handlers and what a page needs.
 */
import { sharedKeys } from "../keys.ts";
import { memoryTools } from "../memory.ts";
import type { TurnRenderOptions } from "../render-turn.ts";
import { inProcessShared } from "../shared.ts";
import { limitConversations } from "../store.ts";
import type { ChatBase } from "./context.ts";
import { chatConversations } from "./conversations.ts";
import { chatHandlers } from "./handlers.ts";
import { chatLiveTurns } from "./live-turns.ts";
import type { ChatOptions } from "./options.ts";
import { chatPrompts } from "./prompts.ts";
import { cookieSessions } from "./sessions.ts";
import type { Chat } from "./types.ts";
import { chatUploads } from "./uploads.ts";
import { chatVoiceHandlers } from "./voice-handlers.ts";
import { chatVoiceState } from "./voice-state.ts";

export function createChat(options: ChatOptions): Chat {
  const {
    id = "chat",
    tools = [],
    memory,
    memoryApproval = false,
    page = "/",
    turnLimitMs = 120_000,
    maxRounds,
    followLocally = true,
  } = options;
  // NaN (an unset environment variable through Number()) would lift the cap,
  // and 0 would stop every reply before the model is asked.
  if (
    maxRounds !== undefined &&
    (!Number.isSafeInteger(maxRounds) || maxRounds < 1)
  ) {
    throw new Error("createChat: maxRounds is a whole number, 1 or more.");
  }
  const store = limitConversations(options.store, options.maxConversations);
  const sessions =
    options.sessions ??
    cookieSessions(
      id,
      options.sessionSecret === undefined
        ? {}
        : { secret: options.sessionSecret },
    );
  const onError =
    options.onError ??
    ((error: unknown, what: string) =>
      console.error(`[${id}] ${what}:`, error));
  const renderOptions: TurnRenderOptions = {
    ...options.render,
    // The memory tools are built per reader to run, but a note reads only
    // the call's input, so these (for no reader) are all drawing needs.
    tools:
      options.render?.tools ??
      (memory ? [...tools, ...memoryTools(memory, "")] : tools),
  };

  const shared = options.shared ?? inProcessShared();
  const keys = sharedKeys(id);
  const base: ChatBase = {
    options,
    id,
    tools,
    memory,
    memoryApproval,
    page,
    turnLimitMs,
    maxRounds,
    followLocally,
    store,
    sessions,
    onError,
    renderOptions,
    shared,
    keys,
  };
  const prompts = chatPrompts(base);
  const { catalog, promptFor } = prompts;
  const conversations = chatConversations(base);
  const { redirect, loadForCaller, saveForCaller, change, addMessage } =
    conversations;
  const uploads = chatUploads(base);
  const { fileStore } = uploads;
  const liveTurns = chatLiveTurns({
    ...base,
    ...prompts,
    ...conversations,
    ...uploads,
  });
  const { thread, stopTurn } = liveTurns;
  const voiceState = chatVoiceState(base);
  const handlers = chatHandlers({
    ...base,
    ...conversations,
    ...uploads,
    ...liveTurns,
  });
  const { send, approve, answer, stop, open, forget, memoryList } = handlers;
  const { file, memories, search } = handlers;
  const { voiceSession, voiceTool, voiceTurn, voiceView } = chatVoiceHandlers({
    ...base,
    ...prompts,
    ...conversations,
    ...uploads,
    ...voiceState,
  });

  return {
    send,
    approve,
    answer,
    stop,
    open,
    forget,
    memoryList,
    voiceSession,
    voiceTool,
    voiceTurn,
    file,
    thread,
    memories,
    search,
    voiceView,
    catalog,
    renderOptions,
    systemPrompt: () => promptFor(false),
    sessions,
    store,
    files: fileStore,
    session: (request) => sessions.identify(request),
    load: loadForCaller,
    save: saveForCaller,
    change,
    list: (session) => store.list(session.reader),
    addMessage,
    redirect,
    stopTurn,
  };
}
