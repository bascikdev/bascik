import { describe, expect, it } from "vitest";
import {
  allAnswers,
  field,
  localPath,
  messageFrom,
  readForm,
  shownFrom,
} from "./forms.ts";
import { MAX_SHOWN } from "./limits.ts";

describe("localPath", () => {
  it("keeps a path on this site, with its query and hash", () => {
    expect(localPath("/")).toBe("/");
    expect(localPath("/books?page=2#top")).toBe("/books?page=2#top");
    expect(localPath("/a/../b")).toBe("/b");
  });

  it("refuses anything that is not a path on this site", () => {
    for (const back of [
      undefined,
      "",
      "books",
      "https://example.com/",
      "//evil.example",
      "/\\evil.example",
      "/\t/evil.example",
    ]) {
      expect(localPath(back), String(back)).toBeUndefined();
    }
  });

  it("refuses dot segments that would resolve to another host", () => {
    for (const back of [
      "/.//evil.example",
      "/a/..//evil.example",
      "/%2e//evil.example",
    ]) {
      expect(localPath(back), back).toBeUndefined();
    }
  });
});

describe("field", () => {
  it("reads a text field, and nothing for a missing one or a file", () => {
    const form = new FormData();
    form.append("title", "Dune");
    form.append("cover", new File(["x"], "dune.png"));
    expect(field(form, "title")).toBe("Dune");
    expect(field(form, "author")).toBeUndefined();
    expect(field(form, "cover")).toBeUndefined();
  });
});

describe("messageFrom", () => {
  it("sends a text field, trimmed", () => {
    const form = new FormData();
    form.append("text", "  Recommend a novel  ");
    form.append("title", "Dune");
    expect(messageFrom(form)).toBe("Recommend a novel");
  });

  it("sends any other form as name: value lines, without app, voice or blanks", () => {
    const form = new FormData();
    form.append("app", "books");
    form.append("title", "Dune");
    form.append("author", " Frank Herbert ");
    form.append("voice", "1");
    form.append("rating", "   ");
    expect(messageFrom(form)).toBe("title: Dune\nauthor: Frank Herbert");
  });
});

describe("readForm", () => {
  const post = (body: BodyInit, headers: Record<string, string> = {}) =>
    new Request("http://localhost/", {
      method: "POST",
      body,
      headers,
      duplex: "half",
    } as RequestInit);

  it("reads a form under the limit", async () => {
    const form = await readForm(
      post(new URLSearchParams({ text: "Dune" })),
      100,
    );
    expect(form).toBeInstanceOf(FormData);
    expect((form as FormData).get("text")).toBe("Dune");
  });

  it("answers not a form for a JSON body", async () => {
    const request = post('{"text":"Dune"}', {
      "content-type": "application/json",
    });
    expect(await readForm(request, 100)).toBe("not a form");
  });

  it("answers too large from a Content-Length past the limit", async () => {
    const request = post("text=Dune", {
      "content-type": "application/x-www-form-urlencoded",
      "content-length": "999999",
    });
    expect(await readForm(request, 10)).toBe("too large");
  });

  it("cuts off a streamed body with no Content-Length at the limit", async () => {
    const bytes = new TextEncoder().encode(`text=${"b".repeat(100)}`);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const request = post(stream, {
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(request.headers.get("content-length")).toBeNull();
    expect(await readForm(request, 10)).toBe("too large");
  });
});

describe("shownFrom", () => {
  it("is the form's show field, trimmed and cut to MAX_SHOWN", () => {
    const form = new FormData();
    expect(shownFrom(form)).toBeUndefined();
    form.set("show", "  Not sure ");
    expect(shownFrom(form)).toBe("Not sure");
    form.set("show", "");
    expect(shownFrom(form)).toBe("");
    form.set("show", "x".repeat(MAX_SHOWN + 5));
    expect(shownFrom(form)).toHaveLength(MAX_SHOWN);
    form.set("show", new File(["x"], "label.txt"));
    expect(shownFrom(form)).toBeUndefined();
  });

  it("is left out of the message a form stands for", () => {
    const form = new FormData();
    form.set("verdict", "unsure");
    form.set("show", "Not sure");
    expect(messageFrom(form)).toBe("verdict: unsure");
  });
});

describe("a form whose fields are all answers", () => {
  /** An input-form as posted: its own `fields` field, then the model's fields. */
  const answered = (fields: [string, string][]): FormData => {
    const form = new FormData();
    form.append("fields", "message");
    for (const [name, value] of fields) form.append(name, value);
    return form;
  };

  it("is one whose first fields value is message", () => {
    expect(allAnswers(answered([]))).toBe(true);
    expect(allAnswers(new FormData())).toBe(false);
    const named = new FormData();
    named.append("fields", "three");
    named.append("fields", "message");
    expect(allAnswers(named)).toBe(false);
  });

  it("sends a field named show as a line, and never shows it in place of the message", () => {
    const form = answered([
      ["show", " Hamilton "],
      ["seats", "2"],
    ]);
    expect(messageFrom(form)).toBe("show: Hamilton\nseats: 2");
    expect(shownFrom(form)).toBeUndefined();
    const only = answered([["show", "Hamilton"]]);
    expect(messageFrom(only)).toBe("show: Hamilton");
    expect(shownFrom(only)).toBeUndefined();
  });

  it("sends a field named text as a line beside the rest", () => {
    const form = answered([
      ["text", "A note"],
      ["seats", "2"],
    ]);
    expect(messageFrom(form)).toBe("text: A note\nseats: 2");
  });

  it("leaves out its own fields field, app and voice, and keeps an answer named fields", () => {
    const form = answered([
      ["app", "books"],
      ["voice", "1"],
      ["fields", "message"],
      ["crop", "wheat"],
    ]);
    expect(messageFrom(form)).toBe("fields: message\ncrop: wheat");
  });

  it("is not a form that only has a field named fields", () => {
    const form = new FormData();
    form.append("fields", "wheat");
    form.append("show", "Not sure");
    expect(messageFrom(form)).toBe("fields: wheat");
    expect(shownFrom(form)).toBe("Not sure");
  });
});
