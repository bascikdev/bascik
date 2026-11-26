import { describe, expect, it } from "vitest";
import { field, localPath, messageFrom, readForm } from "./forms.ts";

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
