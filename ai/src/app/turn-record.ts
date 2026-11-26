/**
 * What servers sharing one reply tell each other and the reader: the turn
 * record the writer keeps in the shared store, and the notice a page shows
 * when the reply cannot go on.
 */

export const WRITER_GONE =
  "The server writing this reply stopped. Reload the page to write it again.";

export const failedNotice = (message: string): string =>
  `<p class="failed" data-testid="turn-failed">${message}</p>`;

/** What the server writing a reply tells the others: which turn, and how much of the conversation was above it. */
export interface TurnRecord {
  turn: string;
  count: number;
}
