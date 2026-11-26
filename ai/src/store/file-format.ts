/**
 * How `fileStore` reads its JSON files back: the summary at the start of a
 * file it wrote, and the check that a parsed file has a conversation's shape.
 */
import type { Conversation, ConversationSummary } from "./types.ts";

const JSON_STRING = String.raw`"(?:[^"\\]|\\.)*"`;
const JSON_NUMBER = String.raw`-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?`;
/** The start of a file `fileStore` wrote: its id, title and updatedAt, in that order. */
const SUMMARY_AT_START = new RegExp(
  String.raw`^\{"id":(${JSON_STRING}),"title":(${JSON_STRING}),"updatedAt":(${JSON_NUMBER}),`,
);

/** The summary at the start of a conversation's JSON, or null when it is not there. */
export function summaryAtStart(text: string): ConversationSummary | null {
  const found = SUMMARY_AT_START.exec(text);
  if (!found) return null;
  try {
    const id: unknown = JSON.parse(found[1]!);
    const title: unknown = JSON.parse(found[2]!);
    const updatedAt = Number(found[3]);
    if (typeof id !== "string" || typeof title !== "string") return null;
    return Number.isFinite(updatedAt) ? { id, title, updatedAt } : null;
  } catch {
    return null;
  }
}

/** A file in the folder is only a conversation when it has the shape of one. */
export function isConversation(value: unknown): value is Conversation {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Conversation>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.updatedAt === "number" &&
    Array.isArray(candidate.messages)
  );
}
