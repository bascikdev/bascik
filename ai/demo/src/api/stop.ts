// POST /api/stop: end the reply that is being written for the visitor's open
// conversation, and answer once what it had written is stored. The client
// runtime's Stop button posts here; the open response then ends by itself.

import { route } from "../lib/chat.ts";

export const POST = route("stop");
