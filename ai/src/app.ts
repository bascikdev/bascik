/**
 * What an app needs around the renderer and the turn loop: a conversation
 * store, the reader's session, replies that are written once whoever is
 * watching, and the handlers a chat page posts to.
 *
 * `createChat` holds what the routes share, and each handler is a web
 * standard `(request: Request) => Promise<Response>`, so a route file is one
 * line: `export const POST = chat.send;`. Every piece also works alone: take
 * the store and write your own handlers, or take the handlers over your own
 * store.
 *
 * Nothing here reads the environment or keeps a global. Where conversations
 * live, who the reader is, which model answers, and which voice provider is
 * offered are all passed in, and a client never chooses any of them.
 *
 * This is the `@bascik/ai/app` entry: the kit itself lives in `./app/`, one
 * module per part, and this file re-exports its public names.
 */
export { sharedKeys, type SharedKeys } from "./keys.ts";
export {
  fileMemories,
  inMemoryMemories,
  type Memory,
  type MemoryStore,
} from "./memory.ts";
export {
  fileStore,
  memoryStore,
  newConversation,
  searchConversations,
  type Conversation,
  type ConversationStore,
  type SearchMatch,
} from "./store.ts";

export {
  cookieSessions,
  type ChatSessions,
  type CookieSessionOptions,
  type Session,
} from "./app/sessions.ts";
export type {
  Chat,
  ChatHandler,
  HostContext,
  LiveTurn,
  SearchResults,
  ThreadState,
} from "./app/types.ts";
export type { ChatOptions } from "./app/options.ts";
export { ConversationFullError } from "./app/errors.ts";
export { createChat } from "./app/create-chat.ts";
