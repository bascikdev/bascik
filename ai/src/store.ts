/**
 * Where conversations are kept. The chat in `app.ts` asks a store for three
 * things and nothing else, so a consumer can put conversations in any
 * database by implementing them. Two stores are here: one in memory, and one
 * JSON file per conversation.
 */
export type {
  Conversation,
  ConversationStore,
  ConversationSummary,
  SearchMatch,
} from "./store/types.ts";
export { isSafeKey, newConversation } from "./store/conversation.ts";
export { memoryStore } from "./store/memory-store.ts";
export { fileStore } from "./store/file-store.ts";
export {
  MAX_CONVERSATIONS,
  MAX_CONVERSATION_BYTES,
  MAX_LISTED_BYTES,
  limitConversations,
} from "./store/limit.ts";
export { MAX_QUERY } from "./store/search-match.ts";
export {
  MAX_MATCHES,
  MAX_SCANNED,
  MAX_SEARCHED_BYTES,
  MIN_QUERY,
  searchConversations,
} from "./store/search.ts";
