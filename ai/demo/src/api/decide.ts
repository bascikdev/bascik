// POST /api/decide: record one review decision, then go back to the review
// page, which streams the assistant's next step. Every review component
// (fact-check, decision-fork, code-map, gap-question, plan-review) is a plain
// form that posts here. The body is the form's named fields and nothing else:
//
//   app=review  kind=fact  item=returns-window  verdict=confirmed  note=...
//
// The decision is appended to the visitor's log as one line of JSON, and added
// to the conversation as the reviewer's message, so the model sees it too.
//
// That message is a record in a fixed shape, not something the reviewer wrote,
// so the thread shows what they pressed in its place ("Not sure"), with their
// note: the message's `show`.
//
// During a voice call (voice=1) the decision is recorded the same way, and
// the answer is { "say": "...", "show": "..." }: the reviewer's message, for
// the call to say to the speech model, and what the call shows and stores as
// their turn.
import { ConversationFullError, newConversation } from "@bascik/ai/app";
import { appFor, chatFor } from "../lib/chat.ts";
import {
  branchFrom,
  decisionFrom,
  decisionLabel,
  decisionMessage,
  recordDecision,
} from "../lib/review.ts";

export const POST = async (request: Request): Promise<Response> => {
  const form = await request.formData();
  const decision = decisionFrom(form);
  if (!decision) {
    return new Response("Not a review decision.", { status: 400 });
  }
  const show = decisionLabel(decision, branchFrom(form, decision));
  const chat = chatFor(appFor(request, "review"));
  const session = chat.session(request);
  if (form.get("voice") === "1") {
    const conversation = (await chat.load(session)) ?? newConversation();
    if (conversation.messages.length === 0) {
      conversation.title = `Review: ${decision.item}`;
    }
    await chat.save(session, conversation);
    await recordDecision(session.reader, conversation.id, decision);
    return Response.json(
      { say: decisionMessage(decision), show },
      { headers: { "cache-control": "no-store" } },
    );
  }
  let conversation;
  try {
    conversation = await chat.addMessage(session, decisionMessage(decision), {
      title: `Review: ${decision.item}`,
      show,
    });
  } catch (error) {
    // A full conversation is the reader's to start again, not a server error.
    if (error instanceof ConversationFullError) {
      return new Response(error.message, { status: 413 });
    }
    throw error;
  }
  await recordDecision(session.reader, conversation.id, decision);
  return chat.redirect(session, conversation.id);
};
