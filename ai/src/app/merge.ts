/**
 * Putting a caller's changes to a conversation over what other writes stored
 * since the caller loaded it, for `chat.save`: added messages are kept from
 * both sides, and a write that changed the same messages is refused.
 */
import type { ChatMessage } from "../model.ts";
import type { Conversation } from "../store.ts";

const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
/** Whether `list` begins with every item of `head`, unchanged. */
const startsWith = (list: unknown[], head: unknown[]): boolean =>
  list.length >= head.length && head.every((item, i) => same(item, list[i]));

/**
 * `latest` (what other writes stored since `base`) with the changes in `ours`
 * (`base` as it was loaded, then changed by a caller) applied over it, as a
 * new conversation: `ours` is left as it is, so a save that fails can be
 * tried again. Messages one side added after `base` follow the other side's;
 * a field the caller changed replaces the stored one. When both sides
 * changed or removed messages that `base` had, even different ones, they
 * cannot be put together, and this throws.
 */
export function applyChanges(
  ours: Conversation,
  base: Conversation,
  latest: Conversation,
): Conversation {
  let messages = ours.messages;
  if (same(ours.messages, base.messages)) messages = latest.messages;
  else if (!same(latest.messages, base.messages)) {
    if (startsWith(ours.messages, base.messages)) {
      messages = [
        ...latest.messages,
        ...ours.messages.slice(base.messages.length),
      ];
    } else if (startsWith(latest.messages, base.messages)) {
      messages = [
        ...ours.messages,
        ...latest.messages.slice(base.messages.length),
      ];
    } else {
      throw new Error(
        `Conversation ${ours.id} was changed by another write since it was loaded, in the same messages: load it again, or use chat.change.`,
      );
    }
  }
  const merged = JSON.parse(JSON.stringify(ours)) as Conversation;
  const fields = merged as unknown as Record<string, unknown>;
  const was = base as unknown as Record<string, unknown>;
  const now = latest as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) {
    if (key === "id" || key === "messages" || key === "updatedAt") continue;
    if (!same(fields[key], was[key])) continue;
    if (key in now) fields[key] = now[key];
    else delete fields[key];
  }
  merged.messages = JSON.parse(JSON.stringify(messages)) as ChatMessage[];
  return merged;
}
