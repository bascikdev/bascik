// POST /api/stop: end the reply being written for the open conversation. The
// request goes through the conversation's ConversationLive object, where the
// writer's watch sees it, and answers once what was written is stored.

import { route } from "../lib/chat.ts";

export const POST = route("stop");
