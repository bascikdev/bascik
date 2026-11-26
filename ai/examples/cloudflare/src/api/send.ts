// POST /api/send: add the reader's message, then go back to the page, which
// streams the reply. Every form posts here, the forms the model writes too.
// `route` checks the body size and the address's windows first
// (src/lib/limits.ts), for whatever path Bascik routed here.

import { route } from "../lib/chat.ts";

export const POST = route("send");
