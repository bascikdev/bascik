import { describe, expect, it } from "vitest";
import { createChat, memoryStore, type Chat } from "../app.ts";
import { scriptedModel, shownOf, type ModelRequest } from "../model.ts";
import { MAX_SHOWN } from "./limits.ts";

const READER = "22222222-2222-4222-8222-222222222222";
const COMMAND = "Decision on returns-window (fact): unsure";

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

const openedIn = (response: Response): string =>
  /chat_t=([0-9a-f-]{36})/.exec(response.headers.getSetCookie()[0]!)![1]!;

function setup(requests: ModelRequest[] = []): Chat {
  return createChat({
    id: "t",
    store: memoryStore(),
    catalog: new Map(),
    model: () =>
      scriptedModel(
        (request) => {
          requests.push(request);
          return "Noted.";
        },
        { delayMs: 0 },
      ),
    system: "You help.",
    page: "/books",
    onError: () => {},
    voice: {
      protocol: "fake",
      createSession: async () => ({ protocol: "fake", url: "", setup: null }),
    },
  });
}

const messagesOf = async (chat: Chat, id: string) =>
  (await chat.store.load(READER, id))!.messages;

describe("shownOf", () => {
  it("is the message, unless the message says what to show", () => {
    expect(shownOf({ role: "user", content: "Hello" })).toBe("Hello");
    expect(shownOf({ role: "user", content: COMMAND, show: "Not sure" })).toBe(
      "Not sure",
    );
    expect(shownOf({ role: "user", content: COMMAND, show: "" })).toBe("");
  });
});

describe("addMessage with what the thread shows", () => {
  it("stores the label beside the message", async () => {
    const chat = setup();
    const session = chat.session(posted({}));
    const conversation = await chat.addMessage(session, COMMAND, {
      show: "  Not sure ",
    });
    expect(await messagesOf(chat, conversation.id)).toEqual([
      { role: "user", content: COMMAND, show: "Not sure" },
    ]);
  });

  it("keeps an empty label: the thread shows nothing for the message", async () => {
    const chat = setup();
    const session = chat.session(posted({}));
    const conversation = await chat.addMessage(session, COMMAND, { show: "" });
    expect(await messagesOf(chat, conversation.id)).toEqual([
      { role: "user", content: COMMAND, show: "" },
    ]);
  });

  it("stores no label that is the message itself, and cuts a long one", async () => {
    const chat = setup();
    const session = chat.session(posted({}));
    const same = await chat.addMessage(session, "Hello", { show: "Hello" });
    expect(await messagesOf(chat, same.id)).toEqual([
      { role: "user", content: "Hello" },
    ]);
    const long = await chat.addMessage(chat.session(posted({}, same.id)), "x", {
      show: "y".repeat(MAX_SHOWN + 10),
    });
    expect((await messagesOf(chat, long.id))[1]!.show).toHaveLength(MAX_SHOWN);
  });
});

describe("a form's show field", () => {
  it("is stored as what the thread shows, and is not part of the message", async () => {
    const chat = setup();
    const response = await chat.send(
      posted({ verdict: "unsure", show: "Not sure" }),
    );
    expect(await messagesOf(chat, openedIn(response))).toEqual([
      { role: "user", content: "verdict: unsure", show: "Not sure" },
    ]);
  });

  it("shows nothing when it is empty, and the message when there is none", async () => {
    const chat = setup();
    const hidden = await chat.send(posted({ text: "Skip this one", show: "" }));
    expect(await messagesOf(chat, openedIn(hidden))).toEqual([
      { role: "user", content: "Skip this one", show: "" },
    ]);
    const plain = await chat.send(posted({ text: "Hello" }));
    expect(await messagesOf(chat, openedIn(plain))).toEqual([
      { role: "user", content: "Hello" },
    ]);
  });

  it("keeps markup and replacement tokens as the text they are", async () => {
    const chat = setup();
    const label = "<b>$1</b> $& `x`";
    const response = await chat.send(posted({ text: "Pick", show: label }));
    expect((await messagesOf(chat, openedIn(response)))[0]!.show).toBe(label);
  });

  it("comes back beside what to say during a call", async () => {
    const chat = setup();
    const answered = await chat.send(
      posted({ voice: "1", verdict: "unsure", show: "Not sure" }),
    );
    expect(await answered.json()).toEqual({
      say: "verdict: unsure",
      show: "Not sure",
    });
    const plain = await chat.send(posted({ voice: "1", text: "Hello" }));
    expect(await plain.json()).toEqual({ say: "Hello" });
  });
});

describe("a voice turn with what the thread shows", () => {
  async function call(chat: Chat): Promise<string> {
    const response = await chat.voiceSession(posted({}));
    return openedIn(response);
  }

  it("stores what the form said for the model, and its label for the thread", async () => {
    const chat = setup();
    const id = await call(chat);
    const response = await chat.voiceTurn(
      posted({ reader: COMMAND, model: "Recorded.", show: "Not sure" }, id),
    );
    expect(response.status).toBe(204);
    const [reader, model] = await messagesOf(chat, id);
    expect(reader).toEqual({
      role: "user",
      content: COMMAND,
      show: "Not sure",
    });
    expect(model!.content).toBe("Recorded.");
  });

  it("stores a form answer that shows nothing, so the record is not lost", async () => {
    const chat = setup();
    const id = await call(chat);
    await chat.voiceTurn(posted({ reader: COMMAND, model: "", show: "" }, id));
    expect(await messagesOf(chat, id)).toEqual([
      { role: "user", content: COMMAND, show: "" },
    ]);
  });

  it("stores spoken words as they are", async () => {
    const chat = setup();
    const id = await call(chat);
    await chat.voiceTurn(
      posted({ reader: "Hello", model: "", show: "Hello" }, id),
    );
    await chat.voiceTurn(posted({ reader: "Again", model: "" }, id));
    expect(await messagesOf(chat, id)).toEqual([
      { role: "user", content: "Hello" },
      { role: "user", content: "Again" },
    ]);
  });
});
