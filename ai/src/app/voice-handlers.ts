/**
 * The spoken chat's handlers: start a voice session, run a tool call the
 * voice model made, store what was said in a turn, and show what a voice
 * tool call put on screen.
 */
import type { ChatMessage } from "../model.ts";
import { newConversation, type Conversation } from "../store.ts";
import { abandonToolCalls } from "../turn.ts";
import {
  finishVoiceTool,
  noteVoiceView,
  settleVoiceTool,
  startVoiceTool,
  voiceCallId,
  voiceMessages,
  voiceTools,
  type VoiceTurn,
} from "../voice.ts";
import type {
  ChatBase,
  ChatConversations,
  ChatPrompts,
  ChatUploads,
  ChatVoiceState,
} from "./context.ts";
import { titleOf } from "./conversations.ts";
import {
  ConversationFullError,
  badRequest,
  conversationFull,
} from "./errors.ts";
import { crossSite, field } from "./forms.ts";
import { MAX_SPEECH, MAX_TOOL_INPUT, NO_STORE, VOICE_MS } from "./limits.ts";
import type { Session } from "./sessions.ts";
import type { Chat } from "./types.ts";

/** A turn's id, as a browser may send it with `voiceTurn`. Any other is not used. */
const TURN_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** How many stored turns' ids a call remembers, newest last. */
const MAX_STORED_TURN_IDS = 64;

/** The handlers of a spoken chat, and the voice view a page reads. */
export type ChatVoiceHandlers = Pick<
  Chat,
  "voiceSession" | "voiceTool" | "voiceTurn" | "voiceView"
>;

/** The chat's voice handlers. */
export function chatVoiceHandlers(
  base: ChatBase &
    ChatPrompts &
    ChatConversations &
    ChatUploads &
    ChatVoiceState,
): ChatVoiceHandlers {
  const { options, sessions, shared, onError, renderOptions } = base;
  const { promptFor, toolsFor, catalog } = base;
  const { load, save, serialized, changingOpen, roomIn } = base;
  const { formOf } = base;
  const {
    pickedVoice,
    voiceOpenKey,
    voiceOpen,
    noVoice,
    viewKey,
    updateVoice,
  } = base;

  /** Store a voice turn's messages in its conversation. False when it has no room. */
  const storeTurn = async (
    session: Session,
    conversation: Conversation,
    messages: ChatMessage[],
  ): Promise<boolean> => {
    if (!roomIn(conversation, messages)) return false;
    abandonToolCalls(conversation.messages);
    if (conversation.messages.length === 0) {
      conversation.title = titleOf(
        messages[0]!.content || "Voice conversation",
      );
    }
    conversation.messages.push(...messages);
    await save(session, conversation);
    return true;
  };

  const voiceSession: Chat["voiceSession"] = async (request) => {
    // No form is read here, so where the request came from is checked here.
    const refused = crossSite(request);
    if (refused) return refused;
    const session = sessions.identify(request);
    const wanted = new URL(request.url).searchParams.get("provider");
    const voice =
      typeof options.voice === "function"
        ? await options.voice(wanted)
        : (options.voice ?? null);
    if (!voice) {
      return new Response("This server has no voice provider.", {
        status: 404,
      });
    }
    // A call that ended without storing its last turn (the page was closed,
    // the connection dropped) left it recorded. It is stored now, as ended:
    // its parts are not the new call's, and a call still waiting for the
    // reader in it can no longer be approved.
    let found: Conversation | null;
    try {
      found = await changingOpen(session, async (open) => {
        if (!open) return open;
        const left = await updateVoice(open.id, (turn) =>
          turn.parts.length
            ? voiceMessages(turn, { reader: "", model: "" })
            : [],
        );
        if (left.length) await storeTurn(session, open, left);
        return open;
      });
    } catch (error) {
      onError(error, "the last voice call's turn was not stored");
      return new Response("The voice call could not be started.", {
        status: 502,
      });
    }
    // What is said is stored, so there has to be a conversation to store it
    // in. A new one has an id of its own, which nothing else writes yet. It
    // is stored once there is a ticket, so a provider that fails leaves no
    // empty conversation behind.
    const created = found ? null : newConversation();
    const conversation = found ?? created!;
    let ticket;
    try {
      ticket = await voice.createSession({
        system: await promptFor(true, session),
        tools: voiceTools(toolsFor(session, conversation.id)),
        owner: session.reader,
      });
    } catch (error) {
      onError(error, "no voice session");
      return new Response("The voice provider did not answer.", {
        status: 502,
      });
    }
    if (pickedVoice) {
      // The picker offered a provider for this conversation: its tool calls
      // and turns are taken from now on.
      try {
        await shared.set(voiceOpenKey(conversation.id), "1", VOICE_MS);
      } catch (error) {
        onError(error, "the shared store did not answer");
        return new Response("The voice call could not be started.", {
          status: 502,
        });
      }
    }
    if (created) {
      await serialized(session, created.id, () => save(session, created));
    }
    const headers = sessions.remember(session, conversation.id);
    headers.set("content-type", "application/json");
    headers.set("cache-control", "no-store");
    return new Response(JSON.stringify(ticket), { headers });
  };

  const voiceTool: Chat["voiceTool"] = async (request) => {
    const form = await formOf(request, "Not a tool call.");
    if (form instanceof Response) return form;
    const session = sessions.identify(request);
    const callId = field(form, "id");
    const name = field(form, "name");
    const raw = field(form, "input");
    const decision = form.get("decision");
    const conversation = await load(session);
    if (
      !conversation ||
      callId === undefined ||
      name === undefined ||
      raw === undefined ||
      raw.length > MAX_TOOL_INPUT ||
      (decision !== null && decision !== "approve" && decision !== "deny")
    ) {
      return badRequest("Not a tool call.");
    }
    if (!(await voiceOpen(conversation.id))) return noVoice();
    if (!roomIn(conversation, [])) {
      // Nothing more of this call could be stored: the model is told now.
      return Response.json(
        {
          state: "failed",
          output: `Error: ${new ConversationFullError().message}`,
          view: false,
        },
        { headers: NO_STORE },
      );
    }
    let input: unknown;
    try {
      input = JSON.parse(raw || "{}");
    } catch {
      // Passed on as it is: the call is refused, and the model is told.
      input = raw;
    }
    const tools = toolsFor(session, conversation.id);
    const catalogNow = await catalog();
    // Keep what a call shows, and no more than MAX_VOICE_VIEWS of them for
    // the conversation. Called under the turn's lock.
    // The id the call is recorded under, and its view kept under.
    const call = voiceCallId(callId);
    const keepView = async (turn: VoiceTurn, html: string): Promise<void> => {
      if (!html) return;
      await shared.set(viewKey(conversation.id, call), html, VOICE_MS);
      for (const old of noteVoiceView(turn, call)) {
        await shared.delete(viewKey(conversation.id, old));
      }
    };
    // Record the call, or claim the call a decision answers, on the latest
    // turn under its lock: of requests that overlap, one claims a call and
    // the others are refused, so a call runs at most once.
    const started = await updateVoice(conversation.id, async (latest) => {
      const start = startVoiceTool(
        latest,
        { id: call, name, input, ...(decision ? { decision } : {}) },
        tools,
        catalogNow,
        renderOptions,
      );
      if (start.run) start.run = structuredClone(start.run);
      else await keepView(latest, start.result!.html);
      return start;
    });
    let result = started.result!;
    let shown = !started.run && result.html !== "";
    if (started.run) {
      // Run with no lock held, then record what came of it.
      result = await finishVoiceTool(
        started.run,
        tools,
        catalogNow,
        renderOptions,
      );
      try {
        shown = await updateVoice(conversation.id, async (latest) => {
          // Only into the turn that claimed it: a turn stored meanwhile
          // recorded the call as ended, and the next one is not its own, even
          // when it holds a call with the same id.
          if ((latest.round ?? 0) !== started.round) return false;
          settleVoiceTool(latest, started.run!, started.round);
          await keepView(latest, result.html);
          return result.html !== "";
        });
      } catch (error) {
        // The tool ran, so the model is told what came of it either way: an
        // error here would have it wait, or ask for the call again.
        onError(error, "a voice tool's result was not recorded");
        shown = false;
      }
    }
    return Response.json(
      { state: result.state, output: result.output, view: shown },
      { headers: NO_STORE },
    );
  };

  const voiceTurn: Chat["voiceTurn"] = async (request) => {
    const form = await formOf(request, "Not a voice turn.");
    if (form instanceof Response) return form;
    const session = sessions.identify(request);
    const reader = field(form, "reader");
    const model = field(form, "model");
    // What the thread shows for the reader's words, when a form they pressed
    // told the model something else.
    const show = field(form, "show");
    // The browser may name the turn, so the same turn sent twice (a retry
    // after a lost answer) is stored once.
    const named = field(form, "turn");
    const turnId = named !== undefined && TURN_ID.test(named) ? named : null;
    return changingOpen(session, async (conversation) => {
      if (!conversation || reader === undefined || model === undefined) {
        return badRequest("Not a voice turn.");
      }
      if (!(await voiceOpen(conversation.id))) return noVoice();
      // The turn is taken either way: one with no room is dropped, not kept
      // to be refused again.
      const messages = await updateVoice(conversation.id, (turn) => {
        if (turnId !== null) {
          if ((turn.stored ?? []).includes(turnId)) return null;
          turn.stored = [...(turn.stored ?? []), turnId].slice(
            -MAX_STORED_TURN_IDS,
          );
        }
        return voiceMessages(turn, {
          reader: reader.slice(0, MAX_SPEECH),
          model: model.slice(0, MAX_SPEECH),
          ...(show === undefined ? {} : { show: show.slice(0, MAX_SPEECH) }),
        });
      });
      // Stored already, or nothing to store.
      if (!messages?.length) return new Response(null, { status: 204 });
      try {
        if (!(await storeTurn(session, conversation, messages))) {
          return conversationFull();
        }
      } catch (error) {
        if (turnId !== null) {
          // Not stored after all: the same turn sent again is taken.
          await updateVoice(conversation.id, (turn) => {
            turn.stored = (turn.stored ?? []).filter((id) => id !== turnId);
          }).catch(() => {});
        }
        throw error;
      }
      return new Response(null, { status: 204 });
    });
  };

  const voiceView: Chat["voiceView"] = async (request, call) => {
    // With no voice provider there are no voice views: nothing is looked up.
    if (options.voice == null) return "";
    const conversation = await load(sessions.identify(request));
    if (!conversation) return "";
    try {
      if (!(await voiceOpen(conversation.id))) return "";
      // Under the id the call was recorded under, as voiceTool keeps it.
      return (
        (await shared.get(viewKey(conversation.id, voiceCallId(call)))) ?? ""
      );
    } catch (error) {
      onError(error, "the shared store did not answer");
      return "";
    }
  };

  return { voiceSession, voiceTool, voiceTurn, voiceView };
}
