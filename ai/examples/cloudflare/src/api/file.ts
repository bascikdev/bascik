// GET /api/file?id=<id>: serve a file the reader attached, to that reader only.

import { route } from "../lib/chat.ts";

export const GET = route("file");
