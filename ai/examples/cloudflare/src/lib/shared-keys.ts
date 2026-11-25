/**
 * Which ConversationLive object a shared key belongs to. Every key the chat
 * writes has the shape `genui:<chatId>:<kind>:<conversationId>[:<more>]`
 * (`sharedKeys` in @bascik/ai), so all the keys of one conversation land in
 * one object, which runs their calls one at a time, and two conversations
 * never share one.
 */

const KINDS = [
  "lease",
  "turn",
  "stop",
  "reply",
  "voice",
  "voice-open",
  "voice-lock",
  "view",
] as const;

const KEY = new RegExp(
  `^genui:([A-Za-z0-9_-]{1,64}):(${KINDS.join("|")}):([A-Za-z0-9_-]{1,128})(?::[A-Za-z0-9_-]{1,128})?$`,
);

/** How many objects a key of a shape this example does not know is spread over. */
const MISC_OBJECTS = 16;

/** Thrown in development for a key whose shape is not one of `sharedKeys`. */
export class UnknownKeyError extends Error {}

/** The conversation a key belongs to, or null when it has another shape. */
export function parseSharedKey(
  key: string,
): { chatId: string; kind: string; conversationId: string } | null {
  const match = KEY.exec(key);
  if (!match) return null;
  return { chatId: match[1]!, kind: match[2]!, conversationId: match[3]! };
}

/** A small, stable number for a string: which of the spare objects a key goes to. */
function spread(key: string): number {
  let hash = 0;
  for (let at = 0; at < key.length; at++) {
    hash = (hash * 31 + key.charCodeAt(at)) >>> 0;
  }
  return hash % MISC_OBJECTS;
}

/**
 * The Durable Object name for a key: `live:<chatId>:<conversationId>`. A key
 * that does not parse means @bascik/ai gained a key shape this example has
 * not seen: in development that throws, so a test or a local run finds it;
 * in production it goes to one of a few spare objects, and is logged.
 */
export function liveObjectName(key: string, development: boolean): string {
  const parsed = parseSharedKey(key);
  if (parsed) return `live:${parsed.chatId}:${parsed.conversationId}`;
  if (development) {
    throw new UnknownKeyError(
      `ConversationLive: a shared key of an unknown shape: ${key.slice(0, 80)}`,
    );
  }
  console.error(
    `ConversationLive: a shared key of an unknown shape: ${key.slice(0, 80)}`,
  );
  return `live:misc:${spread(key)}`;
}
