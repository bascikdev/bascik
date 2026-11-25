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
// During a voice call (voice=1) the decision is recorded the same way, and
// the answer is { "say": "...", "hidden": true }: the reviewer's message, for
// the call to say to the speech model. It is a record in a fixed shape and
// not something the reviewer wrote, so the call does not show it as theirs.
import { newConversation } from "@bascik/genui/app";
import { appFor, chatFor } from "../lib/chat.ts";
import {
  decisionFrom,
  decisionMessage,
  recordDecision,
} from "../lib/review.ts";

export const POST = async (request: Request): Promise<Response> => {
  const form = await request.formData();
  const decision = decisionFrom(form);
  if (!decision) {
    return new Response("Not a review decision.", { status: 400 });
  }
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
      { say: decisionMessage(decision), hidden: true },
      { headers: { "cache-control": "no-store" } },
    );
  }
  const conversation = await chat.addMessage(
    session,
    decisionMessage(decision),
    { title: `Review: ${decision.item}` },
  );
  await recordDecision(session.reader, conversation.id, decision);
  return chat.redirect(session, conversation.id);
};
