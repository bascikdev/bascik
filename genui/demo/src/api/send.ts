// POST /api/send: add the visitor's message, then go back to the app's page,
// which streams the reply. Every form posts here, including the forms the
// model generates.
//
// During a voice call the reader's message goes to the speech model, not to a
// typed reply. A form posted with voice=1 is answered with what it says,
// { "say": "..." }, and nothing is added here: the call stores its own turns.
// A route whose message is a record, not the reader's words, adds
// "hidden": true, and the call leaves it out of the thread.

import { route } from "../lib/chat.ts";

export const POST = route("send");
