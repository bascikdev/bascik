import { describe, it, expect } from "vitest";
import { escapeHtml } from "./escape-html.ts";

describe("escapeHtml", () => {
  it("escapes all 5 HTML metacharacters", () => {
    expect(escapeHtml(`& < > " '`)).toBe("&amp; &lt; &gt; &quot; &#39;");
  });

  it("escapes reflected XSS payload <script>alert(1)</script>", () => {
    const payload = `<script>alert("XSS")</script>`;
    expect(escapeHtml(payload)).toBe("&lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt;");
  });

  it("handles null and undefined by returning empty string", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });

  it("converts numbers and booleans to string safely", () => {
    expect(escapeHtml(123)).toBe("123");
    expect(escapeHtml(true)).toBe("true");
    expect(escapeHtml(false)).toBe("false");
  });

  it("leaves clean strings untouched", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });
});
