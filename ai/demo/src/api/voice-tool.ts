// POST /api/voice-tool: run a tool call a voice model made. The browser holds
// the connection to the model, so the call arrives there; it is sent here to
// be checked, run, and drawn, and the browser passes the result back.
//
//   app=books  id=<the call's id>  name=place_hold  input={"title":"..."}
//   decision=approve|deny   (only to answer a call that waits for approval)
//
// Answers { state, output?, view }. `output` is what to tell the model, and
// is absent while the call waits for the reader. `view` is true when the call
// has something to put on screen, which the page reads from /voice-view.

import { route } from "../lib/chat.ts";

export const POST = route("voiceTool");
