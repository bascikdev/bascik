/**
 * server-script-unescaped-markup (Collin 2026-10-28): in data-bascik-server
 * and data-bascik-stream scripts, an UNTAGGED template literal that looks
 * like markup and interpolates a value that is not a literal, a number, a
 * nested html value, or a call to html/raw/esc/safeUrl/json (as imported from
 * @bascik/bascik/html, or a project escaper listed in
 * diagnostics.escapeFunctions) is a warning on that hole. Inside html``
 * templates the sink rules become errors (html throws there) and the URL
 * sink is silenced (html checks URLs). esc() inside html`` is info
 * (html-escaped-twice). server-script-bascik-import allows exactly
 * @bascik/bascik/html.
 */
import { describe, expect, it } from "vitest";
import {
  analyzeServerScriptSource,
  type AnalyzeOptions,
} from "./server-script-rules.js";
import { growthOf } from "./linear-time.test.util.js";

const RULE = "server-script-unescaped-markup";
const IMPORT = `import { html, raw, esc, safeUrl, json } from "@bascik/bascik/html";\n`;

const analyze = (body: string, opts: Partial<AnalyzeOptions> = {}) =>
  analyzeServerScriptSource(body, {
    hasSrcAttribute: false,
    directive: "server",
    ...opts,
  } as AnalyzeOptions);

const unescaped = (body: string, opts: Partial<AnalyzeOptions> = {}) =>
  analyze(body, opts).filter((d) => d.code === RULE);

/** The source text each diagnostic covers. */
const covered = (body: string, opts: Partial<AnalyzeOptions> = {}) =>
  unescaped(body, opts).map((d) => body.slice(d.start, d.end));

/** A handler whose body returns `ret` after `const q = ...searchParams.get("q")`. */
const handler = (ret: string, before = ""): string =>
  `${before}export default function (request) {\n  const q = new URL(request.url).searchParams.get("q") ?? "";\n  return ${ret};\n}\n`;

describe("server-script-unescaped-markup: true positives", () => {
  it("a query parameter in text", () => {
    const body = handler("`<p>${q}</p>`");
    const diags = unescaped(body);
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("warning");
    expect(body.slice(diags[0].start, diags[0].end)).toBe("${q}");
    expect(diags[0].message).toBe(
      "This markup template (line 3) interpolates ${q} (hole 1) without html. Wrap the template in html`...` from @bascik/bascik/html, which escapes each value for where it lands.",
    );
  });

  it("a header in a data-bascik-prop-* attribute", () => {
    const body = `export default (request) => \`<user-card data-bascik-prop-name="\${request.headers.get("x-user")}"></user-card>\`;`;
    expect(covered(body)).toEqual(['${request.headers.get("x-user")}']);
  });

  it("a row field in href and in text: two holes reported with their numbers; no separate URL sink warning", () => {
    const body = `export default async () => {
  const rows = await load();
  return rows.map((row) => \`<a href="\${row.url}">\${row.title}</a>\`).join("");
};`;
    const diags = analyze(body);
    const markup = diags.filter((d) => d.code === RULE);
    expect(markup.map((d) => body.slice(d.start, d.end))).toEqual([
      "${row.url}",
      "${row.title}",
    ]);
    expect(markup[0].message).toContain("(hole 1)");
    expect(markup[1].message).toContain("(hole 2)");
    expect(diags.map((d) => d.code)).not.toContain(
      "server-script-sink-url-attribute",
    );
  });

  it("applies to stream scripts", () => {
    expect(covered(handler("`<p>${q}</p>`"), { directive: "stream" })).toEqual([
      "${q}",
    ]);
  });

  it("reports only the holes that are not exempt, numbered by position", () => {
    const body = handler(
      "`<p>${q}</p><p>${MAX}</p><p>${q.length}</p><p>${q.trim()}</p>`",
      "const MAX = 5;\n",
    );
    const diags = unescaped(body);
    expect(diags.map((d) => /\(hole (\d+)\)/.exec(d.message)?.[1])).toEqual([
      "1",
      "4",
    ]);
  });

  it("names the line the template starts on; the range is the hole on its own line", () => {
    const body = `export default (request) => {
  const q = request.headers.get("x") ?? "";
  return \`<section>
    <h2>Results</h2>
    <p>\${q}</p>
  </section>\`;
};`;
    const diags = unescaped(body);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("(line 3)");
    expect(body.slice(0, diags[0].start).split("\n").length).toBe(5);
  });

  it("lineOffset makes the line a file line (the script's body starts below the markup)", () => {
    const diags = unescaped(handler("`<p>${q}</p>`"), { lineOffset: 10 });
    expect(diags[0].message).toContain("(line 13)");
  });

  it("CRLF files count lines the same way", () => {
    const body = handler("`<p>${q}</p>`").replace(/\n/g, "\r\n");
    const diags = unescaped(body);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("(line 3)");
    expect(body.slice(diags[0].start, diags[0].end)).toBe("${q}");
  });

  it("an untagged template nested in a hole of an html template (it would show as escaped text)", () => {
    const body = handler(
      "html`<ul>${items.map((i) => `<li>${i.name}</li>`)}</ul>`",
      IMPORT,
    );
    expect(covered(body)).toEqual(["${i.name}"]);
  });

  it("an untagged template inside .map in a plain return", () => {
    const body = handler(
      '`<ul>${items.map((i) => `<li>${i.name}</li>`).join("")}</ul>`',
    );
    expect(covered(body)).toContain("${i.name}");
  });

  it("a local function named esc that was not imported from @bascik/bascik/html is not trusted", () => {
    const body = handler("`<p>${esc(q)}</p>`", "const esc = (s) => s;\n");
    expect(covered(body)).toEqual(["${esc(q)}"]);
  });

  it("a project escaper is not trusted until listed in escapeFunctions", () => {
    const body = handler(
      "`<p>${escapeHtml(q)}</p>`",
      `import { escapeHtml } from "@/lib/server.ts";\n`,
    );
    expect(covered(body)).toEqual(["${escapeHtml(q)}"]);
    expect(covered(body, { escapeFunctions: ["escapeHtml"] })).toEqual([]);
  });

  it("a const bound to a non-exempt value is not exempt", () => {
    const body = handler("`<p>${name}</p>`", "");
    const withBinding = body.replace(
      "  return",
      "  const name = q.toUpperCase();\n  return",
    );
    expect(covered(withBinding)).toEqual(["${name}"]);
  });
});

describe("server-script-unescaped-markup: the safe forms", () => {
  it.each([
    ["html``", "html`<p>${q}</p>`"],
    [
      "html with .map",
      "html`<ul>${items.map((i) => html`<li>${i}</li>`)}</ul>`",
    ],
    ["raw()", "`<article>${raw(body)}</article>`"],
    ["esc()", "`<p>${esc(q)}</p>`"],
    ["safeUrl()", '`<a href="${esc(safeUrl(q))}">x</a>`'],
    ["json()", '`<script type="application/json">${json({ q })}</script>`'],
    [
      "a conditional of html values",
      'html`<p>${q ? html`<b>${q}</b>` : ""}</p>`',
    ],
    [
      "a conditional in a plain template whose operands are exempt",
      '`<p>${q ? esc(q) : "none"}</p>`',
    ],
    ["&& with html", "`<div>${q && html`<b>${q}</b>`}</div>`"],
  ])("%s", (_name, ret) => {
    expect(covered(handler(ret, IMPORT))).toEqual([]);
  });

  it("aliased imports", () => {
    const body = handler(
      "`<p>${e(q)}</p>${h`<b>${q}</b>`}`",
      `import { esc as e, html as h } from "@bascik/bascik/html";\n`,
    );
    expect(covered(body)).toEqual([]);
  });

  it("a namespace import", () => {
    const body = handler(
      "`<p>${b.esc(q)}</p>${b.html`<i>${q}</i>`}`",
      `import * as b from "@bascik/bascik/html";\n`,
    );
    expect(covered(body)).toEqual([]);
  });

  it("const bindings to exempt values: const safe = esc(x); const cards = items.map(i => html`...`)", () => {
    const body = handler("`<p>${safe}</p><ul>${cards}</ul>`", IMPORT).replace(
      "  return",
      "  const safe = esc(q);\n  const cards = items.map((i) => html`<li>${i}</li>`);\n  return",
    );
    expect(covered(body)).toEqual([]);
  });
});

describe("server-script-unescaped-markup: false-positive traps", () => {
  it.each([
    ["x.length", "`<p>${items.length}</p>`"],
    ["x.size", "`<p>${set.size}</p>`"],
    ["i + 1", "`<li>${i + 1}</li>`"],
    ["arithmetic", "`<p>${(a * 2) / b - 1}</p>`"],
    ["toFixed", "`<p>${price.toFixed(2)}</p>`"],
    ["Number()", "`<p>${Number(q)}</p>`"],
    ["parseInt()", "`<p>${parseInt(q, 10)}</p>`"],
    ["Math.*()", "`<p>${Math.round(q)}</p>`"],
    ["string literal", '`<p>${"x"}</p>`'],
    ["number literal", "`<p>${42}</p>`"],
    ["boolean and null", "`<p>${true}${null}</p>`"],
    ["hole-free template", "`<p>${`fixed`}</p>`"],
    ["URL template", "`https://api.example.com/items/${q}`"],
    ["SQL with <", "`SELECT * FROM t WHERE a < ${q}`"],
    ["JSON text", '`{"q": ${JSON.stringify(q)}}`'],
    ["plain sentence", "`Hello, ${q}!`"],
  ])("%s", (_name, ret) => {
    expect(covered(handler(ret))).toEqual([]);
  });

  it("ALL_CAPS and literal consts", () => {
    const body = handler(
      "`<p>${MAX}</p><p>${LABEL}</p><p>${count}</p>`",
      `const MAX = 5;\nconst LABEL = "Hi";\nconst count = 3;\n`,
    );
    expect(covered(body)).toEqual([]);
  });

  it("a tagged template (sql``, css``, any tag) is skipped", () => {
    const body = handler("sql`SELECT <b> FROM t WHERE a = ${q}`");
    expect(covered(body)).toEqual([]);
    expect(covered(handler("db.sql`<p>${q}</p>`"))).toEqual([]);
  });

  it("console.*(), new *Error() and throw arguments are skipped", () => {
    for (const statement of [
      "console.log(`<p>${q}</p>`)",
      "console.error(`<x-card> failed for ${q}`)",
      "new Error(`<x> ${q}`)",
      "new TypeError(`<x> ${q}`)",
    ])
      expect(covered(handler(statement)), statement).toEqual([]);
    expect(
      covered(
        `export default (request) => { const q = request.url; throw \`<x> \${q}\`; };`,
      ),
    ).toEqual([]);
  });

  it("templates inside comments and strings are not templates", () => {
    const body = `export default (request) => {
  const q = request.url;
  // return \`<p>\${q}</p>\`;
  /* return \`<p>\${q}</p>\`; */
  const s = "\`<p>\${q}</p>\`";
  return s;
};`;
    expect(covered(body)).toEqual([]);
  });

  it("build and routes scripts are out of scope", () => {
    for (const directive of ["build", "routes"] as const)
      expect(covered(handler("`<p>${q}</p>`"), { directive })).toEqual([]);
  });

  it("a script with src= is out of scope", () => {
    expect(
      covered(handler("`<p>${q}</p>`"), { hasSrcAttribute: true }),
    ).toEqual([]);
  });
});

describe("server-script-unescaped-markup: overlaps with the sink rules", () => {
  it("suppresses the sink-text-unescaped info on a hole it reports", () => {
    const body = `export default (request) => \`<p>\${request.headers.get("x")}</p>\`;`;
    const codes = analyze(body).map((d) => d.code);
    expect(codes).toContain(RULE);
    expect(codes).not.toContain("server-script-sink-text-unescaped");
  });

  it.each([
    [
      "server-script-sink-event-handler",
      'html`<button onclick="${q}">go</button>`',
      "html`...` throws here: an event handler's value is JavaScript. Put the value in a data-* attribute and read it from a component script.",
    ],
    ["server-script-sink-inline-script", "html`<script>${q}</script>`", null],
    ["server-script-sink-style", 'html`<div style="${q}"></div>`', null],
    [
      "server-script-sink-unquoted-attribute",
      "html`<a class=${q}>x</a>`",
      null,
    ],
  ])(
    "inside html``, %s is an error saying html throws there",
    (code, ret, message) => {
      const diags = analyze(handler(ret, IMPORT)).filter(
        (d) => d.code === code,
      );
      expect(diags).toHaveLength(1);
      expect(diags[0].severity).toBe("error");
      expect(diags[0].message).toMatch(/^html`\.\.\.` throws here: /);
      if (message) expect(diags[0].message).toBe(message);
    },
  );

  it("inside html``, a URL attribute hole is not reported (html checks URLs)", () => {
    const codes = analyze(handler('html`<a href="${q}">x</a>`', IMPORT)).map(
      (d) => d.code,
    );
    expect(codes).not.toContain("server-script-sink-url-attribute");
    expect(codes).not.toContain(RULE);
  });

  it("a hole where html would throw keeps its sink warning in a plain template and is not also unescaped-markup", () => {
    const diags = analyze(handler('`<button onclick="${q}">go</button>`'));
    const onHole = diags.filter(
      (d) => d.code !== "server-script-missing-default-export",
    );
    expect(onHole.map((d) => d.code)).toEqual([
      "server-script-sink-event-handler",
    ]);
  });

  it("the plain-template URL sink message points to safeUrl and html, not to new URL allow-listing", () => {
    const diags = analyze(handler('`href="${q}"`')).filter(
      (d) => d.code === "server-script-sink-url-attribute",
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("safeUrl");
    expect(diags[0].message).toContain("html`");
    expect(diags[0].message).not.toContain("new URL(value, base)");
  });

  it("esc() inside html`` is html-escaped-twice info", () => {
    const body = handler("html`<p>${esc(q)}</p>`", IMPORT);
    const diags = analyze(body).filter((d) => d.code === "html-escaped-twice");
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("info");
    expect(body.slice(diags[0].start, diags[0].end)).toBe("${esc(q)}");
    expect(diags[0].message).toBe(
      "esc() inside html`...` escapes twice, so the page shows &amp;lt;. Pass the value as it is: html escapes it.",
    );
  });

  it("esc() in a plain template is not html-escaped-twice", () => {
    expect(
      analyze(handler("`<p>${esc(q)}</p>`", IMPORT)).map((d) => d.code),
    ).not.toContain("html-escaped-twice");
  });
});

describe("server-script-bascik-import allows exactly @bascik/bascik/html", () => {
  const importCodes = (specifier: string) =>
    analyze(`import x from "${specifier}";\nexport default () => "";`).filter(
      (d) => d.code === "server-script-bascik-import",
    );

  it("@bascik/bascik/html is allowed", () => {
    expect(importCodes("@bascik/bascik/html")).toEqual([]);
  });

  it.each([
    "@bascik/bascik",
    "@bascik/bascik/runtime",
    "@bascik/bascik/config",
    "@bascik/bascik/html/extra",
    "@bascik/bascik/HTML",
  ])("%s is still an error, pointing to the html module", (specifier) => {
    const diags = importCodes(specifier);
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toBe(
      "Only @bascik/bascik/html is meant for server and stream scripts. The rest of @bascik/bascik is build tooling.",
    );
  });
});

describe("server-script-unescaped-markup: linear time", () => {
  // Tick-aware CPU-time growth: see linear-time.test.util.ts.
  const growthOfBodies = (small: string, large: string): number =>
    growthOf(
      () => analyze(small),
      () => analyze(large),
    );

  it("a 10k-line script of markup templates lints in linear time (CPU growth under 8x for 4x the lines)", () => {
    const line = (i: number) =>
      `  out += \`<li data-i="\${i}">\${rows[${i}].name} \${esc(rows[${i}].x)}</li>\`;\n`;
    const script = (lines: number) =>
      `${IMPORT}export default () => {\n  let out = "";\n${Array.from({ length: lines }, (_, i) => line(i)).join("")}  return out;\n};\n`;
    const small = script(2_500);
    const large = script(10_000);
    const diags = analyze(large).filter((d) => d.code === RULE);
    expect(diags).toHaveLength(10_000 * 2);
    expect(growthOfBodies(small, large)).toBeLessThan(8);
  }, 60_000);

  it("an import specifier with a long run of tabs reads in linear time (CPU growth under 8x for 4x the tabs)", () => {
    // `{ html<tabs>x }`: splitting the specifier on /\s+as\s+/ retried the
    // tab run from every tab, so typing in a large import froze the editor.
    const script = (tabs: number) =>
      `import { html${"\t".repeat(tabs)}x } from "@bascik/bascik/html";\nexport default () => \`<p>\${q}</p>\`;\n`;
    const small = script(5_000);
    const large = script(20_000);
    expect(covered(large)).toEqual(["${q}"]);
    expect(growthOfBodies(small, large)).toBeLessThan(8);
  }, 60_000);
});

describe("server-script-unescaped-markup: import names that are not identifiers", () => {
  it.each(["h(", "h\\", "h[", "h+", "h)"])(
    "a half-typed local name %s is not a tag and does not throw",
    (local) => {
      const body = `import { html as ${local} } from "@bascik/bascik/html";\nexport default () => \`<p>\${items.map((i) => ${local}\`<b>\${i}</b>\`)}</p>\`;\n`;
      expect(() => analyze(body)).not.toThrow();
      expect(covered(body).length).toBeGreaterThan(0);
    },
  );

  it("an identifier alias still tags", () => {
    const body = `import { html as h } from "@bascik/bascik/html";\nexport default () => \`<p>\${items.map((i) => h\`<b>\${i}</b>\`)}</p>\`;\n`;
    expect(covered(body)).toEqual([]);
  });
});

describe("non-markup templates (SQL, URLs, plain text) get no sink warnings", () => {
  it.each([
    "context.env.DB.prepare(`SELECT name FROM items WHERE id = ${Number(id)}`)",
    "`SELECT * FROM items WHERE id = ${id} AND x < 3`",
    '`UPDATE items SET name = ${request.headers.get("x")} WHERE id = 1`',
    "sql`SELECT * FROM items WHERE id = ${id}`",
  ])("%s", (expr) => {
    const body = `export default async (request, context) => {\n  const id = new URL(request.url).searchParams.get("id");\n  return ${expr};\n};\n`;
    expect(analyze(body).map((d) => d.code)).toEqual([]);
  });

  it("an unquoted attribute in a markup template keeps its sink warning", () => {
    expect(
      analyze(handler("`<a class=${q}>x</a>`")).map((d) => d.code),
    ).toEqual(["server-script-sink-unquoted-attribute"]);
  });
});

describe("hand-escaped holes: no quick fix that would escape twice", () => {
  it("a call to a local escaper is reported with a note, and the template is not fixable", () => {
    const body = handler(
      "`<h2>${escape(q)}</h2>`",
      "const escape = (s) => String(s).replace(/[&<>\"']/g, (c) => `&#${c.charCodeAt(0)};`);\n",
    );
    const diags = unescaped(body);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toBe(
      "This markup template (line 4) interpolates ${escape(q)} (hole 1) without html. escape() looks like a hand-written escaper, and html escapes too, so wrapping this template in html would show &amp;lt; on the page. Wrap it in html`...` and pass the value as it is: ${q}. If escape() is a trusted escaper, list it in diagnostics.escapeFunctions.",
    );
    expect(diags[0].template?.fixable).toBe(false);
  });

  it.each([
    "escapeHtml(q)",
    "sanitize(q)",
    "encodeEntities(q)",
    "utils.escape(q)",
  ])("%s also blocks the quick fix", (expr) => {
    const diags = unescaped(handler(`\`<p>\${${expr}}</p>\``));
    expect(diags).toHaveLength(1);
    expect(diags[0].template?.fixable).toBe(false);
  });

  it("an ordinary call (q.trim(), format(q)) keeps the quick fix", () => {
    const diags = unescaped(handler("`<p>${format(q)}</p>`"));
    expect(diags).toHaveLength(1);
    expect(diags[0].template?.fixable).toBe(true);
  });
});

describe("html-joined-string: a .join() of html values inside html", () => {
  const JOIN = "html-joined-string";

  it('an inline .map(...).join("") in an html hole', () => {
    const body = handler(
      'html`<ul>${rows.map((p) => html`<li>${p.name}</li>`).join("")}</ul>`',
      IMPORT + "const rows = [];\n",
    );
    const diags = analyze(body).filter((d) => d.code === JOIN);
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toBe(
      'This hole joins its items into one string, which html escapes, so the page shows &lt;li&gt; as text. Pass the array without .join(""): html inserts each html`...` item as it is.',
    );
  });

  it("a name bound to a .join() over several lines", () => {
    const body = handler(
      "html`<ul>${cards}</ul>`",
      IMPORT +
        'const rows = [];\nconst cards = rows\n  .map((p) => html`<li>${p.name}</li>`)\n  .join("");\n',
    );
    expect(analyze(body).map((d) => d.code)).toContain(JOIN);
  });

  it("a plain template around a joined name is not fixable (the fix would escape the joined markup)", () => {
    const body = handler(
      "`<ul>${cards}</ul>`",
      'const rows = [];\nconst cards = rows.map((p) => `<li>${p.name}</li>`).join("");\n',
    );
    const outer = unescaped(body).find(
      (d) => body.slice(d.start, d.end) === "${cards}",
    );
    expect(outer?.template?.fixable).toBe(false);
  });

  it("an array passed as it is, and a join of plain words, are fine", () => {
    expect(
      analyze(
        handler(
          'html`<ul>${rows.map((p) => html`<li>${p}</li>`)}</ul><p class="${tags.join(" ")}"></p>`',
          IMPORT + "const rows = [];\nconst tags = [];\n",
        ),
      ).map((d) => d.code),
    ).not.toContain(JOIN);
  });
});

describe("string concatenation in a hole", () => {
  const before =
    'const first = new URL(request.url).searchParams.get("first") ?? "";\n';
  const inHandler = (ret: string, extra = ""): string =>
    `export default function (request) {\n  ${before}  const last = new URL(request.url).searchParams.get("last") ?? "";\n  const name = first;\n${extra}  return ${ret};\n}\n`;

  it("${first + last} is reported (two request values joined)", () => {
    expect(covered(inHandler("`<p>Hello ${first + last}</p>`"))).toEqual([
      "${first + last}",
    ]);
  });

  it('${name + ": $" + price.toFixed(2)} is reported (toFixed only exempts a lone operand)', () => {
    expect(
      covered(inHandler('`<li>${name + ": $" + price.toFixed(2)}</li>`')),
    ).toEqual(['${name + ": $" + price.toFixed(2)}']);
  });

  it('${"<b>" + q} and ${q + "!"} are reported', () => {
    expect(covered(handler('`<p>${"<b>" + q}</p><p>${q + "!"}</p>`'))).toEqual([
      '${"<b>" + q}',
      '${q + "!"}',
    ]);
  });

  it("${Number(x) || name} is reported (Number() exempts only a whole call)", () => {
    expect(covered(inHandler("`<p>${Number(first) || name}</p>`"))).toEqual([
      "${Number(first) || name}",
    ]);
  });

  it("${q + 1} is reported when q is bound to request data", () => {
    expect(covered(handler("`<p>${q + 1}</p>`"))).toEqual(["${q + 1}"]);
  });

  it.each([
    ["i + 1", "`<li>${i + 1}</li>`"],
    ["count + 1 with const count = 3", "`<p>${count + 1}</p>`"],
    ["price.toFixed(2) + a literal", '`<p>${price.toFixed(2) + " USD"}</p>`'],
    ["Number() + Number()", "`<p>${Number(a) + Number(b)}</p>`"],
    ["items.length + 1", "`<p>${items.length + 1}</p>`"],
    ["a * 2 - b", "`<p>${a * 2 - b}</p>`"],
    ["Math.max(a, b) * 2", "`<p>${Math.max(a, b) * 2}</p>`"],
    ["unary minus", "`<p>${-a}</p>`"],
    ["literal + esc()", '`<p>${"Hi " + esc(q)}</p>`'],
  ])("%s stays exempt", (_name, ret) => {
    expect(covered(handler(ret, `${IMPORT}const count = 3;\n`))).toEqual([]);
  });
});

describe("let and var reassigned after their declaration", () => {
  it("a let reassigned from request data is reported", () => {
    const body = `export default function (request) {
  let label = "everyone";
  const q = new URL(request.url).searchParams.get("q");
  if (q) label = q;
  return \`<p>Hello \${label}</p>\`;
}`;
    expect(covered(body)).toEqual(["${label}"]);
  });

  it("a var extended with += from request data is reported", () => {
    const body = `export default function (request) {
  var label = "Hi ";
  label += request.headers.get("x-name");
  return \`<p>\${label}</p>\`;
}`;
    expect(covered(body)).toEqual(["${label}"]);
  });

  it("a let reassigned only to exempt values stays exempt", () => {
    const body = `export default function (request) {
  let count = 0;
  count = 5;
  count += 1;
  return \`<p>\${count}</p>\`;
}`;
    expect(covered(body)).toEqual([]);
  });

  it("a property assignment (obj.label = q) does not rebind label", () => {
    const body = `export default function (request) {
  const label = "everyone";
  const obj = {};
  obj.label = new URL(request.url).searchParams.get("q");
  return \`<p>Hello \${label}</p>\`;
}`;
    expect(covered(body)).toEqual([]);
  });
});

describe("String.raw and other plain string tags", () => {
  it("String.raw`...` is checked like an untagged template, without a quick fix", () => {
    const diags = unescaped(handler("String.raw`<p>Hello ${q}</p>`"));
    expect(diags.map((d) => d.code)).toEqual([RULE]);
    expect(diags[0].template?.fixable).toBe(false);
  });

  it.each(["dedent", "outdent", "stripIndent", "oneLine"])(
    "%s`...` is checked (common-tags style tags join their values as they are)",
    (tag) => {
      const diags = unescaped(handler(`${tag}\`<p>Hello \${q}</p>\``));
      expect(diags.map((d) => d.code)).toEqual([RULE]);
      expect(diags[0].template?.fixable).toBe(false);
    },
  );

  it("other tags (sql, css, a project's own tag) stay skipped", () => {
    expect(covered(handler("myTag`<p>${q}</p>`"))).toEqual([]);
  });
});

describe("no quick fix where html would throw", () => {
  it.each([
    ["a tag name", "`<h${level}>${q}</h${level}>`"],
    ["an end tag name", "`<p>${q}</${tag}>`"],
    ["an HTML comment", "`<!-- query: ${q} --><p>${q}</p>`"],
    ["a <!...> declaration", "`<!${q}><p>${q}</p>`"],
    ["an attribute name", "`<p ${attrs}>${q}</p>`"],
    ["after a quoted attribute", '`<p class="a"${attrs}>${q}</p>`'],
    ["srcdoc", '`<iframe srcdoc="${doc}"></iframe><p>${q}</p>`'],
    [
      "a meta http-equiv content",
      '`<meta http-equiv="refresh" content="${wait}"><p>${q}</p>`',
    ],
    [
      "an SVG animation attribute",
      '`<svg><set attributeName="${a}"/></svg><p>${q}</p>`',
    ],
    ["a template that ends inside a tag", '`<p>${q}</p><a href="x"`'],
    ["a template that ends inside a quoted value", '`<p>${q}</p><a title="`'],
  ])("%s", (_name, ret) => {
    const diags = unescaped(
      handler(ret, 'const level = 2;\nconst tag = "p";\n'),
    );
    expect(diags.length).toBeGreaterThan(0);
    for (const d of diags) expect(d.template?.fixable).toBe(false);
  });

  it.each([
    ["text and quoted attributes", '`<p class="x ${q}">${q}</p>`'],
    [
      "< inside a <script> string is not a tag",
      "`<p>${q}</p><style>a{}</style><textarea><b </textarea>`",
    ],
    ["a closed comment before the hole", "`<!-- note --><p>${q}</p>`"],
  ])("%s keeps the quick fix", (_name, ret) => {
    const diags = unescaped(handler(ret));
    expect(diags.length).toBeGreaterThan(0);
    for (const d of diags) expect(d.template?.fixable).toBe(true);
  });
});
