// POST /api/open: switch to another conversation of the app, or start a new
// one when the form names none.

import { route } from "../lib/chat.ts";

export const POST = route("open");
