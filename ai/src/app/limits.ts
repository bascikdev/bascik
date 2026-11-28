/**
 * The chat kit's fixed sizes and timings: how much of a message, a speech
 * turn or a body is read, and how long a reply's claim, its watch and a voice
 * call's state last in the shared store.
 */

/** The most matches a search page shows. */
export const SEARCH_LIMIT = 20;

/** A message the reader sends is kept to this many characters. */
export const MAX_MESSAGE = 4000;
/** What the thread shows for a form's message, when that is not the message, is kept to this many. */
export const MAX_SHOWN = 2000;
/** What a voice session stores of one turn's speech, and of what the thread shows for it. */
export const MAX_SPEECH = 8000;
/** A voice tool call's input, as sent. */
export const MAX_TOOL_INPUT = 64_000;
export const NO_STORE = { "cache-control": "no-store" };

/** `ChatOptions.maxConversationBytes` when it is not given: 2 MB. */
export const DEFAULT_MAX_CONVERSATION_BYTES = 2 * 1024 * 1024;
/** What a multipart body may carry besides its files: the text and the field framing. */
export const MULTIPART_ROOM = 256 * 1024;

/** How long a server's claim on a conversation's reply lasts without being renewed. */
export const LEASE_MS = 15_000;
/** How often the server writing a reply looks for a Stop. The claim is renewed every `RENEW_MS`. */
export const WATCH_MS = 500;
export const RENEW_MS = 5000;
/** How long a server following a reply waits in silence before it asks whether the writer is still there. */
export const FOLLOW_IDLE_MS = 2000;
/**
 * With `followLocally: false`, how often a follower wakes while it waits on
 * the shared channel: a timer of its own stays pending, so a host that
 * cancels a request waiting only on another request's I/O (workerd) does not
 * take it for hung.
 */
export const KEEPALIVE_MS = 1000;
/** How long a voice call's recorded turn and shown views are kept after the last tool call. */
export const VOICE_MS = 2 * 60 * 60 * 1000;
