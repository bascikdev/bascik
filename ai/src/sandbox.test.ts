import { describe, expect, it } from "vitest";
import {
  sandboxFence,
  sandboxDocument,
  sandboxPrompt,
  SANDBOX_PROMPT,
} from "./sandbox.ts";

/** Reverses the four attribute escapes to decode an srcdoc value. */
function decodeSrcdoc(escaped: string): string {
  return escaped
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

describe("sandboxFence", () => {
  it('has exactly sandbox="allow-scripts" and never allow-same-origin', () => {
    const fence = sandboxFence();
    const html = fence("<p>Hi</p>")!;
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).not.toContain("allow-same-origin");
  });

  it("srcdoc decodes back to a document starting with <!doctype html> and containing the source verbatim after <body>", () => {
    const fence = sandboxFence();
    const source = "<p>Hello World</p>";
    const html = fence(source)!;
    const match = html.match(/srcdoc="([^"]*)"/);
    expect(match).not.toBeNull();
    const decoded = decodeSrcdoc(match![1]!);
    expect(decoded.startsWith("<!doctype html>")).toBe(true);
    expect(decoded).toContain(`<body>${source}</body>`);
  });

  it('srcdoc attribute value contains no raw ", <, or > even when the source contains dangerous characters', () => {
    const fence = sandboxFence();
    const source = '"><script>alert(1)</script>&quot;';
    const html = fence(source)!;
    const match = html.match(/srcdoc="([^"]*)"/);
    expect(match).not.toBeNull();
    const srcdocValue = match![1]!;
    expect(srcdocValue).not.toContain('"');
    expect(srcdocValue).not.toContain("<");
    expect(srcdocValue).not.toContain(">");
  });

  it("CSP meta has default-src 'none' and no connect-src", () => {
    const doc = sandboxDocument("<p>Test</p>");
    expect(doc).toContain("default-src 'none'");
    expect(doc).not.toContain("connect-src");
  });

  it("script origins appear in script-src and the prompt", () => {
    const origin = "https://cdn.jsdelivr.net";
    const doc = sandboxDocument("<p>Test</p>", [origin]);
    expect(doc).toContain(`script-src 'unsafe-inline' ${origin}`);
    const prompt = sandboxPrompt({ scripts: [origin] });
    expect(prompt).toContain(`Scripts may be loaded only from: ${origin}.`);
  });

  it.each([
    "http://cdn.example",
    "https://cdn.example/path",
    "https://cdn.example 'unsafe-eval'",
    "https://a.example;script-src *",
    "https://user:pw@cdn.example",
    "not a url",
  ])("throws TypeError for bad origin: %s", (badOrigin) => {
    expect(() => sandboxFence({ scripts: [badOrigin] })).toThrow(TypeError);
    expect(() => sandboxPrompt({ scripts: [badOrigin] })).toThrow(TypeError);
  });

  it("accepts a trailing slash origin and writes it without the slash", () => {
    const origin = "https://cdn.example/";
    const doc = sandboxDocument("<p>Test</p>", [origin]);
    expect(doc).toContain("https://cdn.example");
    expect(doc).not.toContain("https://cdn.example/");
  });

  it("returns null for empty source", () => {
    const fence = sandboxFence();
    expect(fence("")).toBeNull();
    expect(fence("   ")).toBeNull();
  });

  it("returns null for too-long source", () => {
    const fence = sandboxFence({ maxLength: 10 });
    expect(fence("a".repeat(11))).toBeNull();
    expect(fence("a".repeat(10))).not.toBeNull();
  });

  it("uses height and title options, and escapes the title", () => {
    const fence = sandboxFence({
      height: 500,
      title: 'Test "Title" <script>',
    });
    const html = fence("<p>Hi</p>")!;
    expect(html).toContain('height="500"');
    expect(html).toContain('title="Test &quot;Title&quot; &lt;script&gt;"');
  });

  it("SANDBOX_PROMPT says it cannot load scripts and names bascik.suggest", () => {
    expect(SANDBOX_PROMPT).toContain("cannot load scripts from anywhere");
    expect(SANDBOX_PROMPT).toContain("bascik.suggest");
  });

  it("gives each frame its own token, in the frame's attribute and its bridge", () => {
    const fence = sandboxFence();
    const tokenOf = (html: string): string =>
      /data-genui-sandbox="([0-9a-f]{24})"/.exec(html)![1]!;
    const first = fence("<p>One</p>")!;
    const second = fence("<p>One</p>")!;
    expect(tokenOf(first)).not.toBe(tokenOf(second));
    const doc = decodeSrcdoc(/srcdoc="([^"]*)"/.exec(first)![1]!);
    expect(doc).toContain(`token:"${tokenOf(first)}"`);
    // The token goes out once, with a private port, from the first script.
    expect(doc.indexOf("<script>")).toBeLessThan(doc.indexOf("<body>"));
    expect(doc).toContain("new MessageChannel()");
    expect(doc).toContain("document.currentScript.remove()");
  });

  it.each([
    "short",
    '"</script><script>alert(1)//abcdef',
    "a b c d e f g h i j",
  ])("refuses a token that is not a plain token: %s", (token) => {
    expect(() => sandboxDocument("<p>x</p>", [], token)).toThrow(TypeError);
  });
});
