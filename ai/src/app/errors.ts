/**
 * The answers a handler gives when it cannot do what was asked: a
 * conversation with no room left (`ConversationFullError`, answered with 413)
 * and a request that is not what the handler takes (400).
 */
import { NO_STORE } from "./limits.ts";

/**
 * Thrown by `addMessage` when the conversation has no room for the message
 * (see `ChatOptions.maxConversationBytes`). The handlers answer it with 413.
 */
export class ConversationFullError extends Error {
  constructor() {
    super("This conversation is full. Start a new conversation to go on.");
    this.name = "ConversationFullError";
  }
}

export const conversationFull = (): Response =>
  new Response(new ConversationFullError().message, {
    status: 413,
    headers: NO_STORE,
  });

export const badRequest = (message: string): Response =>
  new Response(message, { status: 400 });
