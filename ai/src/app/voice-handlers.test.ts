import { describe, expect, it } from "vitest";
import { createChat, memoryStore, type Chat } from "../app.ts";
import { scriptedModel } from "../model.ts";
import { MAX_SHOWN, MAX_SPEECH } from "./limits.ts";

const READER = "33333333-3333-4333-8333-333333333333";

/** A form post as a browser sends it. */
function posted(fields: Record<string, string>, conversation?: string) {
  const cookie = [`visitor=${READER}`, conversation && `chat_t=${conversation}`]
    .filter(Boolean)
    .join("; ");
  return new Request("http://localhost/api/x", {
    method: "POST",
    headers: { cookie },
    body: new URLSearchParams(fields),
  });
}

const setup = (): Chat =>
  createChat({
    id: "t",
    store: memoryStore(),
    catalog: new Map(),
    model: () => scriptedModel(() => "Noted.", { delayMs: 0 }),
    system: "You help.",
    page: "/books",
    onError: () => {},
    voice: {
      protocol: "fake",
      createSession: async () => ({ protocol: "fake", url: "", setup: null }),
    },
  });

describe("a voice turn's stored text", () => {
  it("keeps as much of what the thread shows as of what was said", async () => {
    const chat = setup();
    const opened = await chat.voiceSession(posted({}));
    const id = /chat_t=([0-9a-f-]{36})/.exec(
      opened.headers.getSetCookie()[0]!,
    )![1]!;
    // A long turn of speech that ends in a form the model filled in.
    const speech = "word ".repeat(MAX_SHOWN / 5 + 200).trim();
    const response = await chat.voiceTurn(
      posted(
        {
          reader: `${speech}\nseats: 2`,
          model: "Booked.",
          show: `${speech}\nTwo seats`,
        },
        id,
      ),
    );
    expect(response.status).toBe(204);
    const [reader] = (await chat.store.load(READER, id))!.messages;
    expect(reader!.show).toBe(`${speech}\nTwo seats`);

    const long = await chat.voiceTurn(
      posted(
        { reader: "x", model: "y", show: "z".repeat(MAX_SPEECH + 10) },
        id,
      ),
    );
    expect(long.status).toBe(204);
    const stored = (await chat.store.load(READER, id))!.messages;
    expect(stored.at(-2)!.show).toHaveLength(MAX_SPEECH);
  });
});
