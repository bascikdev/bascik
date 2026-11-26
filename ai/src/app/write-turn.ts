/**
 * Writing a reply on the server that holds its claim: the model's turn is
 * rendered into a broadcast every page reads, sent on to other servers,
 * watched for Stop, its claim renewed, and the message stored once.
 */
import { createBroadcast } from "../broadcast.ts";
import type { ChatMessage } from "../model.ts";
import { renderTurn } from "../render-turn.ts";
import type { ChannelEvent, Lease } from "../shared.ts";
import { runTurn } from "../turn.ts";
import type { Conversation } from "../store.ts";
import type {
  ChatBase,
  ChatConversations,
  ChatPrompts,
  ChatUploads,
  LiveTurnsState,
  TurnWriter,
} from "./context.ts";
import { LEASE_MS, RENEW_MS, WATCH_MS } from "./limits.ts";
import type { Session } from "./sessions.ts";
import { failedNotice } from "./turn-record.ts";
import type { HostContext, LiveTurn } from "./types.ts";

/** Starts the replies this server writes. */
export function turnWriter(
  base: ChatBase &
    ChatPrompts &
    ChatConversations &
    Pick<ChatUploads, "readFileFor"> &
    LiveTurnsState,
): TurnWriter {
  const { options, shared, keys, onError, followLocally } = base;
  const { maxRounds, turnLimitMs, renderOptions } = base;
  const { promptFor, toolsFor, catalog, readFileFor } = base;
  const { serialized, load, save, live, writtenHere } = base;
  const recordKey = keys.turn;
  const stopKey = keys.stop;
  const channelKey = keys.reply;

  function startTurn(
    session: Session,
    conversation: Conversation,
    request: Request,
    held: { lease: Lease; turn: string },
    context: HostContext | undefined,
  ): LiveTurn {
    const html = createBroadcast<string>();
    const stop = new AbortController();
    const messages = conversation.messages;
    const carriedOn = messages.at(-1)!.role === "assistant";
    const channel = channelKey(conversation.id, held.turn);
    // What readers here see at once goes to the other servers in order,
    // without the model waiting on the shared store.
    let outbox: Promise<void> = Promise.resolve();
    let unreachable = false;
    const say = (event: ChannelEvent): void => {
      outbox = outbox
        .then(() => shared.publish(channel, event))
        .catch((error: unknown) => {
          if (unreachable) return;
          unreachable = true;
          onError(error, "other servers cannot follow this reply");
        });
    };
    let activeAt = Date.now();
    const emit = (chunk: string): void => {
      activeAt = Date.now();
      html.push(chunk);
      say({ type: "data", data: chunk });
    };
    // Another server took the conversation over, or the shared store stayed
    // away for the claim's whole length: this reply is no longer ours to
    // write, and the new holder stores its own.
    let lost = false;
    const giveUp = (why: string): void => {
      if (lost) return;
      lost = true;
      emit(failedNotice(why));
      stop.abort();
    };
    let renewedAt = Date.now();
    let looking = false;
    const watch = setInterval(async () => {
      if (looking || lost) return;
      looking = true;
      try {
        if (await shared.get(stopKey(conversation.id, held.turn))) {
          stop.abort();
        }
        if (Date.now() - renewedAt >= RENEW_MS) {
          if (await held.lease.renew()) {
            await shared.set(
              recordKey(conversation.id),
              JSON.stringify({ turn: held.turn, count: messages.length }),
              LEASE_MS,
            );
            renewedAt = Date.now();
          } else {
            giveUp(
              "This reply moved to another server. Reload the page to see it.",
            );
          }
        }
      } catch (error) {
        if (Date.now() - renewedAt > LEASE_MS) {
          onError(error, "the shared store did not answer");
          giveUp(
            "This reply was stopped because the shared store did not answer. Reload the page to try again.",
          );
        }
      } finally {
        looking = false;
      }
    }, WATCH_MS);
    // Some hosts (workerd) hand back a plain number, which has nothing to unref.
    (watch as { unref?: () => void }).unref?.();
    const write = async (): Promise<void> => {
      // What is stored if the turn cannot even start (a model that cannot be
      // made, a catalog that does not load): the reply being carried on, or a
      // new empty one. Either way the turn is finished, so a reload does not
      // start it again.
      const last = messages.at(-1)!;
      let message: ChatMessage = carriedOn
        ? {
            ...last,
            parts: last.parts?.map((part) => ({ ...part })) ?? [],
          }
        : { role: "assistant", content: "", parts: [] };
      delete message.awaiting;
      try {
        const model = await options.model(request);
        const turn = runTurn({
          model,
          system: await promptFor(false, session),
          messages,
          tools: toolsFor(session, conversation.id),
          readFile: readFileFor(session),
          ...(maxRounds === undefined ? {} : { maxRounds }),
          signal: AbortSignal.any([
            stop.signal,
            AbortSignal.timeout(turnLimitMs),
          ]),
        });
        message = turn.message;
        for await (const chunk of renderTurn(
          turn.events,
          await catalog(),
          renderOptions,
        )) {
          emit(chunk);
        }
      } catch (error) {
        onError(error, "the model failed");
        const sorry = "Something went wrong while writing this reply.";
        message.parts!.push({ type: "text", text: `\n\n${sorry}` });
        message.content = `${message.content}\n\n${sorry}`.trim();
        emit(failedNotice(sorry));
      } finally {
        // A reply whose claim was lost is not stored: whoever holds the
        // conversation now writes its own, so it is stored once.
        if (!lost) {
          if (message.parts!.length === 0) {
            delete message.parts;
            message.content = "(no reply)";
          }
          // Read the conversation again, in turn with its other writes: the
          // reader may have sent something else while this was being
          // written, and that must not be lost.
          const reply = message;
          await serialized(session, conversation.id, async () => {
            const latest =
              (await load(session, conversation.id)) ?? conversation;
            const at = messages.length - (carriedOn ? 1 : 0);
            latest.messages.splice(at, carriedOn ? 1 : 0, reply);
            await save(session, latest);
          });
        }
      }
    };
    const tidy = async (what: string, step: () => Promise<unknown>) => {
      try {
        await step();
      } catch (error) {
        onError(error, what);
      }
    };
    const entry: LiveTurn = {
      messages,
      html,
      stop,
      over: write()
        .catch((error: unknown) =>
          onError(error, "the reply could not be stored"),
        )
        .finally(async () => {
          clearInterval(watch);
          if (live.get(conversation.id) === entry) live.delete(conversation.id);
          html.end();
          // The end goes out once the reply is stored, then the record and
          // the claim: a server that sees them gone finds the message stored.
          say({ type: "end" });
          await tidy("the reply's end was not sent", () => outbox);
          if (!lost) {
            await tidy("the reply's record was not removed", () =>
              shared.delete(recordKey(conversation.id)),
            );
          }
          await tidy("Stop's signal was not removed", () =>
            shared.delete(stopKey(conversation.id, held.turn)),
          );
          await tidy("the claim was not released", () => held.lease.release());
        }),
    };
    if (followLocally) {
      live.set(conversation.id, entry);
      writtenHere.set(entry, { turn: held.turn, activeAt: () => activeAt });
    }
    // The host keeps this request's work going until the reply is stored,
    // after the reader has gone. Called as a method: Cloudflare's
    // `ExecutionContext.waitUntil` needs its `this`.
    if (typeof context?.waitUntil === "function") context.waitUntil(entry.over);
    return entry;
  }

  return { startTurn };
}
