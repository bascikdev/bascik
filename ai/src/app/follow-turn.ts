/**
 * Finding the reply being written for a conversation, by this server or
 * another, and following another server's reply from the shared channel,
 * telling a reader when its writer is gone.
 */
import { createBroadcast } from "../broadcast.ts";
import type { Conversation } from "../store.ts";
import type { ChatBase, LiveTurnsState, TurnFollower } from "./context.ts";
import { FOLLOW_IDLE_MS, KEEPALIVE_MS, LEASE_MS, WATCH_MS } from "./limits.ts";
import { WRITER_GONE, failedNotice, type TurnRecord } from "./turn-record.ts";
import type { LiveTurn } from "./types.ts";
import { sleep, within } from "./wait.ts";

/** Finds and follows the replies being written. */
export function turnFollower(base: ChatBase & LiveTurnsState): TurnFollower {
  const { shared, keys, onError, followLocally, live, writtenHere } = base;
  const recordKey = keys.turn;
  const stopKey = keys.stop;
  const channelKey = keys.reply;

  /**
   * A reply another server is writing, followed from its channel into a
   * broadcast of its own: one subscription per reply however many pages
   * read it here, and a page that joins late gets it from the start.
   */
  function follow(conversation: Conversation, record: TurnRecord): LiveTurn {
    const html = createBroadcast<string>();
    const stop = new AbortController();
    stop.signal.addEventListener(
      "abort",
      () => {
        shared
          .set(stopKey(conversation.id, record.turn), "1", LEASE_MS)
          .catch((error: unknown) =>
            onError(error, "Stop did not reach the server writing this reply"),
          );
      },
      { once: true },
    );
    const done = new AbortController();
    const relay = async (): Promise<void> => {
      const events = shared
        .subscribe(channelKey(conversation.id, record.turn), {
          signal: done.signal,
        })
        [Symbol.asyncIterator]();
      let next = events.next();
      let gone = 0;
      // Each wait for the next event races a timer of this request's own,
      // cleared when the event comes. Without local following it is a short
      // keepalive, and the silence it measures adds up to FOLLOW_IDLE_MS.
      const tick = followLocally ? FOLLOW_IDLE_MS : KEEPALIVE_MS;
      let silent = 0;
      for (;;) {
        const got = await within(next, tick);
        if (got === undefined) {
          silent += tick;
          if (silent < FOLLOW_IDLE_MS) continue;
          silent = 0;
          // Silence: is the writer still there? Its record, renewed with its
          // claim, says. One missed look is not enough: it may be mid-cleanup.
          let there = true;
          try {
            there = await writerThere(conversation.id, record.turn);
          } catch {
            // Not knowing is not a reason to give up.
          }
          gone = there ? 0 : gone + 1;
          if (gone < 2) continue;
          html.push(failedNotice(WRITER_GONE));
          return;
        }
        silent = 0;
        gone = 0;
        if (got.done) {
          html.push(failedNotice(WRITER_GONE));
          return;
        }
        const event = got.value;
        if (event.type === "end") return;
        html.push(
          event.type === "gap"
            ? `<p data-testid="turn-gap">The start of this reply is no longer available here. All of it appears when it is finished.</p>`
            : event.data,
        );
        next = events.next();
      }
    };
    const entry: LiveTurn = {
      messages: conversation.messages.slice(0, record.count),
      html,
      stop,
      over: relay()
        .catch((error: unknown) => {
          onError(error, "this reply could not be followed");
          html.push(failedNotice(WRITER_GONE));
        })
        .finally(() => {
          done.abort();
          if (live.get(conversation.id) === entry) live.delete(conversation.id);
          html.end();
        }),
    };
    if (followLocally) live.set(conversation.id, entry);
    return entry;
  }

  /** Whether the turn record still names `turn`: a record of a later reply is not this writer being there. Throws when the store does not answer. */
  async function writerThere(
    conversationId: string,
    turn: string,
  ): Promise<boolean> {
    const raw = await shared.get(recordKey(conversationId));
    return raw !== undefined && (JSON.parse(raw) as TurnRecord).turn === turn;
  }

  /**
   * The entry this server holds for the conversation, unless it is a reply
   * this server was writing whose writer is gone: its record ran out without
   * the entry ending (on a host that cancels a request, its timers and
   * promises can stop mid-reply). Such an entry is ended for whoever reads
   * it and dropped, so it does not hang later readers, and its writer is
   * told to stop in case it is still running after all.
   *
   * Only an entry that has gone quiet is looked up, and, as a follower does,
   * it is given up on only when its record is missing on two looks some
   * time apart: one look may catch a store that is briefly behind.
   */
  async function localEntry(
    conversationId: string,
  ): Promise<LiveTurn | undefined> {
    const here = live.get(conversationId);
    const writer = here && writtenHere.get(here);
    if (!here || writer === undefined || here.html.ended) return here;
    const gone = async (): Promise<boolean> => {
      if (Date.now() - writer.activeAt() < FOLLOW_IDLE_MS) return false;
      try {
        return !(await writerThere(conversationId, writer.turn));
      } catch {
        // Not knowing is not a reason to give up on it.
        return false;
      }
    };
    if (!(await gone())) return here;
    await sleep(WATCH_MS);
    if (live.get(conversationId) !== here || here.html.ended) {
      return live.get(conversationId);
    }
    if (!(await gone())) return here;
    // A writer that finished takes its entry out before its record, so one
    // still here with no record of its turn never finished.
    if (live.get(conversationId) === here && !here.html.ended) {
      live.delete(conversationId);
      here.html.push(failedNotice(WRITER_GONE));
      here.html.end();
      here.stop.abort();
      return undefined;
    }
    return live.get(conversationId);
  }

  /** The reply being written for a conversation, by this server or another, or undefined. */
  async function following(
    conversation: Conversation,
  ): Promise<LiveTurn | undefined> {
    if (followLocally) {
      const here = await localEntry(conversation.id);
      if (here) return here;
    }
    let record: TurnRecord;
    try {
      const raw = await shared.get(recordKey(conversation.id));
      if (raw === undefined) return undefined;
      record = JSON.parse(raw) as TurnRecord;
    } catch (error) {
      onError(error, "the shared store did not answer");
      return undefined;
    }
    // Another page may have joined while this one waited.
    return (
      (followLocally ? live.get(conversation.id) : undefined) ??
      follow(conversation, record)
    );
  }

  return { follow, writerThere, localEntry, following };
}
