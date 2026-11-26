/**
 * Live turns: a reply is written once, whoever is watching. A page's request
 * finds the reply being written or claims the conversation and starts it,
 * and Stop reaches the writer here or on another server.
 */
import { randomUUID } from "node:crypto";
import type { Lease } from "../shared.ts";
import type { Conversation } from "../store.ts";
import { turnPending } from "../turn.ts";
import type {
  ChatBase,
  ChatConversations,
  ChatLiveTurns,
  ChatPrompts,
  ChatUploads,
  LiveTurnsState,
} from "./context.ts";
import { turnFollower } from "./follow-turn.ts";
import { LEASE_MS } from "./limits.ts";
import type { Session } from "./sessions.ts";
import type { TurnRecord } from "./turn-record.ts";
import type { HostContext, LiveTurn, ThreadState } from "./types.ts";
import { sleep } from "./wait.ts";
import { turnWriter } from "./write-turn.ts";

/** The chat's live turns: what a page shows, and Stop. */
export function chatLiveTurns(
  base: ChatBase & ChatPrompts & ChatConversations & ChatUploads,
): ChatLiveTurns {
  const { shared, keys, onError, followLocally, sessions, load } = base;
  const leaseKey = keys.lease;
  const recordKey = keys.turn;
  const stopKey = keys.stop;

  /**
   * Every reply this server writes or follows, by conversation. Unused with
   * `followLocally: false`: no request reads another's entry there.
   */
  const live = new Map<string, LiveTurn>();
  /**
   * Each entry in `live` that this server writes (not follows): its turn,
   * and when it last pushed something, so a busy reply is not looked up in
   * the shared store on every page read.
   */
  const writtenHere = new WeakMap<
    LiveTurn,
    { turn: string; activeAt: () => number }
  >();

  const state: LiveTurnsState = { live, writtenHere };
  const { startTurn } = turnWriter({ ...base, ...state });
  const { localEntry, following } = turnFollower({ ...base, ...state });

  /** Claim the conversation and start its reply, or join the reply whoever holds it is writing. */
  async function claimTurn(
    session: Session,
    conversation: Conversation,
    request: Request,
    context: HostContext | undefined,
  ): Promise<LiveTurn | undefined> {
    let lease: Lease | null = null;
    try {
      for (let tries = 0; ; tries++) {
        lease = await shared.claim(leaseKey(conversation.id), LEASE_MS);
        if (lease) break;
        // Held elsewhere: that server records its reply straight away, or
        // is just finishing the last one and lets go.
        const turn = await following(conversation);
        if (turn) return turn;
        if (tries >= 9) return undefined;
        await sleep(50);
      }
      // The holder before this one may have finished between this page's
      // reading the conversation and the claim: only a message still
      // waiting is answered.
      const fresh = (await load(session, conversation.id)) ?? conversation;
      if (!turnPending(fresh.messages)) {
        await lease.release();
        return undefined;
      }
      const turn = randomUUID();
      const record: TurnRecord = { turn, count: fresh.messages.length };
      await shared.set(
        recordKey(conversation.id),
        JSON.stringify(record),
        LEASE_MS,
      );
      return startTurn(session, fresh, request, { lease, turn }, context);
    } catch (error) {
      onError(error, "no reply could be started");
      await lease?.release().catch(() => {});
      return undefined;
    }
  }

  /**
   * Two pages of one server asking at once start one reply. Without local
   * following, each request makes its own claim, and the lease decides.
   */
  const starting = new Map<string, Promise<LiveTurn | undefined>>();
  function startOnce(
    session: Session,
    conversation: Conversation,
    request: Request,
    context: HostContext | undefined,
  ): Promise<LiveTurn | undefined> {
    if (!followLocally) {
      return claimTurn(session, conversation, request, context);
    }
    let pending = starting.get(conversation.id);
    if (!pending) {
      pending = claimTurn(session, conversation, request, context).finally(() =>
        starting.delete(conversation.id),
      );
      starting.set(conversation.id, pending);
    }
    return pending;
  }

  /** One answer per request: keyed by the request itself, never shared between two. */
  const states = new WeakMap<Request, Promise<ThreadState>>();

  function thread(
    request: Request,
    context?: HostContext,
  ): Promise<ThreadState> {
    let state = states.get(request);
    if (!state) {
      state = (async () => {
        const session = sessions.identify(request);
        let conversation = await load(session);
        let turn = conversation ? await following(conversation) : undefined;
        if (conversation && !turn && turnPending(conversation.messages)) {
          // No reply is being written right now, so the store is settled:
          // read it once more, and start the turn.
          conversation = (await load(session)) ?? conversation;
          turn = await following(conversation);
          if (!turn && turnPending(conversation.messages)) {
            turn = await startOnce(session, conversation, request, context);
          }
        }
        return {
          session,
          messages: turn?.messages ?? conversation?.messages ?? [],
          turn: turn ?? undefined,
        };
      })();
      states.set(request, state);
    }
    return state;
  }

  async function stopTurn(conversationId: string): Promise<boolean> {
    // Without local following, Stop always goes through the shared store,
    // and the writer's own watch picks it up.
    const entry = followLocally ? await localEntry(conversationId) : undefined;
    if (entry) {
      entry.stop.abort();
      await entry.over;
      return true;
    }
    // Perhaps another server is writing it: ask it to stop, and wait for it.
    try {
      const raw = await shared.get(recordKey(conversationId));
      if (raw === undefined) return false;
      const record = JSON.parse(raw) as TurnRecord;
      await shared.set(stopKey(conversationId, record.turn), "1", LEASE_MS);
      for (
        const until = Date.now() + LEASE_MS;
        Date.now() < until && (await shared.get(recordKey(conversationId)));
      ) {
        await sleep(50);
      }
    } catch (error) {
      onError(error, "Stop did not reach the shared store");
      return false;
    }
    return true;
  }

  return { thread, stopTurn };
}
