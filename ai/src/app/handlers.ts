/**
 * The typed chat's request handlers: send a message, serve an attached file,
 * answer a tool call, stop a reply, open a conversation, forget a memory,
 * and the memory list and search a page reads.
 */
import { fileResponse, refusals, refusedPage } from "../files.ts";
import { forgetMemory } from "../memory.ts";
import {
  MAX_QUERY,
  MIN_QUERY,
  isSafeKey,
  newConversation,
  searchConversations,
  type Conversation,
} from "../store.ts";
import { answerToolCall, decideToolCall } from "../turn.ts";
import type {
  ChatBase,
  ChatConversations,
  ChatLiveTurns,
  ChatUploads,
} from "./context.ts";
import {
  ConversationFullError,
  badRequest,
  conversationFull,
} from "./errors.ts";
import {
  crossSite,
  field,
  localPath,
  messageFrom,
  shownFrom,
} from "./forms.ts";
import { MAX_MESSAGE, NO_STORE, SEARCH_LIMIT } from "./limits.ts";
import type { Chat } from "./types.ts";

/** The handlers of a typed chat, and what a page reads besides the thread. */
export type ChatHandlers = Pick<
  Chat,
  | "send"
  | "file"
  | "approve"
  | "answer"
  | "stop"
  | "open"
  | "forget"
  | "memories"
  | "memoryList"
  | "search"
>;

/** The chat's typed-chat handlers. */
export function chatHandlers(
  base: ChatBase & ChatConversations & ChatUploads & ChatLiveTurns,
): ChatHandlers {
  const { memory, page, store, sessions } = base;
  const { load, save, redirect, changingOpen, addMessage } = base;
  const { formOf, fileStore, fileLimits, maxBodyBytes, attach } = base;
  const { stopTurn } = base;

  const send: Chat["send"] = async (request) => {
    // A body past the limit is turned away; past it, nothing more is read.
    const form = await formOf(request, "Not a form.");
    if (form instanceof Response) {
      if (fileStore && form.status === 413) {
        const declared = Number(request.headers.get("content-length"));
        return refusedPage(
          refusals.total(
            declared > maxBodyBytes ? declared : maxBodyBytes + 1,
            fileLimits.maxTotalBytes,
          ),
          "",
          page,
        );
      }
      return form;
    }
    const session = sessions.identify(request);
    const text = messageFrom(form).slice(0, MAX_MESSAGE);
    // What the thread shows for it, when the form says: a label, or nothing.
    const show = shownFrom(form);
    if (form.get("voice") === "1") {
      // The call stores its own turns: this only says what to say, and what
      // to show for it.
      return Response.json(
        show === undefined ? { say: text } : { say: text, show },
        { headers: NO_STORE },
      );
    }
    const attached = await attach(session, form, text);
    if (attached instanceof Response) return attached;
    if (!text && attached.length === 0) {
      const conversation = (await load(session)) ?? newConversation();
      return redirect(session, conversation.id);
    }
    let added: Conversation;
    try {
      added = await addMessage(session, text, {
        files: attached,
        ...(show === undefined ? {} : { show }),
      });
    } catch (error) {
      if (error instanceof ConversationFullError) return conversationFull();
      throw error;
    }
    return redirect(session, added.id);
  };

  const file: Chat["file"] = async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, {
        status: 405,
        headers: { allow: "GET, HEAD" },
      });
    }
    const id = new URL(request.url).searchParams.get("id");
    const { reader } = sessions.identify(request);
    // Looked up under the reader's own key: another reader's file is not found.
    const found =
      fileStore && isSafeKey(id) ? await fileStore.get(reader, id) : null;
    return found
      ? fileResponse(found)
      : new Response("No such file.", { status: 404, headers: NO_STORE });
  };

  const approve: Chat["approve"] = async (request) => {
    const form = await formOf(request, "Not a form.");
    if (form instanceof Response) return form;
    const session = sessions.identify(request);
    const call = field(form, "call");
    const verdict = form.get("verdict");
    return changingOpen(session, async (conversation) => {
      if (
        !conversation ||
        call === undefined ||
        (verdict !== "approve" && verdict !== "deny") ||
        !decideToolCall(conversation.messages, call, verdict === "approve")
      ) {
        return badRequest("No tool call is waiting for that answer.");
      }
      await save(session, conversation);
      return redirect(session, conversation.id);
    });
  };

  const answer: Chat["answer"] = async (request) => {
    const form = await formOf(request, "Not a form.");
    if (form instanceof Response) return form;
    const session = sessions.identify(request);
    const call = field(form, "call");
    const output = field(form, "output")?.trim();
    return changingOpen(session, async (conversation) => {
      if (
        !conversation ||
        call === undefined ||
        !output ||
        !answerToolCall(conversation.messages, call, output)
      ) {
        return badRequest("No tool call is waiting for that result.");
      }
      await save(session, conversation);
      return redirect(session, conversation.id);
    });
  };

  const stop: Chat["stop"] = async (request) => {
    // Stop reads no form, so it checks where the request came from itself.
    const refused = crossSite(request);
    if (refused) return refused;
    // Only the reader's own conversation: its id in a cookie is not enough.
    const conversation = await load(sessions.identify(request));
    const stopped = conversation !== null && (await stopTurn(conversation.id));
    return new Response(null, { status: stopped ? 204 : 404 });
  };

  const open: Chat["open"] = async (request) => {
    const form = await formOf(request, "Not a form.");
    if (form instanceof Response) return form;
    const session = sessions.identify(request);
    const conversation =
      (await load(session, field(form, "id") ?? "")) ?? newConversation();
    return redirect(session, conversation.id);
  };

  const forget: Chat["forget"] = async (request) => {
    const form = await formOf(request, "Not a form.");
    if (form instanceof Response) return form;
    const session = sessions.identify(request);
    const memoryId = field(form, "id");
    if (!memory || memoryId === undefined) {
      return badRequest("No memory to forget.");
    }
    await forgetMemory(memory, session.reader, memoryId);
    // Back to where the form was: a path on this site, never another one.
    const headers = session.conversationId
      ? sessions.remember(session, session.conversationId)
      : new Headers();
    headers.set("location", localPath(field(form, "back")) ?? page);
    return new Response(null, { status: 303, headers });
  };

  const memories: Chat["memories"] = async (request) =>
    memory ? memory.list(sessions.identify(request).reader) : [];

  const memoryList: Chat["memoryList"] = async (request) =>
    Response.json({ memories: await memories(request) }, { headers: NO_STORE });

  const search: Chat["search"] = async (request) => {
    const session = sessions.identify(request);
    const query = (new URL(request.url).searchParams.get("q") ?? "")
      .trim()
      .slice(0, MAX_QUERY);
    const tooShort = query.length < MIN_QUERY;
    return {
      query,
      tooShort,
      matches: tooShort
        ? []
        : await searchConversations(store, session.reader, query, SEARCH_LIMIT),
    };
  };

  return {
    send,
    file,
    approve,
    answer,
    stop,
    open,
    forget,
    memories,
    memoryList,
    search,
  };
}
