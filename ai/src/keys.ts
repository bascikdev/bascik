/**
 * The keys a chat keeps in its `Shared` store. Every one has the shape
 * `genui:<chatId>:<kind>:<conversationId>[:<more>]`, so an adapter can route,
 * expire, or list them by prefix, and a host that writes them itself (a
 * Durable Object, say) builds them the same way the kit does.
 */
export interface SharedKeys {
  /** The claim on writing a conversation's reply. */
  lease(conversationId: string): string;
  /** The record of the reply being written: which turn, and how much came before it. */
  turn(conversationId: string): string;
  /** Stop's signal for one turn. */
  stop(conversationId: string, turn: string): string;
  /** The channel one turn's reply is written to. */
  reply(conversationId: string, turn: string): string;
  /** A voice call's recorded turn. */
  voice(conversationId: string): string;
  /** That a voice provider picker opened a session for the conversation. */
  voiceOpen(conversationId: string): string;
  /** The lock held while a voice call's turn is changed. */
  voiceLock(conversationId: string): string;
  /** What one voice tool call put on screen. `call` is a `voiceCallId`. */
  view(conversationId: string, call: string): string;
}

/** The builders of every shared key the chat named `chatId` uses. */
export function sharedKeys(chatId: string): SharedKeys {
  const ns = `genui:${chatId}:`;
  return {
    lease: (conversationId) => `${ns}lease:${conversationId}`,
    turn: (conversationId) => `${ns}turn:${conversationId}`,
    stop: (conversationId, turn) => `${ns}stop:${conversationId}:${turn}`,
    reply: (conversationId, turn) => `${ns}reply:${conversationId}:${turn}`,
    voice: (conversationId) => `${ns}voice:${conversationId}`,
    voiceOpen: (conversationId) => `${ns}voice-open:${conversationId}`,
    voiceLock: (conversationId) => `${ns}voice-lock:${conversationId}`,
    view: (conversationId, call) => `${ns}view:${conversationId}:${call}`,
  };
}
