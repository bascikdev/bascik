// POST /api/voice-turn: store what was just said. The browser sends the two
// transcripts when the model finishes a turn (or the call ends); the tool
// calls and what was shown were recorded here as they happened.
//
//   app=books  reader=<what the reader said>  model=<what the model said>

import { route } from "../lib/chat.ts";

export const POST = route("voiceTurn");
