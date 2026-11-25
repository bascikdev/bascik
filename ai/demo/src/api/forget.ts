// POST /api/forget: remove one thing the assistant remembers about the
// reader. The memory list's Forget buttons and a reply's Undo button are
// plain forms that post here:
//
//   app=books  id=<the memory's id>  back=<a path on this site, optional>
//
// It answers with a redirect back, so it works with no JavaScript.

import { route } from "../lib/chat.ts";

export const POST = route("forget");
