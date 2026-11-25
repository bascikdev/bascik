// POST /api/approve: the reader's answer to a tool call that needs their
// say-so. The approval card is a plain form that posts here:
//
//   app=books  call=<the tool call's id>  verdict=approve|deny
//
// The answer is stored on the tool part. Nothing runs here: the page this
// redirects to carries the turn on, runs an approved call, and tells the
// model what happened either way.

import { route } from "../lib/chat.ts";

export const POST = route("approve");
