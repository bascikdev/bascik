/**
 * hand-written-html-escaper (Collin 2026-10-31): agent-built sites kept
 * writing their own escapeHtml in build scripts and helpers instead of
 * using @bascik/bascik/html. The rule finds a function (or lookup object)
 * that turns & and < into entities, names it, and offers to make a
 * one-return escaper call esc(). Decoders, XML escapers that say so in a
 * comment, and helpers that only write &amp; are left alone.
 */
import { describe, expect, it } from "vitest";
import { findHandWrittenEscapers } from "./hand-written-escaper.js";

const names = (source: string) =>
  findHandWrittenEscapers(source).map((e) => e.name);

/** Each finding's name, kind, and the text its delegate fix would replace. */
const found = (source: string) =>
  findHandWrittenEscapers(source).map((e) => ({
    name: e.name,
    kind: e.kind,
    named: source.slice(e.start, e.end),
    body: e.delegate ? source.slice(e.delegate.start, e.delegate.end) : null,
    param: e.delegate?.param ?? null,
  }));

describe("hand-written-html-escaper: escapers", () => {
  it("a function declaration with a Prettier-wrapped replace chain and TypeScript types", () => {
    const source = `export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
`;
    const [e] = found(source);
    expect(e).toMatchObject({
      name: "escapeHtml",
      kind: "function",
      named: "escapeHtml",
      param: "value",
    });
    expect(e.body?.startsWith("{")).toBe(true);
    expect(e.body?.endsWith("}")).toBe(true);
  });

  it("an arrow with a replaceAll chain as its expression body", () => {
    const source = `export const esc = (s: string): string =>\n  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");\nexport const other = 1;\n`;
    expect(found(source)).toEqual([
      {
        name: "esc",
        kind: "function",
        named: "esc",
        body: `s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")`,
        param: "s",
      },
    ]);
  });

  it("a lookup object is named as the map, with no delegate fix", () => {
    const source = `const ENTITIES: Record<string, string> = {\n  "&": "&amp;",\n  "<": "&lt;",\n  ">": "&gt;",\n};\nexport const escape = (s: string) => s.replace(/[&<>]/g, (c) => ENTITIES[c]);\n`;
    expect(found(source)).toEqual([
      {
        name: "ENTITIES",
        kind: "map",
        named: "ENTITIES",
        body: null,
        param: null,
      },
    ]);
  });

  it("an inline map inside a replace callback names the outer function, not the callback", () => {
    const source = `function escapeHtml(s) {\n  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);\n}\n`;
    expect(names(source)).toEqual(["escapeHtml"]);
    expect(found(source)[0].param).toBe("s");
  });

  it("a switch over characters", () => {
    const source = `function esc(c) {\n  switch (c) {\n    case "&": return "&amp;";\n    case "<": return "&lt;";\n    default: return c;\n  }\n}\n`;
    expect(found(source)).toEqual([
      { name: "esc", kind: "function", named: "esc", body: null, param: null },
    ]);
  });

  it("a static method, an object property arrow and a function expression", () => {
    expect(
      names(
        `class Html { static escape(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;"); } }`,
      ),
    ).toEqual(["escape"]);
    expect(
      names(
        `export const h = { escape: (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;") };`,
      ),
    ).toEqual(["escape"]);
    expect(
      names(
        `const escapeHtml = function (s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;"); };`,
      ),
    ).toEqual(["escapeHtml"]);
  });

  it("pairs of [char, entity] are an escaper", () => {
    expect(
      names(
        `const PAIRS = [["&", "&amp;"], ["<", "&lt;"]];\nexport function esc(s) { let o = s; for (const [a, b] of PAIRS) o = o.replaceAll(a, b); return o; }`,
      ),
    ).toEqual(["PAIRS"]);
  });

  it("a hole-free template literal counts like a string", () => {
    expect(
      names(
        "export const esc = (s) => s.replace(/&/g, `&amp;`).replace(/</g, `&lt;`);",
      ),
    ).toEqual(["esc"]);
  });

  it("a quote inside a regex does not open a string that hides the entities", () => {
    expect(
      names(
        `export const esc = (s) => s.replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/&/g, "&amp;").replace(/</g, "&lt;");`,
      ),
    ).toEqual(["esc"]);
  });

  it("two escapers in one file are two findings", () => {
    expect(
      names(
        `export const a = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");\nexport function b(s) { return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;"); }\n`,
      ),
    ).toEqual(["a", "b"]);
  });
});

describe("hand-written-html-escaper: delegate fix only where the body is one return", () => {
  it("a body with a statement before the return gets no fix", () => {
    const [e] = findHandWrittenEscapers(
      `function escapeHtml(s) { const str = String(s ?? ""); return str.replace(/&/g, "&amp;").replace(/</g, "&lt;"); }`,
    );
    expect(e.name).toBe("escapeHtml");
    expect(e.delegate).toBeUndefined();
  });

  it("two parameters, a default value or a destructured parameter gets no fix", () => {
    for (const params of ["s, quote", 's = ""', "{ s }"]) {
      const [e] = findHandWrittenEscapers(
        `function escapeHtml(${params}) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;"); }`,
      );
      expect(e?.name, params).toBe("escapeHtml");
      expect(e?.delegate, params).toBeUndefined();
    }
  });

  it("an optional typed parameter keeps the fix", () => {
    const [e] = findHandWrittenEscapers(
      `export function escapeHtml(s?: string | null): string { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;"); }`,
    );
    expect(e.delegate?.param).toBe("s");
  });
});

describe("hand-written-html-escaper: not escapers", () => {
  it("a decoder: entities in regexes, as the first argument, as keys or first in a pair", () => {
    expect(
      names(
        `export const decode = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");`,
      ),
    ).toEqual([]);
    expect(
      names(
        `export const decode = (s) => s.replaceAll("&lt;", "<").replaceAll("&amp;", "&");`,
      ),
    ).toEqual([]);
    expect(
      names(
        `const DECODE = { "&lt;": "<", "&amp;": "&" };\nconst PAIRS = [["&lt;", "<"], ["&amp;", "&"]];`,
      ),
    ).toEqual([]);
  });

  it("an XML escaper with a comment that says so, above it or inside it", () => {
    expect(
      names(
        `// The RSS feed is XML, which html does not build, so it keeps this escaper.\nexport function escapeXml(s: string): string {\n  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;");\n}\n`,
      ),
    ).toEqual([]);
    expect(
      names(
        `export function escapeText(s) {\n  /* sitemap.xml text */\n  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;");\n}\n`,
      ),
    ).toEqual([]);
  });

  it("an XML-named escaper with no comment, or with a comment that is not about XML, is still reported", () => {
    expect(
      names(
        `export function escapeXml(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;"); }`,
      ),
    ).toEqual(["escapeXml"]);
    expect(
      names(
        `// Escapes text for the page.\nexport function escapeHtml(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;"); }`,
      ),
    ).toEqual(["escapeHtml"]);
  });

  it("a comment above an earlier statement does not cover a later escaper", () => {
    expect(
      names(
        `// Feed helpers for the RSS route.\nexport const FEED = "/feed.xml";\nexport function escapeHtml(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;"); }`,
      ),
    ).toEqual(["escapeHtml"]);
  });

  it("only &amp; (a URL helper) is not an escaper", () => {
    expect(names(`export const q = (u) => u.replace(/&/g, "&amp;");`)).toEqual(
      [],
    );
  });

  it("entities inside longer strings, markup text and holed templates", () => {
    expect(
      names(
        'export const note = () => "<p>&lt;b&gt; makes text bold &amp; strong</p>";\nexport const t = (x) => `&amp;${x}&lt;`;',
      ),
    ).toEqual([]);
  });

  it("entities in comments and in strings of other code are not read", () => {
    expect(
      names(
        `// s.replace(/&/g, "&amp;").replace(/</g, "&lt;")\nconst s = 'x.replace(/&/g, "&amp;").replace(/</g, "&lt;")';`,
      ),
    ).toEqual([]);
  });

  it("broken code (an unclosed function) does not throw", () => {
    expect(() =>
      findHandWrittenEscapers(
        `export function escapeHtml(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;"`,
      ),
    ).not.toThrow();
    expect(() => findHandWrittenEscapers("")).not.toThrow();
    expect(() => findHandWrittenEscapers("}}}) => {{ ")).not.toThrow();
  });
});

describe("review 2026-10-31: which comments make an escaper an XML one", () => {
  // Only a comment on its own line(s) right above the escaper's declaration,
  // or inside it, counts. A comment elsewhere in the statement or file that
  // mentions XML or SVG must not silence the rule.
  const ESC = `escapeHtml(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;"); }`;

  it("a trailing comment on the line above, after another statement, does not count", () => {
    expect(
      names(
        `export const feedUrl = "/feed.xml"; // link to the RSS feed\nexport function ${ESC}\n`,
      ),
    ).toEqual(["escapeHtml"]);
  });

  it("a comment after the escaper inside the same outer function does not count", () => {
    const source = `export default function () {
  function ${ESC}
  // Also renders the SVG logo below.
  const name = "Milk frother";
  return \`<p>\${escapeHtml(name)}</p>\`;
}
`;
    expect(names(source)).toEqual(["escapeHtml"]);
  });

  it("a comment on another member of a class or object does not count", () => {
    expect(
      names(
        `export class Sprite {\n  /** Renders the svg sprite. */\n  sprite() { return 1; }\n  ${ESC}\n}\n`,
      ),
    ).toEqual(["escapeHtml"]);
    expect(
      names(
        `export class Util {\n  // render svg icons\n  icon() { return 1; }\n  ${ESC}\n}\n`,
      ),
    ).toEqual(["escapeHtml"]);
    expect(
      names(
        `export default {\n  // svg helpers\n  icon: () => 1,\n  ${ESC},\n};\n`,
      ),
    ).toEqual(["escapeHtml"]);
  });

  it("a comment block right above the declaration counts, through export, const and a JSDoc block, and a member's own comment counts", () => {
    expect(
      names(
        `// Feed helpers.\n// RSS is XML, so the feed keeps this escaper.\nexport function ${ESC}\n`,
      ),
    ).toEqual([]);
    expect(
      names(
        `/**\n * Escapes sitemap text.\n */\nexport const escapeXml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");\n`,
      ),
    ).toEqual([]);
    expect(
      names(`export class Feed {\n  // RSS item text\n  ${ESC}\n}\n`),
    ).toEqual([]);
  });

  it("the XML escaper's name is still handed to the markup rule", () => {
    const xml: string[] = [];
    findHandWrittenEscapers(
      `// RSS is XML.\nfunction escapeXml(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;"); }\n`,
      xml,
    );
    expect(xml).toEqual(["escapeXml"]);
  });
});

describe("review 2026-10-31: the esc() fix only where it keeps behavior", () => {
  const delegate = (source: string) =>
    findHandWrittenEscapers(source)[0]?.delegate;

  it("a chain that also turns newlines into <br>, trims, or reads a property gets no fix", () => {
    expect(
      delegate(
        'function escapeHtml(s: string) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\\n/g, "<br>"); }',
      ),
    ).toBeUndefined();
    expect(
      delegate(
        'const escapeHtml = (s: string) => s.trim().replaceAll("&", "&amp;").replaceAll("<", "&lt;");',
      ),
    ).toBeUndefined();
    expect(
      delegate(
        'function escapeHtml(s) { return String(s.title).replace(/&/g, "&amp;").replace(/</g, "&lt;"); }',
      ),
    ).toBeUndefined();
    expect(
      delegate(
        'function escapeHtml(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").toUpperCase(); }',
      ),
    ).toBeUndefined();
    expect(
      delegate(
        'function escapeHtml(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;") + "!"; }',
      ),
    ).toBeUndefined();
  });

  it('the parameter, String(param), (param ?? "") and (param || "") with entity replacements keep the fix', () => {
    for (const receiver of [
      "s",
      "String(s)",
      '(s ?? "")',
      "(s || '')",
      'String(s ?? "")',
    ])
      expect(
        delegate(
          `function escapeHtml(s) { return ${receiver}.replace(/&/g, "&amp;").replace(/</g, "&lt;").replaceAll('"', "&quot;"); }`,
        )?.param,
        receiver,
      ).toBe("s");
  });
});

describe("review 2026-10-31: more escaper shapes", () => {
  it("split/join chains, a Map table, an IIFE-wrapped map and numeric entities are escapers", () => {
    expect(
      names(
        'export const escapeHtml = (s: string) => s.split("&").join("&amp;").split("<").join("&lt;");',
      ),
    ).toEqual(["escapeHtml"]);
    expect(
      found('const ENTITIES = new Map([["&", "&amp;"], ["<", "&lt;"]]);'),
    ).toMatchObject([{ name: "ENTITIES", kind: "map" }]);
    expect(
      found('const ENTITIES = (() => ({ "&": "&amp;", "<": "&lt;" }))();'),
    ).toMatchObject([{ name: "ENTITIES", kind: "map" }]);
    expect(
      names(
        'function escapeHtml(s) { return s.replace(/&/g, "&#38;").replace(/</g, "&#60;"); }\nfunction e2(s) { return s.replace(/&/g, "&#x26;").replace(/</g, "&#x3C;"); }',
      ),
    ).toEqual(["escapeHtml", "e2"]);
  });

  it("an unnamed default export function or arrow is reported as the default export", () => {
    for (const source of [
      'export default function (s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;"); }',
      'export default (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");',
    ]) {
      const [e] = findHandWrittenEscapers(source);
      expect(e?.defaultExport, source).toBe(true);
      expect(e?.delegate?.param, source).toBe("s");
    }
  });

  it("entity constants held for display are not an escaper", () => {
    expect(
      names(
        'export function pager(page) { const prev = "&lt;"; const amp = "&amp;"; return [prev, amp, page].join(" "); }',
      ),
    ).toEqual([]);
    expect(
      names('export const isEntity = (s) => s === "&amp;" || s === "&lt;";'),
    ).toEqual([]);
  });

  it("a character loop that appends entities is an escaper", () => {
    expect(
      names(
        'export function escapeHtml(s) { let out = ""; for (const c of s) { if (c === "&") out += "&amp;"; else if (c === "<") out += "&lt;"; else out += c; } return out; }',
      ),
    ).toEqual(["escapeHtml"]);
  });
});

describe("review round 2: a comment that names HTML too, and an XML-named escaper", () => {
  const ESC = `escapeText(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;"); }`;

  it.each([
    "// Escape for HTML (not XML)",
    "// Escape text for HTML pages and inline SVG icons",
    "// Not for XML: this escapes page text.",
    "// escape for html (not xml)",
  ])(
    "a comment that says the escaper is for HTML does not count: %s",
    (comment) => {
      expect(names(`${comment}\nexport function ${ESC}\n`)).toEqual([
        "escapeText",
      ]);
    },
  );

  it.each([
    "// The RSS feed is XML, which html does not build, so it keeps this escaper.",
    "// Sitemap text: html cannot build XML.",
    "// For the Atom feed, not HTML.",
    "// Escapes XML text for the RSS feed; html builds HTML, not XML.",
    "// for the rss feed, not html",
    "/* sitemap.xml text */",
  ])("a comment that says it is for XML still counts: %s", (comment) => {
    expect(names(`${comment}\nexport function ${ESC}\n`)).toEqual([]);
  });

  it("an XML-named escaper with no comment is still reported, and says it looks like an XML escaper", () => {
    const [escapeXml] = findHandWrittenEscapers(
      `export function escapeXml(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;"); }`,
    );
    expect(escapeXml.xmlName).toBe(true);
    const [svg] = findHandWrittenEscapers(
      `export const svgEscape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");`,
    );
    expect(svg.xmlName).toBe(true);
    const [plain] = findHandWrittenEscapers(`export function ${ESC}`);
    expect(plain.xmlName).toBeUndefined();
  });
});
