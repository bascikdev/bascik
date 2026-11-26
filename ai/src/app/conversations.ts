/**
 * Reading and storing a reader's conversations: one write at a time per
 * conversation, the public `load`/`save`/`change` that merge a caller's
 * changes with other writes, and adding the reader's message.
 */
import type { ChatMessage } from "../model.ts";
import { abandonToolCalls } from "../turn.ts";
import { newConversation, type Conversation } from "../store.ts";
import type { Chat } from "./types.ts";
import type { ChatBase, ChatConversations } from "./context.ts";
import { ConversationFullError } from "./errors.ts";
import { DEFAULT_MAX_CONVERSATION_BYTES } from "./limits.ts";
import { applyChanges } from "./merge.ts";
import type { Session } from "./sessions.ts";

/** A conversation's title: the first words of what began it. */
export const titleOf = (text: string): string =>
  text.length > 40 ? `${text.slice(0, 40)}…` : text;

/** The chat's conversations, as its handlers and callers read and store them. */
export function chatConversations(base: ChatBase): ChatConversations {
  const { options, store, sessions, page, followLocally } = base;

  const load: Chat["load"] = async (session, conversationId) =>
    store.load(session.reader, conversationId ?? session.conversationId ?? "");
  const maxConversationBytes =
    options.maxConversationBytes ?? DEFAULT_MAX_CONVERSATION_BYTES;
  /** Whether `conversation` has room for `adding`, as stored JSON. */
  const roomIn = (
    conversation: Conversation,
    adding: readonly ChatMessage[],
  ): boolean =>
    new TextEncoder().encode(
      JSON.stringify({
        ...conversation,
        messages: [...conversation.messages, ...adding],
      }),
    ).length <= maxConversationBytes;
  const save: Chat["save"] = async (session, conversation) => {
    conversation.updatedAt = Date.now();
    await store.save(session.reader, conversation);
  };
  const redirect: Chat["redirect"] = (session, conversationId) => {
    const headers = sessions.remember(session, conversationId);
    headers.set("location", page);
    return new Response(null, { status: 303, headers });
  };
  /**
   * Changes to one conversation, one at a time: each reads the conversation
   * afresh and stores it before the next reads, so two writes at once (two
   * tabs sending, a message sent as a reply is stored) never lose one. This
   * holds within one server; across several, the store has to arbitrate.
   */
  const writing = new Map<string, Promise<unknown>>();
  function serialized<T>(
    session: Session,
    conversationId: string,
    change: () => Promise<T>,
  ): Promise<T> {
    // Queuing behind another request's write is waiting on its promise.
    if (!followLocally) return change();
    const key = `${session.reader}\n${conversationId}`;
    const run = (writing.get(key) ?? Promise.resolve()).then(change);
    const settled = run.then(
      () => {},
      () => {},
    );
    writing.set(key, settled);
    void settled.then(() => {
      if (writing.get(key) === settled) writing.delete(key);
    });
    return run;
  }
  /**
   * Read the reader's open conversation and change it, in turn with every
   * other write to it. `change` gets null when none is open, and stores what
   * it changes before it returns. Every handler that changes a stored
   * conversation goes through here (or `serialized`).
   */
  function changingOpen<T>(
    session: Session,
    change: (conversation: Conversation | null) => Promise<T>,
  ): Promise<T> {
    const open = session.conversationId;
    return open === undefined
      ? change(null)
      : serialized(session, open, async () =>
          change(await load(session, open)),
        );
  }
  /*
   * The public load and save, for handlers of your own. What `load` handed
   * out is remembered as it was, so a `save` of it later can tell what the
   * caller changed from what other writes stored in between, and keep both.
   */
  const loadedAs = new WeakMap<Conversation, string>();
  const loadForCaller: Chat["load"] = async (session, conversationId) => {
    const found = await load(session, conversationId);
    if (found) loadedAs.set(found, JSON.stringify(found));
    return found;
  };
  const saveForCaller: Chat["save"] = (session, conversation) =>
    serialized(session, conversation.id, async () => {
      const base = loadedAs.get(conversation);
      let merged = conversation;
      if (base !== undefined) {
        const latest = await load(session, conversation.id);
        if (latest && JSON.stringify(latest) !== base) {
          merged = applyChanges(
            conversation,
            JSON.parse(base) as Conversation,
            latest,
          );
        }
      }
      await save(session, merged);
      // Only a stored merge becomes the caller's: a failed save leaves their
      // conversation, and what it was loaded as, for a retry to merge again.
      if (merged !== conversation) {
        const fields = conversation as unknown as Record<string, unknown>;
        for (const key of Object.keys(fields)) {
          if (!(key in merged)) delete fields[key];
        }
        Object.assign(conversation, merged);
      }
      loadedAs.set(conversation, JSON.stringify(conversation));
    });
  const change: Chat["change"] = (session, edit, conversationId) => {
    const wanted = conversationId ?? session.conversationId;
    const run = async (): Promise<Conversation> => {
      const conversation =
        (wanted === undefined ? null : await load(session, wanted)) ??
        newConversation();
      await edit(conversation);
      await save(session, conversation);
      // What `change` returns saves like what `load` returns.
      loadedAs.set(conversation, JSON.stringify(conversation));
      return conversation;
    };
    return wanted === undefined ? run() : serialized(session, wanted, run);
  };
  const addMessage: Chat["addMessage"] = async (session, text, titled) =>
    session.conversationId === undefined
      ? appendMessage(session, text, titled)
      : serialized(session, session.conversationId, () =>
          appendMessage(session, text, titled),
        );
  const appendMessage: Chat["addMessage"] = async (session, text, titled) => {
    const conversation = (await load(session)) ?? newConversation();
    const attached = titled?.files ?? [];
    if (conversation.messages.length === 0) {
      conversation.title =
        titled?.title ?? titleOf(text || attached[0]?.name || "Files");
    }
    const message: ChatMessage = attached.length
      ? {
          role: "user",
          content: text,
          parts: [
            ...(text ? [{ type: "text" as const, text }] : []),
            ...attached,
          ],
        }
      : { role: "user", content: text };
    if (!roomIn(conversation, [message])) throw new ConversationFullError();
    abandonToolCalls(conversation.messages);
    conversation.messages.push(message);
    await save(session, conversation);
    return conversation;
  };

  return {
    load,
    roomIn,
    save,
    redirect,
    serialized,
    changingOpen,
    loadForCaller,
    saveForCaller,
    change,
    addMessage,
  };
}
