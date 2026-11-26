// POST /api/result: the result of a client tool call (the reader's local
// time), sent by the form the call was drawn as.

import { route } from "../lib/chat.ts";

export const POST = route("answer");
