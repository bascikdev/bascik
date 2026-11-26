/**
 * The spoken chat's handlers: start a voice session, run a tool call the
 * voice model made, store what was said in a turn, and show what a voice
 * tool call put on screen.
 */
import { newConversation } from "../store.ts";
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
import { field } from "./forms.ts";
import { MAX_SPEECH, MAX_TOOL_INPUT, NO_STORE, VOICE_MS } from "./limits.ts";
import type { Chat } from "./types.ts";

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

  const voiceSession: Chat["voiceSession"] = async (request) => {
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
    // What is said is stored, so there has to be a conversation to store it
    // in. A new one has an id of its own, which nothing else writes yet.
    let conversation = await changingOpen(session, async (found) => found);
    if (!conversation) {
      const created = newConversation();
      await serialized(session, created.id, () => save(session, created));
      conversation = created;
    }
    let ticket;
    try {
      ticket = await voice.createSession({
        system: await promptFor(true, session),
        tools: voiceTools(toolsFor(session, conversation.id)),
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
      shown = await updateVoice(conversation.id, async (latest) => {
        // Only into the turn that claimed it: a turn stored meanwhile
        // recorded the call as ended, and the next one is not its own, even
        // when it holds a call with the same id.
        if ((latest.round ?? 0) !== started.round) return false;
        settleVoiceTool(latest, started.run!, started.round);
        await keepView(latest, result.html);
        return result.html !== "";
      });
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
    return changingOpen(session, async (conversation) => {
      if (!conversation || reader === undefined || model === undefined) {
        return badRequest("Not a voice turn.");
      }
      if (!(await voiceOpen(conversation.id))) return noVoice();
      // The turn is taken either way: one with no room is dropped, not kept
      // to be refused again.
      const messages = await updateVoice(conversation.id, (turn) =>
        voiceMessages(turn, {
          reader: reader.slice(0, MAX_SPEECH),
          model: model.slice(0, MAX_SPEECH),
        }),
      );
      if (!messages.length) return new Response(null, { status: 204 });
      if (!roomIn(conversation, messages)) return conversationFull();
      abandonToolCalls(conversation.messages);
      if (conversation.messages.length === 0) {
        conversation.title = titleOf(
          messages[0]!.content || "Voice conversation",
        );
      }
      conversation.messages.push(...messages);
      await save(session, conversation);
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
