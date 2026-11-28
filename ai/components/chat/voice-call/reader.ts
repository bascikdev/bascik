/*
 * What the reader has said in one turn, as the pieces it arrived in. A
 * provider writes speech down an utterance at a time, and a reader who
 * pauses mid-sentence says one turn in two utterances: each is a piece with
 * the provider's name for it, so words that arrive late, or are corrected,
 * change their own piece and never another. Typed words, and words with no
 * name, are added to the end.
 */

/** One piece of the reader's turn. `id` is "" for words with no name. */
export interface ReaderPiece {
  id: string;
  text: string;
}

/**
 * Add `text` to the turn. With an `id`, it goes to that piece, which is
 * made, in spoken order, the first time it is named: `whole` replaces the
 * piece's words, and otherwise they are added to it. With no `id` it is
 * added to the last piece when that one has no name either.
 */
export function hear(
  pieces: ReaderPiece[],
  text: string,
  id = "",
  whole = false,
): void {
  let piece = id
    ? pieces.find((known) => known.id === id)
    : pieces.at(-1)?.id === ""
      ? pieces.at(-1)
      : undefined;
  if (!piece) {
    piece = { id, text: "" };
    pieces.push(piece);
  }
  piece.text = whole ? text : piece.text + text;
}

/** How many utterances of earlier turns are remembered. */
export const CLOSED_KEPT = 64;

/**
 * The turn is over, or was replaced by typed words: empty it, and keep the
 * names of its utterances in `closed`. A provider can write an utterance
 * down after its turn has ended, and those words are not the next turn's.
 * Only the last `kept` names are remembered.
 */
export function closePieces(
  pieces: ReaderPiece[],
  closed: Set<string>,
  kept = CLOSED_KEPT,
): void {
  for (const piece of pieces) {
    if (!piece.id) continue;
    // Named again, it is the newest.
    closed.delete(piece.id);
    closed.add(piece.id);
  }
  pieces.length = 0;
  for (const oldest of closed) {
    if (closed.size <= kept) break;
    closed.delete(oldest);
  }
}

/**
 * The turn as one text: the pieces in order, with a space between two that
 * have none of their own.
 */
export function readerText(pieces: readonly ReaderPiece[]): string {
  let text = "";
  for (const piece of pieces) {
    if (!piece.text.trim()) continue;
    const joined = text === "" || /\s$/.test(text) || /^\s/.test(piece.text);
    text += (joined ? "" : " ") + piece.text;
  }
  return text;
}
