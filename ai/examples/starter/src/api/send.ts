// POST /api/send: add the reader's message, then send them back to the page,
// which streams the reply. The composer and every form the model writes post
// here.
import project from "../lib/chat.ts";

export const POST = project.chat.send;
