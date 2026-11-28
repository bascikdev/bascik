// POST /api/open: open one of the reader's conversations, or start a new one
// when the form names none. The sidebar's forms post here.
import project from "../lib/chat.ts";

export const POST = project.chat.open;
