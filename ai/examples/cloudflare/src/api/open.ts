// POST /api/open: switch to another of the reader's conversations, or start
// a new one when the form names none.

import { route } from "../lib/chat.ts";

export const POST = route("open");
