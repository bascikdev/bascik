// POST /api/send: add the reader's message, then go back to the page, which
// streams the reply. Every form posts here, the forms the model writes too.
// The wrapper Worker has already checked the body size and the address's
// send window (worker.ts).

import { route } from "../lib/chat.ts";

export const POST = route("send");
