// POST /api/voice-session: start a spoken conversation. Answers with a
// ticket the browser uses to connect to the voice provider itself:
//
//   { "protocol": "gemini-live", "url": "wss://...access_token=...", "setup": {...} }
//
// The ticket is good for one session, for a minute, and has the app's
// instructions and tools locked into it. The API key never leaves the server.
// With Azure Voice Live the address is this server's relay, which holds the
// credential and the setup. A server set up for more than one provider uses
// the first, unless the request names one: ?provider=gemini-live.
// 404 when this server has no voice provider.

import { route } from "../lib/chat.ts";

export const POST = route("voiceSession");
