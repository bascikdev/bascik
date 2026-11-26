/**
 * What a memory may be and how memories are found: the length and count
 * limits, the text cleaned to one visible line, the newest-first order every
 * store lists in, and plain word matching for a store with nothing better.
 */
import type { Memory } from "./types.ts";

/** A memory is kept to this many characters. */
export const MAX_MEMORY_LENGTH = 500;
/** A reader keeps at most this many memories. Saving another is refused until one is forgotten. */
export const MAX_MEMORIES = 200;

/**
 * Plain text on one line: control characters, line breaks, and the invisible
 * characters that reorder text are gone, and runs of spaces are one space.
 * What is left is what a reader can see.
 */
export function cleanMemoryText(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Zl}\p{Zp}​-‏‪-‮⁦-⁩﻿]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The order every store lists in: the most recently saved first. */
export const newestFirst = (a: Memory, b: Memory): number =>
  b.created - a.created;

const touched = (memory: Memory): number => memory.updated ?? memory.created;

const wordsOf = (text: string): string[] =>
  text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * Plain word matching, for a store that has nothing better: a memory scores
 * one point for each distinct word of the query it contains, and memories
 * that share none are left out. Ties go to the one touched most recently. An
 * empty query is the newest. A store can call this over its own list.
 */
export function searchMemories(
  memories: readonly Memory[],
  query: string,
  limit: number,
): Memory[] {
  const wanted = new Set(wordsOf(query));
  if (limit <= 0) return [];
  if (wanted.size === 0) {
    return [...memories].sort(newestFirst).slice(0, limit);
  }
  return memories
    .map((memory) => ({
      memory,
      score: new Set(wordsOf(memory.text).filter((word) => wanted.has(word)))
        .size,
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || touched(b.memory) - touched(a.memory))
    .slice(0, limit)
    .map((entry) => entry.memory);
}
