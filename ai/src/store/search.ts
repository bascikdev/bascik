/**
 * Searching a reader's conversations: the store's own search when it has
 * one, otherwise a bounded read of the newest conversations matched word by
 * word.
 */
import { bytesOf } from "./conversation.ts";
import { MAX_QUERY, matchOf, wordsOf } from "./search-match.ts";
import type {
  Conversation,
  ConversationStore,
  ConversationSummary,
  SearchMatch,
} from "./types.ts";

/** A query shorter than this (after trimming) finds nothing. */
export const MIN_QUERY = 2;

/** The fallback reads at most this many conversations, the newest. */
export const MAX_SCANNED = 200;
/**
 * The fallback reads at most this much, as UTF-8 bytes of the conversations'
 * JSON, newest first, and one conversation at a time. It is what bounds one
 * search, however many large conversations a reader has.
 */
export const MAX_SEARCHED_BYTES = 8 * 1024 * 1024;
/** How much the fallback reads before it lets other requests run. */
const SEARCHED_BETWEEN_BREATHS = 256 * 1024;
/** The most matches one search returns. */
export const MAX_MATCHES = 50;

/** Let other requests run: a long search is many short steps, not one long one. */
const breathe = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof setImmediate === "function") setImmediate(resolve);
    else setTimeout(resolve, 0);
  });

/**
 * The reader's conversations that match a query, best first. It uses the
 * store's own `search` when it has one. Otherwise it reads the reader's
 * newest conversations one at a time (found through `summaries` when the
 * store has it, else `list`), at most `MAX_SCANNED` of them and
 * `MAX_SEARCHED_BYTES` in all, and matches words: case does not matter,
 * every word has to appear somewhere in the conversation, and more
 * appearances rank higher, then the more recent conversation. A query shorter
 * than `MIN_QUERY` finds nothing, and `limit` is held to `MAX_MATCHES`.
 *
 * Only what was said is searched, never what a tool was given or returned.
 */
export async function searchConversations(
  store: ConversationStore,
  reader: string,
  query: string,
  limit = 20,
): Promise<SearchMatch[]> {
  const asked = query.trim().slice(0, MAX_QUERY);
  const wanted = Math.min(MAX_MATCHES, Math.max(0, Math.floor(limit) || 0));
  if (asked.length < MIN_QUERY || wanted === 0) return [];
  if (store.search) {
    return (await store.search(reader, asked, wanted)).slice(0, wanted);
  }
  const words = wordsOf(asked);
  const newest: Array<ConversationSummary | Conversation> = (
    store.summaries ? await store.summaries(reader) : await store.list(reader)
  ).slice(0, MAX_SCANNED);
  const found: Array<NonNullable<ReturnType<typeof matchOf>>> = [];
  let read = 0;
  let sinceBreath = 0;
  for (const entry of newest) {
    if (read >= MAX_SEARCHED_BYTES) break;
    // A summary, or a list that holds only what a sidebar needs: read the
    // conversation now, and let it go before the next one.
    const conversation =
      "messages" in entry && entry.messages.length > 0
        ? entry
        : await store.load(reader, entry.id);
    if (!conversation) continue;
    const size = bytesOf(conversation);
    read += size;
    sinceBreath += size;
    const match = matchOf(conversation, words);
    if (match) found.push(match);
    if (sinceBreath >= SEARCHED_BETWEEN_BREATHS) {
      sinceBreath = 0;
      await breathe();
    }
  }
  return found
    .sort((a, b) => b.count - a.count || b.match.updatedAt - a.match.updatedAt)
    .slice(0, wanted)
    .map((entry) => entry.match);
}
