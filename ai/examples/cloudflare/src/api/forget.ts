// POST /api/forget: remove one thing the assistant remembers about the
// reader (id, and an optional back path), then go back.

import { route } from "../lib/chat.ts";

export const POST = route("forget");
