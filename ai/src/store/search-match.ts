/**
 * Matching one conversation against a query, for the search fallback: the
 * query's words, what was said in a conversation, where the words are, and
 * the snippet to show.
 */
import { partsOf } from "../model.ts";
import type { Conversation, SearchMatch } from "./types.ts";

/** A query is cut to this many characters. */
export const MAX_QUERY = 200;
/** The most words of a query that are matched; the rest are ignored. */
const MAX_WORDS = 8;

/** How long a snippet is, more or less. */
const SNIPPET = 160;
/** How much of the text before the first match a snippet keeps. */
const LEAD = 50;

/**
 * Lowercase without changing the length: a character whose lowercase form is
 * longer or shorter stays as it is, so an offset in the result is an offset in
 * the original.
 */
const lower = (text: string): string =>
  // Plain ASCII keeps its length as a whole; other text goes a character at
  // a time.
  /^[\0-\x7f]*$/.test(text)
    ? text.toLowerCase()
    : Array.from(text, (char) => {
        const small = char.toLowerCase();
        return small.length === char.length ? small : char;
      }).join("");

/** The words of a query: lowercase, without repeats, at most `MAX_WORDS`. */
export function wordsOf(query: string): string[] {
  const words = lower(query.trim().slice(0, MAX_QUERY)).split(/\s+/);
  return [...new Set(words.filter(Boolean))].slice(0, MAX_WORDS);
}

/** What was said in a conversation: the reader's words, and the model's. Never a tool call. */
function saidIn(conversation: Conversation): string[] {
  return conversation.messages.flatMap((message) =>
    partsOf(message)
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .map((text) => text.replace(/\s+/g, " ").trim())
      .filter(Boolean),
  );
}

/** Every `[start, end)` where one of the words is in the text, in order, merged. */
function marksIn(text: string, words: string[]): SearchMatch["marks"] {
  const small = lower(text);
  const found: SearchMatch["marks"] = [];
  for (const word of words) {
    let at = small.indexOf(word);
    while (at !== -1) {
      found.push([at, at + word.length]);
      at = small.indexOf(word, at + word.length);
    }
  }
  found.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: SearchMatch["marks"] = [];
  for (const mark of found) {
    const last = merged.at(-1);
    if (last && mark[0] <= last[1]) last[1] = Math.max(last[1], mark[1]);
    else merged.push([mark[0], mark[1]]);
  }
  return merged;
}

/** Match one conversation: how many times the words appear, and the best place to show. */
export function matchOf(
  conversation: Conversation,
  words: string[],
): { count: number; match: SearchMatch } | null {
  const texts = saidIn(conversation).map((text) => ({
    text,
    marks: marksIn(text, words),
  }));
  // Every word has to be in the conversation, though not in one message.
  const everything = lower(texts.map((entry) => entry.text).join("\n"));
  if (!words.every((word) => everything.includes(word))) return null;
  let count = 0;
  let best: (typeof texts)[number] | undefined;
  let bestWords = 0;
  for (const entry of texts) {
    count += entry.marks.length;
    const small = lower(entry.text);
    const distinct = words.filter((word) => small.includes(word)).length;
    if (distinct > bestWords) {
      best = entry;
      bestWords = distinct;
    }
  }
  if (!best || best.marks.length === 0) return null;
  const text = best.text;
  let start = Math.max(0, best.marks[0]![0] - LEAD);
  let end = Math.min(text.length, start + SNIPPET);
  // Never cut a surrogate pair in half.
  const trail = (at: number): boolean => /[\uDC00-\uDFFF]/.test(text[at] ?? "");
  if (start > 0 && trail(start)) start += 1;
  if (end < text.length && trail(end)) end -= 1;
  const head = start > 0 ? "…" : "";
  const tail = end < text.length ? "…" : "";
  const marks: SearchMatch["marks"] = [];
  for (const [from, to] of best.marks) {
    if (to <= start || from >= end) continue;
    marks.push([
      Math.max(from, start) - start + head.length,
      Math.min(to, end) - start + head.length,
    ]);
  }
  return {
    count,
    match: {
      id: conversation.id,
      title: conversation.title,
      updatedAt: conversation.updatedAt,
      snippet: head + text.slice(start, end) + tail,
      marks,
    },
  };
}
