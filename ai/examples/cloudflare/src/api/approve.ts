// POST /api/approve: the reader's answer to a tool call that needs their
// say-so (app, call, verdict=approve|deny). The page this redirects to
// carries the turn on.

import { route } from "../lib/chat.ts";

export const POST = route("approve");
