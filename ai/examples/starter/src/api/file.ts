// GET /api/file?id=<id>: serve a file the reader attached, to that reader only.
import project from "../lib/chat.ts";

export const GET = project.chat.file;
