// POST /api/result: the result of a client tool call, sent by the form the
// call was drawn as. A script in the reader's browser fills the form in and
// sends it; without scripts the reader does.
//
//   app=books  call=<the tool call's id>  output=<the result, as text>
//
// The result is stored on the tool part, and the page this redirects to
// carries the turn on, so the model reads it like any other tool's output.

import { route } from "../lib/chat.ts";

export const POST = route("answer");
