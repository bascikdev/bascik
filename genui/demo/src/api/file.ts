// GET /api/file?id=<id>: serve a file the visitor attached, to that visitor only.

import { route } from "../lib/chat.ts";

export const GET = route("file");
