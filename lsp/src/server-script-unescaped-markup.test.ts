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
import { scanJavaScript } from "./module-specifiers.js";
import { findTemplateLiterals } from "./server-script-templates.js";

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

  it("build and routes scripts and Node modules are in scope (Collin 2026-10-31: every agent-built site hand-built markup in build scripts)", () => {
    for (const directive of ["build", "routes", "module"] as const)
      expect(
        covered(handler("`<p>${q}</p>`"), { directive }),
        directive,
      ).toEqual(["${q}"]);
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

  it("a string method on request data (q.trim()) keeps the quick fix; a global function this file cannot see (format(q)) withholds it", () => {
    const trimmed = unescaped(handler("`<p>${q.trim()}</p>`"));
    expect(trimmed).toHaveLength(1);
    expect(trimmed[0].template?.fixable).toBe(true);
    const formatted = unescaped(handler("`<p>${format(q)}</p>`"));
    expect(formatted).toHaveLength(1);
    expect(formatted[0].template?.fixable).toBe(false);
    expect(formatted[0].message).toContain("format");
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

describe("no quick fix where html's URL scheme rule throws (review 2026-11-01)", () => {
  // html refuses a URL attribute whose first hole starts the URL and is
  // followed by another hole, or by text with : or & before the first /, ?
  // or #, and one whose template text before the first hole could be
  // continued into a scheme, or is a script scheme. The fixed page would
  // throw on every request (u01-u04, q10).
  const before = 'const path = "/about/";\nconst port = 8080;\n';
  it.each([
    ["two holes start the URL (u01)", '`<a href="${q}${path}">About</a>`'],
    ["two holes start an img src (u04)", '`<img alt="" src="${q}${path}">`'],
    ["a hole then :// (u02)", '`<a href="${q}://${path}">Home</a>`'],
    ["a hole then :port (u03)", '`<a href="${q}:${port}/">Local</a>`'],
    ["a hole then & before any /", '`<a href="${q}&amp;x=1">x</a>`'],
    ["a hole then text and a hole", '`<a href="${q}.test${path}">x</a>`'],
    [
      "env base and request path (q10)",
      '`<link rel="alternate" href="${process.env.SITE_URL}${new URL(request.url).pathname}">`',
    ],
    ["text that could continue a scheme", '`<a href="java${q}">x</a>`'],
    ["a javascript: URL", '`<a href="javascript:${q}">x</a>`'],
    ["a data: URL outside an image", '`<a href="data:text/html,${q}">x</a>`'],
    ["a srcset entry split from its scheme", '`<img srcset="x${q} 2x">`'],
    ["a ping URL split from its scheme", '`<a ping="java${q}" href="/">x</a>`'],
    ["upper-case HREF", '`<a HREF="${q}${path}">x</a>`'],
    ["single quotes", "`<a href='${q}${path}'>x</a>`"],
  ])("%s", (_name, ret) => {
    const diags = unescaped(handler(ret, before));
    expect(diags.length).toBeGreaterThan(0);
    for (const d of diags) {
      expect(d.template?.fixable).toBe(false);
      expect(d.message).toContain("sits where html throws");
      expect(d.message).not.toContain("Wrap the template");
    }
  });

  it.each([
    ["one hole as the whole URL", '`<a href="${q}">x</a>`'],
    ["a hole then a path", '`<a href="${q}/about/">x</a>`'],
    ["a hole then a query", '`<a href="${q}?x=1&amp;y=${q}">x</a>`'],
    ["a hole then a fragment", '`<a href="${q}#top">x</a>`'],
    ["a hole then text with no : or &", '`<a href="${q}.html">x</a>`'],
    ["a path before the holes", '`<a href="/p/${q}${q}">x</a>`'],
    ["a scheme and host first", '`<a href="https://milk.test/${q}${q}">x</a>`'],
    ["a mailto: URL", '`<a href="mailto:${q}@${q}">x</a>`'],
    [
      "a data: image in img src",
      '`<img alt="" src="data:image/png;base64,${q}">`',
    ],
    ["two holes in a title", '`<a title="${q}${q}" href="/">x</a>`'],
    ["a srcset with a path", '`<img alt="" srcset="/a/${q} 1x, /b/${q} 2x">`'],
  ])("%s keeps the quick fix", (_name, ret) => {
    const diags = unescaped(handler(ret));
    expect(diags.length).toBeGreaterThan(0);
    for (const d of diags) expect(d.template?.fixable).toBe(true);
  });

  it("the u01 module case: an env base and a const path get esc() advice and no fix", () => {
    const body =
      'const path = "/about/";\nexport function f() { return `<a href="${process.env.SITE_URL}${path}">About</a>`; }\n';
    const diags = unescaped(body, { directive: "module" });
    expect(diags.length).toBeGreaterThan(0);
    for (const d of diags) {
      expect(d.template?.fixable).toBe(false);
      expect(d.message).toContain("hole 1 sits where html throws");
    }
  });
});

describe("server-script-unescaped-markup: build-time code (build, routes, module)", () => {
  const build = (
    body: string,
    directive: "build" | "routes" | "module" = "build",
  ) => analyze(body, { directive });
  const codes = (body: string, directive?: "build" | "routes" | "module") =>
    build(body, directive).map((d) => d.code);

  it("a Prettier-wrapped build script returning plain template markup: one warning per hole, no fix for loaded data", () => {
    const body = `export default async function () {
  const posts = await loadPosts();
  return posts
    .map(
      (post) => \`
        <article>
          <h2>\${post.title}</h2>
          <p>\${post.summary}</p>
        </article>
      \`,
    )
    .join("");
}
`;
    const diags = build(body).filter((d) => d.code === RULE);
    expect(diags.map((d) => body.slice(d.start, d.end))).toEqual([
      "${post.title}",
      "${post.summary}",
    ]);
    // post comes from loadPosts(), which this file cannot see into.
    expect(diags.every((d) => d.template?.fixable === false)).toBe(true);
  });

  it("a module exporting a helper that returns markup", () => {
    const body = `export const card = (name: string): string =>\n  \`<li class="card">\${name}</li>\`;\n`;
    expect(covered(body, { directive: "module" })).toEqual(["${name}"]);
  });

  it("a module needs no default export, and gets no server import rule", () => {
    const body = `import { readFile } from "@bascik/bascik/build-helpers";\nexport const x = 1;\n`;
    expect(codes(body, "module")).toEqual([]);
    expect(codes(body, "build")).not.toContain("server-script-bascik-import");
  });

  it("html-tagged templates keep their errors at build time: html throws there too and fails the build", () => {
    const body = `${IMPORT}export default () => html\`<button onclick="\${go}">Froth</button>\`;`;
    expect(codes(body)).toContain("server-script-sink-event-handler");
    expect(
      build(body).find((d) => d.code === "server-script-sink-event-handler")
        ?.severity,
    ).toBe("error");
  });

  it("esc() inside html and a joined html array are still reported", () => {
    const body = `${IMPORT}export default (items) => html\`<p>\${esc(name)}</p><ul>\${items.map((i) => html\`<li>\${i}</li>\`).join("")}</ul>\`;`;
    expect(codes(body, "module")).toEqual(
      expect.arrayContaining(["html-escaped-twice", "html-joined-string"]),
    );
  });

  it("an unquoted attribute or a <script> body still warns, unless the value is exempt", () => {
    expect(
      codes("export default () => `<p class=${cls}>Milk frother</p>`;"),
    ).toEqual(["server-script-sink-unquoted-attribute"]);
    expect(
      codes(
        'export default () => `<script type="application/ld+json">${JSON.stringify(data)}</script>`;',
      ),
    ).toEqual(["server-script-sink-inline-script"]);
    expect(
      codes('export default () => `<p class=${"wide"}>Milk frother</p>`;'),
    ).toEqual([]);
  });

  it("an event handler or style value from data is the site's own at build time: no warning and no fix", () => {
    const body =
      'export default () => `<p style="--fill: ${pct}%" onclick="pick(${id})">${name}</p>`;';
    const diags = build(body);
    expect(diags.map((d) => d.code)).toEqual([RULE]);
    expect(diags[0].template?.fixable).toBe(false);
    // The same template in a server script warns on both sinks.
    expect(analyze(body).map((d) => d.code)).toEqual(
      expect.arrayContaining([
        "server-script-sink-style",
        "server-script-sink-event-handler",
      ]),
    );
  });

  it("no URL-attribute warning for a checked-looking value, and no request-value hint, at build time", () => {
    expect(codes('export default () => `<a href="${HOME}">Home</a>`;')).toEqual(
      [],
    );
    expect(
      codes(
        'export default (request) => `<p>${request.headers.get("x")}</p>`;',
        "build",
      ),
    ).toEqual([RULE]);
  });

  it("SQL, URLs and messages in build code are not markup", () => {
    expect(
      codes(
        "export default async () => { const rows = await db.query(`SELECT * FROM posts WHERE id = ${id}`); console.log(`<p>${rows.length}</p>`); throw new Error(`<b>${id}</b>`); };",
      ),
    ).toEqual([]);
  });

  it("other tagged templates are skipped; String.raw is checked with no fix", () => {
    expect(codes("export default () => css`<p>${x}</p>`;")).toEqual([]);
    const raw = build("export default () => String.raw`<p>${x}</p>`;").filter(
      (d) => d.code === RULE,
    );
    expect(raw).toHaveLength(1);
    expect(raw[0].template?.fixable).toBe(false);
  });

  it("an escaped backtick and a regex replacement token in the template text do not end or confuse it", () => {
    const body =
      "export default () => `<p>Use \\`$1\\` and $& here: ${name}</p>`;";
    expect(covered(body, { directive: "build" })).toEqual(["${name}"]);
  });

  it("a nested template inside a hole is checked on its own", () => {
    const body =
      'export default (rows) => `<ul>${rows.map((r) => `<li>${r.name}</li>`).join("")}</ul>`;';
    const diags = build(body).filter((d) => d.code === RULE);
    expect(diags.map((d) => body.slice(d.start, d.end))).toEqual([
      '${rows.map((r) => `<li>${r.name}</li>`).join("")}',
      "${r.name}",
    ]);
    // Wrapping the outer one would escape the joined string: no fix there.
    // The inner one reads a callback's parameter: no fix either.
    expect(diags[0].template?.fixable).toBe(false);
    expect(diags[1].template?.fixable).toBe(false);
  });

  it("a src= build script's inline body is out of scope (its file is checked as a module)", () => {
    expect(
      covered(handler("`<p>${q}</p>`"), {
        directive: "build",
        hasSrcAttribute: true,
      }),
    ).toEqual([]);
  });
});

describe("hand-written-html-escaper in scripts", () => {
  const ESCAPER = `function escapeHtml(s) {\n  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");\n}\n`;

  it.each(["server", "stream", "build", "routes", "module"] as const)(
    "is a warning on the name in a %s script, with the delegate range",
    (directive) => {
      const body = `${ESCAPER}export default () => "";\n`;
      const diags = analyze(body, { directive }).filter(
        (d) => d.code === "hand-written-html-escaper",
      );
      expect(diags).toHaveLength(1);
      expect(diags[0].severity).toBe("warning");
      expect(body.slice(diags[0].start, diags[0].end)).toBe("escapeHtml");
      expect(diags[0].message).toBe(
        "escapeHtml() is a hand-written HTML escaper: it turns & and < into entities. Build markup with html`...` from @bascik/bascik/html, which escapes each value for where it lands, or call esc() from the same module for a plain string. If it escapes XML on purpose, say so in a comment above it.",
      );
      expect(diags[0].escaper?.param).toBe("s");
    },
  );

  it("an unnamed default export is named as the default export", () => {
    const body =
      'export default function (s: string) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;"); }\n';
    const [d] = analyze(body, { directive: "module" });
    expect(d.code).toBe("hand-written-html-escaper");
    expect(
      d.message.startsWith("The default export is a hand-written HTML escaper"),
    ).toBe(true);
    expect(body.slice(d.start, d.end)).toBe("default");
  });

  it("a lookup map gets its own message and no delegate range", () => {
    const body = `const ENTITIES = { "&": "&amp;", "<": "&lt;" };\nexport const esc2 = (s) => s.replace(/[&<]/g, (c) => ENTITIES[c]);\n`;
    const [d] = analyze(body, { directive: "module" }).filter(
      (x) => x.code === "hand-written-html-escaper",
    );
    expect(d.message.startsWith("ENTITIES maps & and < to HTML entities")).toBe(
      true,
    );
    expect(d.escaper).toBeUndefined();
  });

  it("is not reported for a src= script's inline body", () => {
    expect(
      analyze(ESCAPER, { directive: "build", hasSrcAttribute: true }).map(
        (d) => d.code,
      ),
    ).not.toContain("hand-written-html-escaper");
  });
});

describe("server-script-unescaped-markup: an XML escaper that says so is trusted in its own file", () => {
  it("calls of a commented XML escaper are exempt; an uncommented one gets the escaper message", () => {
    const fn = `function escapeText(s) {\n  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;");\n}\n`;
    const use =
      "export const item = (t) => `<li><b>${escapeText(t)}</b></li>`;\n";
    const commented = `// RSS is XML, so the feed keeps its own escaper.\n${fn}${use}`;
    expect(analyze(commented, { directive: "module" })).toEqual([]);
    const codes = analyze(fn + use, { directive: "module" }).map((d) => d.code);
    expect(codes.sort()).toEqual([
      "hand-written-html-escaper",
      "server-script-unescaped-markup",
    ]);
  });
});

describe("server-script-unescaped-markup: holes where a tag or attribute name goes (review 2026-10-31)", () => {
  // html`...` throws on these holes, so "wrap the template in html" is
  // wrong advice. Build-time code is the site's own: no report. A request
  // value there is a real injection, so request-time code still warns, with
  // advice that works.
  const module = (body: string) =>
    analyze(body, { directive: "module" }).filter((d) => d.code === RULE);

  it("an attribute name from a parameter in a module: the name hole is skipped, the value hole says esc(), not wrap", () => {
    const body =
      'export const m = (attr: string, key: string) => `<meta ${attr}="${key}">`;\n';
    const diags = module(body);
    expect(diags.map((d) => body.slice(d.start, d.end))).toEqual(["${key}"]);
    expect(diags[0].message).not.toContain("Wrap the template");
    expect(diags[0].message).toContain("esc()");
    expect(diags[0].template?.fixable).toBe(false);
  });

  it("a heading level, attribute strings and a Prettier-wrapped tag in build code are not reported", () => {
    const heading =
      'export const h = (level: number, slug: string) => `<h${level} id="${slug}">Milk frother</h${level}>`;\n';
    expect(module(heading).map((d) => heading.slice(d.start, d.end))).toEqual([
      "${slug}",
    ]);
    const th =
      'export const th = (attributes: string) => `<th scope="col"${attributes}>`;\n';
    expect(module(th)).toEqual([]);
    const img = `export const img = (loading: string, demoClass: string, rest: string) =>
  \`<img
    \${loading}\${demoClass}
    src="/frother.webp"\${rest}
  >\`;
`;
    expect(module(img)).toEqual([]);
    for (const directive of ["build", "routes"] as const)
      expect(
        analyze(`export default () => ${th.slice(th.indexOf("`"))}`, {
          directive,
        }).filter((d) => d.code === RULE),
      ).toEqual([]);
  });

  it("a request value as a tag name in a server script warns without suggesting html", () => {
    const body = handler(
      '`<p><${new URL(request.url).searchParams.get("t")}>Milk frother</p>`',
    );
    const diags = unescaped(body);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("tag or attribute name");
    expect(diags[0].message).not.toContain("Wrap the template");
    expect(diags[0].template?.fixable).toBe(false);
  });

  it("a hole in a quoted value after a name hole is still a value, not a name", () => {
    const body = handler('`<p ${q}="${q}">Milk frother</p>`');
    const diags = unescaped(body);
    expect(diags.map((d) => d.message.includes("name goes"))).toEqual([
      true,
      false,
    ]);
  });

  it("a fragment with no tag keeps the attribute sinks it had (a URL attribute in a server script)", () => {
    const body = handler('` href="${q}"`');
    expect(
      analyze(body)
        .map((d) => d.code)
        .filter((c) => c.startsWith("server-script-sink")),
    ).toEqual(["server-script-sink-url-attribute"]);
  });

  it("a fixable template keeps the wrap advice", () => {
    const body = 'const p = (t: number) => `<p class="x">${t}</p>`;\n';
    const [d] = module(body);
    expect(d.message).toContain("Wrap the template in html");
    expect(d.template?.fixable).toBe(true);
  });
});

describe("a JSON script whose < is escaped as \\u003c (review 2026-10-31)", () => {
  // JSON.stringify(...).replace(/</g, "\\u003c") can never close the
  // <script>, so it is the safe JSON-LD pattern, not a sink.
  const LD = (expr: string) =>
    `const data = {};\nexport const s = \`<script type="application/ld+json">\${${expr}}</script>\`;\n`;
  const sinks = (body: string, directive: AnalyzeOptions["directive"]) =>
    analyze(body, { directive })
      .map((d) => d.code)
      .filter((code) => code !== "server-script-missing-default-export");

  it.each(["module", "build", "server"] as const)(
    "is not reported in a %s script, with replace or replaceAll, Prettier-wrapped or bound to a name",
    (directive) => {
      expect(
        sinks(LD('JSON.stringify(data).replace(/</g, "\\\\u003c")'), directive),
      ).toEqual([]);
      expect(
        sinks(
          LD("JSON.stringify(data, null, 2).replaceAll('<', '\\\\u003C')"),
          directive,
        ),
      ).toEqual([]);
      const wrapped = `export function jsonLd(data: Record<string, unknown>): string {
  const json = JSON.stringify({
    "@context": "https://schema.org",
    ...data,
  }).replace(/</g, "\\\\u003c");
  return \`<script type="application/ld+json">
\${json}
</script>\`;
}
`;
      expect(sinks(wrapped, directive)).toEqual([]);
      expect(
        sinks(
          LD(
            'JSON.stringify(data).replace(/</g, "\\\\u003c").replace(/>/g, "\\\\u003e")',
          ),
          directive,
        ),
      ).toEqual([]);
    },
  );

  it("an escaped newline in the template source before the value counts as whitespace (docs/src/lib/article-schema.ts)", () => {
    const body =
      'export const s = (schema: object) => `<script type="application/ld+json">\\n${JSON.stringify(schema, null, 2).replace(/</g, "\\\\u003c")}\\n</script>`;\n';
    expect(body).toContain('ld+json">\\n${');
    expect(sinks(body, "module")).toEqual([]);
  });

  it("still warns without the < escape, with another escape, or outside a JSON script", () => {
    expect(sinks(LD("JSON.stringify(data)"), "module")).toEqual([
      "server-script-sink-inline-script",
    ]);
    expect(
      sinks(LD('JSON.stringify(data).replace(/>/g, "\\\\u003e")'), "module"),
    ).toEqual(["server-script-sink-inline-script"]);
    expect(
      sinks(
        'export const s = `<script>var d = ${JSON.stringify(data).replace(/</g, "\\\\u003c")};</script>`;',
        "module",
      ),
    ).toEqual(["server-script-sink-inline-script"]);
    // A name bound to a different value somewhere is not trusted.
    const rebound = `let json = JSON.stringify(data).replace(/</g, "\\\\u003c");\njson = raw;\nexport const s = \`<script type="application/ld+json">\${json}</script>\`;\n`;
    expect(sinks(rebound, "module")).toEqual([
      "server-script-sink-inline-script",
    ]);
  });
});

describe("what counts as markup in build-time code (review 2026-10-31)", () => {
  // Placeholders in CLI and prose text, and TypeScript generics in code
  // generation, have a <word> that is no element.
  const module = (body: string) =>
    analyze(body, { directive: "module" }).map((d) => d.code);

  it.each([
    "export const u = (n) => `Usage: tool <command> [options] ${n}`;",
    "export const u = (n) => `Replace <your-domain> with ${n}`;",
    "export const d = (t) => `const x: Array<string> = ${t};`;",
    "export const d = (t) => `type Froth = Map<string, number> & ${t};`;",
    "export const d = (t) => `function f<T>(x: T): T { return ${t}; }`;",
  ])("not markup: %s", (body) => {
    expect(module(body)).toEqual([]);
  });

  it.each([
    "export const c = (t) => `<p>${t}</p>`;",
    'export const c = (t) => `<product-card title="${t}"></product-card>`;',
    "export const c = (t) => `<frother-badge>${t}</frother-badge>`;",
    "export const c = (t) => `<svg><text>${t}</text></svg>`;",
    "export const c = (t) => `<custom-thing hidden>${t}`;",
  ])("markup: %s", (body) => {
    expect(module(body)).toEqual([RULE]);
  });

  it("request-time scripts keep the looser test: any tag counts", () => {
    expect(covered(handler("`<frother-note>${q}`"))).toEqual(["${q}"]);
  });
});

describe("a regex literal in a template hole (review round 2)", () => {
  const build = (body: string) =>
    analyze(body, { directive: "build" }).filter((d) => d.code === RULE);

  it("a quote inside a regex does not open a string that runs past the hole", () => {
    const body =
      'export default () => {\n  const name = load();\n  return `<p title="${name.replace(/"/g, "&quot;")}">${name}</p>`;\n};\n';
    const diags = build(body);
    expect(diags.map((d) => body.slice(d.start, d.end))).toEqual([
      '${name.replace(/"/g, "&quot;")}',
      "${name}",
    ]);
    expect(diags.every((d) => !d.message.includes("ends inside a tag"))).toBe(
      true,
    );
  });

  it("a brace inside a regex does not count as a block", () => {
    const body =
      'export default (s, t) => `<h2>${s.replace(/\\$\\{/g, "")}</h2><i>${t}</i>`;\n';
    expect(build(body).map((d) => body.slice(d.start, d.end))).toEqual([
      '${s.replace(/\\$\\{/g, "")}',
      "${t}",
    ]);
  });

  it("a backtick inside a regex before a markup template hides nothing", () => {
    const body =
      'export default (name) => {\n  const label = name.replace(/`/g, "\'");\n  return `<b>${label}</b>`;\n};\n';
    expect(build(body).map((d) => body.slice(d.start, d.end))).toEqual([
      "${label}",
    ]);
    const server = analyze(
      'export default (request) => {\n  const label = request.url.replace(/`/g, "\'");\n  return `<b>${label}</b>`;\n};\n',
    ).filter((d) => d.code === RULE);
    expect(server).toHaveLength(1);
  });

  it("a regex after return, and a regex holding < or a backtick in a class", () => {
    const body =
      'export default (s) => {\n  if (/[`<]/.test(s)) return /<"/.test(s) ? `<p>${s}</p>` : "";\n  return `<i>${s}</i>`;\n};\n';
    expect(build(body).map((d) => body.slice(d.start, d.end))).toEqual([
      "${s}",
      "${s}",
    ]);
  });

  it("division is not a regex: a / after a name, a number or a closing paren", () => {
    const body =
      "export default (a, b, q) => {\n  const half = a / 2 / (b) / b;\n  const t = `<p>${q}</p>`;\n  return t + `<i>${q}</i>`;\n};\n";
    expect(build(body).map((d) => body.slice(d.start, d.end))).toEqual([
      "${q}",
      "${q}",
    ]);
  });

  it("a regex replacement token in a hole stays inside the hole", () => {
    const body =
      'export default (s) => `<p>${s.replace(/(\\w+)/g, "$1 $& $`")}</p><b>${s}</b>`;\n';
    expect(build(body).map((d) => body.slice(d.start, d.end))).toEqual([
      '${s.replace(/(\\w+)/g, "$1 $& $`")}',
      "${s}",
    ]);
  });
});

describe("plain text and generated code in build-time code are not markup (review round 2)", () => {
  const module = (body: string) =>
    analyze(body, { directive: "module" }).map((d) => d.code);

  it.each([
    // CLI usage text: placeholders named like elements.
    "export const u = (bin) => `Usage: ${bin} build <path> --out <output>`;",
    "export const u = (bin) => `Usage: ${bin} <template> [--yes]`;",
    "export const u = (bin) => `Usage: ${bin} --out <output> <source>`;",
    "export const u = (bin) => `${bin} add <name> --title <title>`;",
    "export const u = (bin) => `${bin} --pattern <pattern> --filter <filter> <label> <code> <data> <time> <text> <image>`;",
    "export const u = (bin) => `${bin} --route <path>`;",
    // Generated TypeScript: generics are case-sensitive names.
    "export const d = (name) => `export const ${name}: ReadonlyArray<Path> = [];`;",
    "export const d = (name) => `const ${name}: Array<Image> = [];`;",
    "export const d = (name) => `let ${name}: Promise<void>;`;",
    // Messages that name elements in prose.
    "export const m = (file, line) => `${file}:${line}: <img> in a <template> needs alt text`;",
    "export const m = (n) => `Found ${n} <img> tags without alt`;",
    "export const m = (n) => `Add ${n} to separate Bascik <script> blocks`;",
    // A message that names a heading level from a value.
    "export const m = (n, where) => `Goes from <h${n}> (${where}) to <h${n + 2}>, skipping <h${n + 1}>.`;",
    // SQL with a < comparison.
    "export const q = (id) => `SELECT * FROM t WHERE a<b AND id = ${id}`;",
  ])("not markup: %s", (body) => {
    expect(module(body)).toEqual([]);
  });

  it("Markdown that names elements in code spans is not markup, and gets no sink rule", () => {
    const body =
      'export function llmsTxt(product: string): string {\n  return `# ${product}\n\n- Pages use components such as \\`<site-header>\\` and a \\`<nav>\\` landmark.\n- Browser code lives in \\`<script src="froth.ts">\\` files, and links are \\`<a href>\\`.\n`;\n}\n';
    expect(module(body)).toEqual([]);
  });

  it.each([
    "export const c = (t) => `<li>${t}`;",
    "export const c = (t) => `<p>${t}<br>${t}`;",
    "export const c = (t) => `<td>${t}</td>`;",
    "export const c = (t) => `<kbd>Ctrl</kbd> and ${t}`;",
    'export const c = (t) => `<a href="/froth">${t}`;',
    "export const c = (t) => `<details open>${t}`;",
    'export const c = (t) => `<linearGradient id="g">${t}</linearGradient>`;',
  ])("still markup: %s", (body) => {
    expect([...new Set(module(body))]).toEqual([RULE]);
  });

  it("an unquoted attribute in real markup still warns", () => {
    expect(
      module("export const c = (t) => `<td colspan=${t}>x</td>`;"),
    ).toEqual(["server-script-sink-unquoted-attribute"]);
  });
});

describe("XML templates get XML advice and no html fix (review round 2)", () => {
  const module = (body: string) =>
    analyze(body, { directive: "module" }).filter((d) => d.code === RULE);

  it.each([
    'export const sitemap = (x: string) => `<?xml version="1.0"?><urlset><url><loc>${x}</loc></url></urlset>`;',
    "export const entry = (x: string) => `<url><loc>${x}</loc></url>`;",
    "export const item = (x: string) => `\n  <item>\n    <title>${x}</title>\n  </item>`;",
    'export const feed = (x: string) => `<feed xmlns="http://www.w3.org/2005/Atom"><title>${x}</title></feed>`;',
    'export const rss = (x: string) => `<rss version="2.0"><channel><title>${x}</title></channel></rss>`;',
  ])("%s", (body) => {
    const diags = module(body);
    expect(diags).toHaveLength(1);
    expect(diags[0].template?.fixable).toBe(false);
    expect(diags[0].message).toContain("XML");
    expect(diags[0].message).toContain("esc()");
    expect(diags[0].message).not.toContain("Wrap the template");
  });

  it("an escaper call in an XML template is escaped already", () => {
    expect(
      module(
        "export const entry = (x: string) => `<url><loc>${escapeHtml(x)}</loc></url>`;",
      ),
    ).toEqual([]);
  });

  it("an HTML template that mentions an item is still HTML", () => {
    const diags = module(
      'const c = (x: number) => `<li class="item">${x}</li>`;',
    );
    expect(diags[0].template?.fixable).toBe(true);
  });
});

describe("hand-written-html-escaper on an XML-named escaper (review round 2)", () => {
  it("the message calls it an XML escaper and asks for the comment", () => {
    const diags = analyze(
      `export function escapeXml(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;"); }`,
      { directive: "module" },
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("escapeXml() looks like an XML escaper");
    expect(diags[0].message).not.toContain("hand-written HTML escaper");
    expect(diags[0].message).toContain("comment");
  });
});

describe("a hole that calls a project module's function gets no wrap fix (review round 2)", () => {
  const diagsOf = (
    body: string,
    directive: AnalyzeOptions["directive"] = "build",
  ) => analyze(body, { directive }).filter((d) => d.code === RULE);

  it.each([
    'import { productCard } from "@/lib/cards.ts";\nexport default () => `<main>${productCard(products[0])}</main>`;',
    'import productCard from "./cards.js";\nexport default () => `<main>${productCard(products[0])}</main>`;',
    'import * as cards from "../lib/cards";\nexport default () => `<main>${cards.productCard(products[0])}</main>`;',
    'import { productCard as card } from "@/lib/cards.ts";\nexport default () => {\n  const first = card(products[0]);\n  return `<main>${first}</main>`;\n};',
    'import {\n  productCard,\n  type Product,\n} from "@/lib/cards.ts";\nexport default () => `<main>${products.map((p: Product) => productCard(p))}</main>`;',
  ])("%s", (body) => {
    const diags = diagsOf(body);
    expect(diags).toHaveLength(1);
    expect(diags[0].template?.fixable).toBe(false);
    expect(diags[0].message).toMatch(
      /(?:productCard|cards\.productCard|card)\(\) comes from a project module/,
    );
    expect(diags[0].message).not.toContain(
      "Wrap the template in html`...` from",
    );
  });

  it("request-time code too", () => {
    const diags = diagsOf(
      'import { productCard } from "./cards.ts";\nexport default (request) => `<main>${productCard(request.url)}</main>`;',
      "server",
    );
    expect(diags[0].template?.fixable).toBe(false);
  });

  it("a function passed as a callback counts; an imported value that is not called keeps the fix", () => {
    const callback = diagsOf(
      'import { productCard } from "@/lib/cards.ts";\nexport default () => `<main>${products.map(productCard)}</main>`;',
    );
    expect(callback[0].template?.fixable).toBe(false);
    expect(callback[0].message).toContain("productCard() comes from");
    const value = diagsOf(
      'import { siteName, NOTE } from "@/lib/site.ts";\nexport default () => `<h1>${siteName}</h1><p>${[NOTE, siteName].join(" ")}</p>`;',
    );
    expect(value.every((d) => !d.message.includes("comes from"))).toBe(true);
  });

  it("a package's function and a local function of an untyped parameter withhold the fix; a local function of a number keeps it", () => {
    expect(
      diagsOf(
        'import slugify from "slugify";\nexport default (t) => `<main>${slugify(t)}</main>`;',
      )[0].template?.fixable,
    ).toBe(false);
    expect(
      diagsOf(
        "const upper = (s) => s.toUpperCase();\nexport default (t) => `<main>${upper(t)}</main>`;",
      )[0].template?.fixable,
    ).toBe(false);
    expect(
      diagsOf(
        "const fixed = (s: number) => s.toFixed(1);\nexport default () => `<main>${fixed(4)}</main>`;",
      )[0].template?.fixable,
    ).toBe(true);
  });
});

describe("review round 3", () => {
  const moduleDiags = (body: string, opts: Partial<AnalyzeOptions> = {}) =>
    analyze(body, { directive: "module", ...opts }).filter(
      (d) => d.code === RULE,
    );
  const moduleCovered = (body: string, opts: Partial<AnalyzeOptions> = {}) =>
    moduleDiags(body, opts).map((d) => body.slice(d.start, d.end));
  const XML_ESCAPER = `// Escape text for XML (the RSS feed and sitemap).\nfunction escapeXml(s: string): string {\n  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;");\n}\n`;

  describe("an XML hole that already holds XML is not told to escape it", () => {
    it.each([
      `export const rss = (items: { t: string }[]) => \`<?xml version="1.0"?><rss><channel>\${items.map((i) => \`<item><title>\${escapeXml(i.t)}</title></item>\`).join("\\n")}</channel></rss>\`;`,
      `export const sitemap = (urls: string[]) => \`<?xml version="1.0"?>\n<urlset>\n\${urls.map((u) => \`  <url><loc>\${escapeXml(u)}</loc></url>\`).join("\\n")}\n</urlset>\`;`,
      `export const atom = (items: { t: string }[]) => \`<feed>\${items.map((i) => \`<entry><title>\${escapeXml(i.t)}</title></entry>\`).join("")}</feed>\`;`,
      `export const atom = (entries: string[]) => \`<feed>\${entries.join("")}</feed>\`;`,
      `export const atom = (items: { t: string }[]) => {\n  const body = items.map((i) => \`<entry><title>\${escapeXml(i.t)}</title></entry>\`).join("");\n  return \`<feed>\${body}</feed>\`;\n};`,
      `export const doc = (t: string) => \`<?xml version="1.0"?><list>\${\`<i>\${escapeXml(t)}</i>\`}</list>\`;`,
    ])("%s", (code) => {
      expect(moduleDiags(XML_ESCAPER + code)).toEqual([]);
    });

    it("a template nested in an XML template is XML too, so its own holes get the XML advice", () => {
      const body = `export const doc = (items: { t: string }[]) => \`<?xml version="1.0"?><list>\${items.map((i) => \`<i>\${i.t}</i>\`).join("")}</list>\`;`;
      const diags = moduleDiags(body);
      expect(diags.map((d) => body.slice(d.start, d.end))).toEqual(["${i.t}"]);
      expect(diags[0].message).toContain("This XML template");
      expect(diags[0].template?.fixable).toBe(false);
    });

    it("in a server script, an inner template's own hole is reported, not the outer hole", () => {
      const body = handler(
        '`<?xml version="1.0"?><urlset>${`<b>${q}</b>`}</urlset>`',
      );
      expect(covered(body)).toEqual(["${q}"]);
    });

    it("a plain value in an XML template still gets the XML advice", () => {
      const body = `export const f = (d: string) => \`<rss><channel><pubDate>\${d}</pubDate></channel></rss>\`;`;
      expect(moduleCovered(body)).toEqual(["${d}"]);
    });
  });

  it("a sitemap index's <sitemap> template is XML; the docs' list of first tags matches the code", () => {
    for (const first of [
      "sitemap",
      "sitemapindex",
      "loc",
      "urlset",
      "url",
      "rss",
      "feed",
      "channel",
      "item",
      "entry",
    ]) {
      const body = `export const t = (u: string) => \`<${first}><b>\${u}</b></${first}>\`;`;
      const diags = moduleDiags(body);
      expect(diags, first).toHaveLength(1);
      expect(diags[0].message, first).toContain("This XML template");
      expect(diags[0].template?.fixable, first).toBe(false);
    }
  });

  describe("a template that searches rendered HTML is a pattern, not markup output", () => {
    it.each([
      "page.includes(`<h1>${title}</h1>`)",
      'page.indexOf(`<section id="${id}">`)',
      'page.lastIndexOf(`<section id="${id}">`)',
      'page.split(`<hr class="${id}">`)',
      'page.startsWith(`<h2 id="${id}">`)',
      'page.search(`<h2 id="${id}">`)',
      'page.match(`<h2 id="${id}">`)',
      'new RegExp(`<h2 id="${id}">`)',
      'RegExp(`<h2 id="${id}">`, "g")',
      'page.replace(`<h2 id="${id}">`, "<h2>")',
      'page.replaceAll(\n  `<h2 id="${id}">`,\n  "<h2>",\n)',
    ])("%s", (expr) => {
      expect(
        moduleCovered(
          `export const f = (page: string, title: string, id: string) => ${expr};`,
        ),
      ).toEqual([]);
      expect(
        covered(handler(expr.replace(/\$\{(?:title|id)\}/g, "${q}"))),
      ).toEqual([]);
    });

    it("the replacement argument of .replace() is still output", () => {
      const body = `export const f = (page: string, id: string) => page.replace(\`<h2 id="\${id}">\`, \`<h2 id="\${id}" tabindex="-1">\`);`;
      const diags = moduleDiags(body);
      expect(diags).toHaveLength(1);
      expect(diags[0].start).toBe(body.lastIndexOf("${id}"));
    });
  });

  describe("build-time messages that name elements", () => {
    it.each([
      "out.push(`Found <p> inside <button> in ${file}`);",
      "out.push(`Unclosed <ul> in ${file}`);",
      "const report = { message: `Unclosed <ul> in ${file}` };",
      "const report = { error: `<head> must contain <meta charset> (${file})` };",
      "class LintError extends Error {\n  constructor(file: string) {\n    super(`<head> must contain <meta charset> (${file})`);\n  }\n}",
      "class LintError extends errors.BuildError {\n  constructor(file: string) {\n    super(`Unclosed <ul> in ${file}`);\n  }\n}",
    ])("%s", (code) => {
      expect(moduleCovered(`const file = process.argv[2];\n${code}`)).toEqual(
        [],
      );
    });

    it("a super() call in a class that is no Error is still checked", () => {
      expect(
        moduleCovered(
          "class Card extends Base {\n  constructor(t: string) {\n    super(`<p>${t}</p>`);\n  }\n}",
        ),
      ).toEqual(["${t}"]);
    });

    it("a bare tag that starts the template or follows a tag or hole is still markup", () => {
      expect(
        moduleCovered(
          "export const a = (t: string) => `<li>${t}`;\nexport const b = (t: string, u: string) => `${t}<br>${u}`;\nexport const c = (t: string) => `\n  <p>\n    ${t}`;\nexport const d = (t: string) => `<ul><li>${t}`;",
        ),
      ).toEqual(["${t}", "${t}", "${u}", "${t}", "${t}"]);
    });
  });

  describe("a tag name made from a hole", () => {
    it("a generic element builder in build code: the other holes get esc() advice and no fix", () => {
      const body =
        'export function el(tag: string, cls: string, content: string): string {\n  return `<${tag} class="${cls}">${content}</${tag}>`;\n}';
      const diags = moduleDiags(body);
      expect(diags.map((d) => body.slice(d.start, d.end))).toEqual([
        "${cls}",
        "${content}",
      ]);
      expect(diags[0].message).toContain("esc()");
      expect(diags[0].template?.fixable).toBe(false);
    });

    it("a request value in such a template is reported in a server script", () => {
      const body = handler(
        '`<${q.length > 3 ? "h1" : "h2"} class="x">${q}</${q.length > 3 ? "h1" : "h2"}>`',
      );
      expect(covered(body)).toEqual(["${q}"]);
      const named = handler('`<${q} class="x">x</${q}>`');
      const diags = unescaped(named);
      expect(diags).toHaveLength(2);
      expect(diags[0].message).toContain("choose between fixed names");
    });

    it("an element builder with a hole-only start and end tag counts; a message that names a tag does not", () => {
      expect(
        moduleCovered(
          "export const el = (tag: string, c: string) => `<${tag}>${c}</${tag}>`;",
        ),
      ).toEqual(["${c}"]);
      expect(
        moduleCovered(
          "const tag = process.argv[2]; const file = process.argv[3];\nconsole.log(1);\nexport const m = `<${tag}> needs a src attribute in ${file}`;",
        ),
      ).toEqual([]);
    });
  });

  describe("a joined hole and a local markup helper withhold the fix with advice that works", () => {
    it('a joined hole names the inner templates, .join("") and the array', () => {
      const body =
        'export const list = (items: string[]) => `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;';
      const diags = moduleDiags(IMPORT + body);
      expect(diags).toHaveLength(1);
      expect(diags[0].template?.fixable).toBe(false);
      expect(diags[0].message).toContain("Wrap the inner templates in html");
      expect(diags[0].message).toContain('drop .join("")');
      expect(diags[0].message).toContain("pass the array");
    });

    it.each([
      "function card(t: string) {\n  return `<em>${esc(t)}</em>`;\n}\nexport default (name: string) => {\n  const c = card(name);\n  return `<section>${c}<p>${name}</p></section>`;\n};",
      "const item = (t: string) => `<li>${esc(t)}</li>`;\nexport const list = (title: string) => `<ul>${item(title)}</ul>`;",
      "const item = (t: string) =>\n  `<li>${esc(t)}</li>`;\nexport const list = (title: string) => `<ul>${item(title)}</ul>`;",
      "export default () => {\n  const statusIcon = ({ label }: { label: string }) =>\n    `<span>${esc(label)}</span>`;\n  return (m: string) => `<td>${statusIcon({ label: m })}</td>`;\n};",
    ])("%s", (code) => {
      const diags = moduleDiags(IMPORT + code);
      expect(diags.length).toBeGreaterThan(0);
      expect(diags.every((d) => d.template?.fixable === false)).toBe(true);
      expect(
        diags.some((d) => /\(\) builds markup as a string/.test(d.message)),
      ).toBe(true);
    });

    it("a local helper that builds its markup with html keeps the fix", () => {
      const diags = moduleDiags(
        IMPORT +
          "const item = (t: string) => html`<li>${t}</li>`;\nconst list = (title: string, x: number) => `<ul>${item(title)}${x}</ul>`;",
      );
      expect(diags.every((d) => d.template?.fixable === true)).toBe(true);
    });

    it("a hole holding a markup string literal (a const or an object property) withholds the fix", () => {
      const viaConst = moduleDiags(
        "const icon = '<svg><path d=\"M0 0\" /></svg>';\nexport const a = (t: string) => `<a>${icon}${t}</a>`;",
      );
      expect(viaConst).toHaveLength(1);
      expect(viaConst[0].template?.fixable).toBe(false);
      const viaProperty = moduleDiags(
        'const statuses = { ok: { shape: \'<path d="m5 12 4 4L19 6" />\' } };\nexport const a = ({ label, shape }: { label: string; shape: string }) => `<svg aria-label="${label}">${shape}</svg>`;',
      );
      expect(viaProperty.every((d) => d.template?.fixable === false)).toBe(
        true,
      );
    });
  });
});

describe("a long alias chain does not overflow the stack (review round 3)", () => {
  it("3000 aliases: the analysis finishes, and a chain past the bound counts as not fine", () => {
    const chain = (n: number) =>
      "const a0 = 'x';\n" +
      Array.from({ length: n }, (_, i) => `const a${i + 1} = a${i};\n`).join(
        "",
      ) +
      `export const t = \`<p>\${a${n}}</p>\`;\n`;
    expect(() => analyze(chain(3_000), { directive: "module" })).not.toThrow();
    expect(
      analyze(chain(3_000), { directive: "module" }).filter(
        (d) => d.code === RULE,
      ),
    ).toHaveLength(1);
    expect(
      analyze(chain(20), { directive: "module" }).filter(
        (d) => d.code === RULE,
      ),
    ).toEqual([]);
  });
});

describe("templates nested thousands deep do not overflow the stack (fix round 1)", () => {
  const nested = (depth: number) =>
    "export const first = (q: string) => `<p>${q}</p>`;\nexport const deep = (q: string) => " +
    "`<b>${".repeat(depth) +
    "q" +
    "}</b>`".repeat(depth) +
    ";\n";

  it("20000 nested templates: the analysis finishes and the file's other diagnostics survive", () => {
    const body = nested(20_000);
    let diags: ReturnType<typeof analyze> = [];
    expect(() => {
      diags = analyze(body, { directive: "module" });
    }).not.toThrow();
    const holes = diags
      .filter((d) => d.code === RULE)
      .map((d) => body.slice(d.start, d.end));
    expect(holes[0]).toBe("${q}");
    expect(holes).toContain("${q}");
    expect(holes.length).toBeGreaterThan(1);
  });

  it("the template finder and the tokenizer read 20000 nested templates whole", () => {
    const body = nested(20_000);
    const literals = findTemplateLiterals(body);
    expect(literals).toHaveLength(20_001);
    expect(literals[1].parts[0]).toBe("<b>");
    expect(literals[20_000].holes[0].expr).toBe("q");
    expect(literals[1].end).toBe(body.lastIndexOf("`") + 1);
    const { tokens } = scanJavaScript(body);
    expect(tokens.filter((t) => t.value === "q")).toHaveLength(4);
    expect(tokens.at(-1)?.value).toBe(";");
  });

  it("the iterative scanners read nesting, regexes, strings and unclosed templates as before", () => {
    const body =
      "const a = `x${ {k: `y${/}`/.test(s) ? '`' : \"}\"}z`}.k }w`; const b = /`/g; // `\\n`t${1}`;\nlet c = `u${`v`}${'}'}` + `open${ x";
    expect(
      findTemplateLiterals(body).map((l) => [
        l.start,
        l.end,
        l.tag,
        l.parts,
        l.holes.map((h) => [h.start, h.end, h.expr]),
      ]),
    ).toEqual([
      [
        10,
        57,
        null,
        ["x", "w"],
        [[12, 55, " {k: `y${/}`/.test(s) ? '`' : \"}\"}z`}.k "]],
      ],
      [19, 50, null, ["y", "z"], [[21, 48, "/}`/.test(s) ? '`' : \"}\""]]],
      [
        98,
        113,
        null,
        ["u", "", ""],
        [
          [100, 106, "`v`"],
          [106, 112, "'}'"],
        ],
      ],
      [102, 105, null, ["v"], []],
      [116, 125, null, ["open", ""], [[121, 125, " x"]]],
    ]);
    const { tokens, comments } = scanJavaScript(body);
    expect(tokens.map((t) => [t.type, t.value, t.start, t.end])).toEqual([
      ["identifier", "const", 0, 5],
      ["identifier", "a", 6, 7],
      ["punctuation", "=", 8, 9],
      ["punctuation", "{", 15, 16],
      ["identifier", "k", 16, 17],
      ["punctuation", ":", 17, 18],
      ["punctuation", ".", 27, 28],
      ["identifier", "test", 28, 32],
      ["punctuation", "(", 32, 33],
      ["identifier", "s", 33, 34],
      ["punctuation", ")", 34, 35],
      ["punctuation", "?", 36, 37],
      ["string", "`", 39, 40],
      ["punctuation", ":", 42, 43],
      ["string", "}", 45, 46],
      ["punctuation", "}", 50, 51],
      ["punctuation", ".", 51, 52],
      ["identifier", "k", 52, 53],
      ["punctuation", ";", 57, 58],
      ["identifier", "const", 59, 64],
      ["identifier", "b", 65, 66],
      ["punctuation", "=", 67, 68],
      ["punctuation", ";", 73, 74],
      ["identifier", "let", 90, 93],
      ["identifier", "c", 94, 95],
      ["punctuation", "=", 96, 97],
      ["template", "v", 103, 104],
      ["string", "}", 109, 110],
      ["punctuation", "+", 114, 115],
      ["identifier", "x", 124, 125],
    ]);
    expect(comments).toEqual([{ start: 75, end: 89 }]);
  });
});

describe("Markdown code spans and fences hold no markup, tag-name holes too (fix round 1)", () => {
  const moduleCovered = (body: string) =>
    unescaped(body, { directive: "module" }).map((d) =>
      body.slice(d.start, d.end),
    );

  it.each([
    // A code span whose tag name is a hole, like the fixed-tag spans.
    'export const f = (tag: string, attr: string) => `Use \\`<${tag} class="${attr}">\\` here`;',
    "export const f = (tag: string, attr: string) => `Use \\`<${tag}>${attr}</${tag}>\\` here`;",
    // A fenced block in Markdown: the renderer escapes its text.
    'export const f = (tag: string, attr: string) => `\\`\\`\\`html\n<${tag} class="${attr}"></${tag}>\n\\`\\`\\``;',
    'export const f = (attr: string) => `\\`\\`\\`html\n<x-card class="${attr}"></x-card>\n\\`\\`\\``;',
    "export const f = (attr: string) => `Example:\\n\\n\\`\\`\\`html\\n<p>${attr}</p>\\n\\`\\`\\`\\n`;",
    "export const f = (attr: string) => `~~~html\n<p>${attr}</p>\n~~~\n`;",
    // A fence opened in one part and closed after a hole.
    "export const f = (lang: string, attr: string) => `\\`\\`\\`${lang}\n<p>${attr}</p>\n\\`\\`\\``;",
  ])("not reported: %s", (body) => {
    expect(moduleCovered(body)).toEqual([]);
  });

  it.each([
    // Markup after a closed fence is still markup.
    [
      'export const f = (attr: string, t: string) => `\\`\\`\\`html\n<p>x</p>\n\\`\\`\\`\n<div class="${attr}">${t}</div>`;',
      ["${attr}", "${t}"],
    ],
    // A tag-name hole outside a code span is still markup.
    [
      'export const f = (tag: string, attr: string) => `Use <${tag} class="${attr}"> here`;',
      ["${attr}"],
    ],
    // Three backticks in the middle of a line open no fence.
    ["export const f = (t: string) => `<p>a \\`\\`\\` b ${t}</p>`;", ["${t}"]],
  ])("still reported: %s", (body, holes) => {
    expect(moduleCovered(body)).toEqual(holes);
  });

  it("a hole in a fence of a template with markup outside it is skipped, and the wrap fix is withheld", () => {
    const body =
      'export const f = (code: string, t: string) => `<section>${t}</section>\\n\\n\\`\\`\\`html\\n<p class="${code}"></p>\\n\\`\\`\\`\\n`;';
    const diags = unescaped(body, { directive: "module" });
    expect(diags.map((d) => body.slice(d.start, d.end))).toEqual(["${t}"]);
    expect(diags[0].template?.fixable).toBe(false);
    expect(diags[0].message).toContain("Markdown code fence");
    expect(diags[0].message).toContain("esc()");
  });
});

describe("the wrap fix is offered only when no hole can hold markup (fix round 1)", () => {
  const moduleDiags = (body: string) =>
    unescaped(body, { directive: "module" });
  /** Whether the template whose holes include `hole` is fixable. */
  const fixableAt = (body: string, hole: string) => {
    const diags = moduleDiags(body);
    const d = diags.find((x) => body.slice(x.start, x.end) === hole);
    expect(d, `${hole} is reported`).toBeDefined();
    return { fixable: d!.template?.fixable, message: d!.message };
  };

  it.each([
    [
      "an accumulator built with +=",
      'export function e(items: string[]) { let out = ""; for (const t of items) out += `<li>${t}</li>`; return `<ul>${out}</ul>`; }',
      "${out}",
      "out",
    ],
    [
      "an accumulator built with += outside a loop",
      'export function e(t: string) { let out = ""; out += `<li>${t}</li>`; return `<ul>${out}</ul>`; }',
      "${out}",
      "out",
    ],
    [
      "a local helper returning concatenated markup",
      'function bold(t: string) { return "<b>" + t + "</b>"; }\nexport function b(t: string) { return `<p>${bold(t)}</p>`; }',
      "${bold(t)}",
      "bold",
    ],
    [
      "a local helper returning quoted markup literals",
      'function icon(s: string) { return s === "ok" ? \'<svg class="ok"></svg>\' : "<span>-</span>"; }\nexport function a(s: string, label: string) { return `<td>${icon(s)} ${label}</td>`; }',
      "${label}",
      "icon",
    ],
    [
      "a local helper returning a markup constant",
      "const ICON = '<svg class=\"ok\"></svg>';\nfunction getIcon() { return ICON; }\nexport function c(t: string) { return `<p>${getIcon()}${t}</p>`; }",
      "${t}",
      "getIcon",
    ],
    [
      "an array of markup templates interpolated without .join",
      "export function d(items: string[]) { const parts = items.map((i) => `<li>${i}</li>`); return `<ul>${parts}</ul>`; }",
      "${parts}",
      "parts",
    ],
    [
      "an array filled with .push",
      "export function f(items: string[]) { const rows: string[] = []; for (const t of items) rows.push(`<li>${t}</li>`); return `<ul>${rows}</ul>`; }",
      "${rows}",
      "rows",
    ],
    [
      "inline concatenation in the hole",
      'export const g = (t: string, u: string) => `<p>${"<b>" + t + "</b>"}${u}</p>`;',
      "${u}",
      "",
    ],
    [
      "a nested untagged template in the hole",
      "export const g = (items: string[]) => `<ul>${items.map((i) => `<li>${i}</li>`)}</ul>`;",
      "${items.map((i) => `<li>${i}</li>`)}",
      "",
    ],
    [
      "a hole escaped with esc() already",
      'import { esc } from "@bascik/bascik/html";\nexport const g = (a: string, b: string) => `<p>${esc(a)} ${b}</p>`;',
      "${b}",
      "esc(a)",
    ],
  ])("%s: no fix, and the message says why", (_name, body, hole, culprit) => {
    const { fixable, message } = fixableAt(body, hole);
    expect(fixable).toBe(false);
    expect(message).not.toContain(
      "Wrap the template in html`...` from @bascik/bascik/html, which escapes each value for where it lands.",
    );
    if (culprit) expect(message).toContain(culprit);
  });

  it.each([
    ["a number parameter", "const g = (t: number) => `<p>${t}</p>`;", "${t}"],
    [
      "a local helper with no markup",
      "const fixed = (s: number) => s.toFixed(1);\nconst g = (t: number) => `<p>${fixed(t)}</p>`;",
      "${fixed(t)}",
    ],
    [
      "a local helper that builds its markup with html",
      'import { html } from "@bascik/bascik/html";\nconst item = (t: string) => html`<li>${t}</li>`;\nconst g = (t: string, x: number) => `<ul>${item(t)}${x}</ul>`;',
      "${x}",
    ],
    [
      "a name bound to plain data",
      'const g = () => { const label = process.env.SITE_NAME + " (new)"; return `<p>${label}</p>`; };',
      "${label}",
    ],
  ])("%s keeps the fix", (_name, body, hole) => {
    expect(fixableAt(body, hole).fixable).toBe(true);
  });

  it("a property of an object parameter withholds it (allowlist, fix round 6)", () => {
    const body = "const g = (p: { title: string }) => `<h2>${p.title}</h2>`;";
    const { fixable, message } = fixableAt(body, "${p.title}");
    expect(fixable).toBe(false);
    expect(message).toContain("cannot prove it is plain text");
  });
});

describe("lint and CLI messages that name elements are not markup (fix round 1)", () => {
  const moduleCovered = (body: string, opts: Partial<AnalyzeOptions> = {}) =>
    unescaped(body, { directive: "module", ...opts }).map((d) =>
      body.slice(d.start, d.end),
    );

  it.each([
    // A message passed to a project's own reporting function.
    'findings.push(\n  finding(\n    CHECK,\n    "part-name",\n    `${file}:${t.line}: <${t.tag} data-testid="${id}"> is a part of ${name}; name it ${name}-<part>, such as "${name}-${id}"`,\n    { file, line: t.line },\n  ),\n);',
    'report(`<${tag} class="${cls}"> needs a data-testid`);',
    'ctx.report({ node, message: "x" }, `<img src="${src}"> has no alt`);',
    'logger.warn(`<div class="${c}"> is empty`);',
    'addWarning(`<a href="${href}"> opens a new tab without rel`);',
    // The file:line: message shape, wherever it goes.
    'lines.push(`${file}:${line}: <img src="${src}"> needs alt text`);',
    'const text = `${file}:${line}:${col}: <a href="${href}"> has no text`;',
  ])("not reported: %s", (body) => {
    expect(moduleCovered(body)).toEqual([]);
  });

  it.each([
    ["out.push(`<td>${title}</td>`);", ["${title}"]],
    ['dialog(`<p class="note">${text}</p>`);', ["${text}"]],
    ["catalog(`<li>${name}</li>`);", ["${name}"]],
    [
      "const row = `${label}: <strong>${value}</strong>`;",
      ["${label}", "${value}"],
    ],
  ])("still reported: %s", (body, holes) => {
    expect(moduleCovered(body)).toEqual(holes);
  });

  it("request-time code still reports markup passed to a reporting function", () => {
    expect(
      moduleCovered('report(`<p class="${cls}">${q}</p>`);', {
        requestTime: true,
      }),
    ).toEqual(["${cls}", "${q}"]);
  });
});

describe("the wrap fix follows typed bindings, parameters, file reads and unknown calls (fix round 2)", () => {
  const fixableAt = (body: string, hole: string) => {
    const diags = unescaped(body, { directive: "module" });
    const d = diags.find((x) => body.slice(x.start, x.end) === hole);
    expect(d, `${hole} is reported`).toBeDefined();
    return { fixable: d!.template?.fixable, message: d!.message };
  };

  it.each([
    [
      "a constant with a type annotation",
      "const ICONS2: Record<string, string> = { ok: '<svg class=\"ok\"></svg>' };\nfunction st2(s: string, l: string) { return `<td>${ICONS2[s]}${l}</td>`; }",
      "${l}",
      "ICONS2",
    ],
    [
      "a typed let accumulator",
      'let out: string = "";\nfunction e(t: string) { out += `<li>${t}</li>`; return `<ul>${out}</ul>`; }',
      "${out}",
      "out",
    ],
    [
      "a typed let declared without a value",
      "let out: string;\nfunction e(t: string) { out = `<li>${t}</li>`; return `<ul>${out}</ul>`; }",
      "${out}",
      "out",
    ],
    [
      "a typed markup constant",
      'const sep: string = "<br>";\nfunction f(a: string) { return `<p>${a}${sep}</p>`; }',
      "${a}",
      "sep",
    ],
    [
      "a typed array of markup strings",
      'function e(items: string[]) { const lis: string[] = items.map((i) => "<li>" + i + "</li>"); return `<ul>${lis}</ul>`; }',
      "${lis}",
      "lis",
    ],
    [
      "an arrow with a function type annotation",
      'const ital: (t: string) => string = (t) => "<i>" + t + "</i>";\nfunction c(t: string) { return `<p>${ital(t)}</p>`; }',
      "${ital(t)}",
      "ital",
    ],
    [
      "a typed arrow with a generic annotation",
      'const b: Map<string, () => string> = new Map([["a", () => "<b>x</b>"]]);\nfunction c(t: string) { return `<p>${b.get(t)}</p>`; }',
      "${b.get(t)}",
      "b",
    ],
    [
      "a destructured binding",
      "const { icon } = { icon: '<svg class=\"i\"></svg>' };\nfunction c(t: string) { return `<p>${icon}${t}</p>`; }",
      "${t}",
      "icon",
    ],
    [
      "an array destructured binding",
      "const [first] = ['<svg class=\"i\"></svg>'];\nfunction c(t: string) { return `<p>${first}${t}</p>`; }",
      "${t}",
      "first",
    ],
    [
      "a parameter a local call fills with a markup string",
      'function layout(title: string, body: string) { return `<main><h1>${title}</h1>${body}</main>`; }\nconst home = layout("Home", "<p>Welcome</p>");',
      "${title}",
      "body",
    ],
    [
      "a parameter a local call fills with a markup template",
      'function layout(title: string, body: string) { return `<main><h1>${title}</h1>${body}</main>`; }\nfunction page(y: string) { return layout("Home", `<p>${y}</p>`); }',
      "${title}",
      "body",
    ],
    [
      "a callback parameter",
      'function wrap(render: () => string) { return `<div class="w">${render()}</div>`; }',
      "${render()}",
      "render",
    ],
    [
      "a function imported from a package",
      'import { marked } from "marked";\nfunction post(md: string, t: string) { return `<article><h1>${t}</h1>${marked(md)}</article>`; }',
      "${t}",
      "marked",
    ],
    [
      "a file read",
      'import fs from "node:fs";\nfunction withHeader(c: string) { const header = fs.readFileSync("partials/header.html", "utf8"); return `<body>${header}<p>${c}</p></body>`; }',
      "${c}",
      "header",
    ],
    [
      "a file read in the hole",
      'import { readFileSync } from "node:fs";\nfunction withHeader(c: string) { return `<body>${readFileSync("h.html", "utf8")}<p>${c}</p></body>`; }',
      "${c}",
      "readFileSync",
    ],
    [
      "a fetched response's text",
      'async function part(c: string) { const res = await fetch("https://example.com/p"); const body = await res.text(); return `<div>${body}<p>${c}</p></div>`; }',
      "${c}",
      "body",
    ],
  ])("%s: no fix, and the message says why", (_name, body, hole, culprit) => {
    const { fixable, message } = fixableAt(body, hole);
    expect(fixable).toBe(false);
    expect(message).not.toContain(
      "Wrap the template in html`...` from @bascik/bascik/html, which escapes each value for where it lands.",
    );
    expect(message).toContain(culprit);
  });

  it.each([
    [
      "a typed binding to plain data",
      'const g = () => { const label: string = process.env.SITE_NAME + " (new)"; return `<p>${label}</p>`; };',
      "${label}",
    ],
    [
      "a global conversion call",
      "const g = (n: number) => `<p>${String(n)} ${encodeURIComponent(n)}</p>`;",
      "${String(n)}",
    ],
    [
      "a local helper with no markup, typed",
      "const fixed: (s: number) => string = (s: number) => s.toFixed(1);\nconst g = (t: number) => `<p>${fixed(t)}</p>`;",
      "${fixed(t)}",
    ],
  ])("%s keeps the fix", (_name, body, hole) => {
    expect(fixableAt(body, hole).fixable).toBe(true);
  });

  it("a string parameter that local calls fill with plain data withholds it (allowlist, fix round 6)", () => {
    const body =
      'function heading(title: string) { return `<h1>${title}</h1>`; }\nconst home = heading("Home");\nconst about = heading(`About ${"us"}`);';
    expect(fixableAt(body, "${title}").fixable).toBe(false);
  });
});

describe("report writers and unclosed fences (fix round 2)", () => {
  const moduleCovered = (body: string) =>
    unescaped(body, { directive: "module" }).map((d) =>
      body.slice(d.start, d.end),
    );

  it("a whole page passed to a function named for a report is markup", () => {
    const body =
      'export function gen(title: string, rows: string) {\n  writeReport("report.html", `<html><head><title>${title}</title></head><body>${rows}</body></html>`);\n}';
    expect(moduleCovered(body)).toEqual(["${title}", "${rows}"]);
  });

  it("a fence that never closes hides no markup after it", () => {
    const body =
      'export function code(lang: string, src: string, user: string) {\n  return `<div class="post">\n\\`\\`\\`${lang}\n${src}\n<p class="by">${user}</p>\n</div>`;\n}';
    expect(moduleCovered(body)).toEqual(["${lang}", "${src}", "${user}"]);
  });
});

describe("the wrap fix follows markup across modules (fix round 3)", () => {
  const fixableAt = (
    body: string,
    hole: string,
    opts: Partial<AnalyzeOptions> = {},
  ) => {
    const diags = unescaped(body, { directive: "module", ...opts });
    const d = diags.find((x) => body.slice(x.start, x.end) === hole);
    expect(d, `${hole} is reported`).toBeDefined();
    return { fixable: d!.template?.fixable, message: d!.message };
  };
  const NOT_FIXABLE_TEXT =
    "Wrap the template in html`...` from @bascik/bascik/html, which escapes each value for where it lands.";

  it.each([
    [
      "an imported ALL_CAPS markup constant",
      'import { ICON_OK } from "./icons.ts";\nconst a = (l: string) => `<td>${ICON_OK}${l}</td>`;',
      "${l}",
      "ICON_OK",
    ],
    [
      "a property of an imported object",
      'import { icons } from "./icons.ts";\nconst b = (l: string) => `<td>${icons.ok}${l}</td>`;',
      "${l}",
      "icons",
    ],
    [
      "an imported name after the reported hole",
      'import { footer } from "../partials/icons.ts";\nconst c = (l: string) => `<p>${l}</p>${footer}`;',
      "${l}",
      "footer",
    ],
    [
      "a default import from an @/ specifier",
      'import banner from "@/lib/banner.ts";\nconst c = (l: string) => `<p>${l}</p>${banner}`;',
      "${l}",
      "banner",
    ],
    [
      "a namespace import's member",
      'import * as parts from "./parts.ts";\nconst c = (l: string) => `<p>${l}</p>${parts.footer}`;',
      "${l}",
      "parts",
    ],
    [
      "an environment variable",
      "const footer = process.env.FOOTER_MARKUP;\nconst c = (l: string) => `<p>${l}</p>${footer}`;",
      "${l}",
      "footer",
    ],
    [
      "an environment variable in the hole",
      "const c = (l: string) => `<p>${l}</p>${process.env.FOOTER_MARKUP}`;",
      "${l}",
      "process.env",
    ],
  ])("%s: no fix, and the message says why", (_name, body, hole, culprit) => {
    const { fixable, message } = fixableAt(body, hole);
    expect(fixable).toBe(false);
    expect(message).not.toContain(NOT_FIXABLE_TEXT);
    expect(message).toContain(culprit);
  });

  it.each([
    [
      "an environment variable not named for markup",
      'const siteUrl = process.env.BASCIK_SITE_URL ?? "";\nconst c = (p: number) => `<link rel="canonical" href="${siteUrl}/page/${p}" />`;',
      "${p}",
    ],
    [
      "a bracketed environment variable not named for markup",
      'const c = (l: number) => `<p>${process.env["SITE_NAME"]}: ${l}</p>`;',
      "${l}",
    ],
  ])("%s keeps the fix", (_name, body, hole) => {
    expect(fixableAt(body, hole).fixable).toBe(true);
  });

  it.each([
    [
      "a name imported from a package",
      'import { siteName } from "site-meta";\nconst c = (l: number) => `<p>${siteName}: ${l}</p>`;',
      "${l}",
      "siteName",
    ],
    [
      "a type-only import's object",
      'import type { Row } from "./types.ts";\nconst c = (r: Row) => `<p>${r.name}</p>`;',
      "${r.name}",
      "r",
    ],
    [
      "a property named like an import",
      'import { footer } from "./icons.ts";\nconst c = (p: { footer: string }) => `<p>${p.footer}</p>`;',
      "${p.footer}",
      "p",
    ],
  ])(
    "%s withholds it (allowlist, fix round 6)",
    (_name, body, hole, culprit) => {
      const { fixable, message } = fixableAt(body, hole);
      expect(fixable).toBe(false);
      expect(message).toContain(culprit);
    },
  );
});

describe("a parameter other modules can fill withholds the wrap fix (fix round 4)", () => {
  const holes = (
    body: string,
    hole: string,
    opts: Partial<AnalyzeOptions> = {},
  ) => {
    const found = unescaped(body, { directive: "module", ...opts }).filter(
      (x) => body.slice(x.start, x.end) === hole,
    );
    expect(found.length, `${hole} is reported`).toBeGreaterThan(0);
    return found;
  };
  const CALLER_TEXT = "may be markup from a caller";

  it.each([
    [
      "an anonymous default export arrow",
      "export default (title: string, body: string) => `<main><h1>${title}</h1>${body}</main>`;",
    ],
    [
      "an anonymous default export function",
      "export default function (title: string, body: string) { return `<main><h1>${title}</h1>${body}</main>`; }",
    ],
    [
      "an async anonymous default export function",
      "export default async function (title: string, body: string) { return `<main><h1>${title}</h1>${body}</main>`; }",
    ],
    [
      "an async anonymous default export arrow",
      "export default async (title: string, body: string) => `<main><h1>${title}</h1>${body}</main>`;",
    ],
    [
      "a named default export",
      "export default function layout(title: string, body: string) { return `<main><h1>${title}</h1>${body}</main>`; }",
    ],
    [
      "an exported function",
      "export function layout(title: string, body: string) { return `<main><h1>${title}</h1>${body}</main>`; }",
    ],
    [
      "an exported const arrow",
      "export const layout = (title: string, body: string) => `<main><h1>${title}</h1>${body}</main>`;",
    ],
    [
      "an exported const function expression",
      "export const layout = function (title: string, body: string) { return `<main><h1>${title}</h1>${body}</main>`; };",
    ],
    [
      "an export list with an alias",
      "function frame(title: string, body: string) { return `<main><h1>${title}</h1>${body}</main>`; }\nexport { frame as layout };",
    ],
    [
      "a default export of a name",
      "const frame = (title: string, body: string) => `<main><h1>${title}</h1>${body}</main>`;\nexport default frame;",
    ],
    [
      "an exported class method",
      "export class Layout { render(title: string, body: string) { return `<main><h1>${title}</h1>${body}</main>`; } }",
    ],
    [
      "a static method of an exported class",
      "export class Layout { static render(title: string, body: string) { return `<main><h1>${title}</h1>${body}</main>`; } }",
    ],
    [
      "an exported class's constructor",
      "export class Layout { out: string; constructor(title: string, body: string) { this.out = `<main><h1>${title}</h1>${body}</main>`; } }",
    ],
    [
      "an arrow field of an exported class",
      "export class Layout { render = (title: string, body: string) => `<main><h1>${title}</h1>${body}</main>`; }",
    ],
    [
      "an anonymous default export class",
      "export default class { render(title: string, body: string) { return `<main><h1>${title}</h1>${body}</main>`; } }",
    ],
    [
      "a class exported by name later",
      "class Layout extends Base { render(title: string, body: string) { return `<main><h1>${title}</h1>${body}</main>`; } }\nexport { Layout };",
    ],
    [
      "a shorthand method of an exported object",
      "export const lg = { page(title: string, body: string) { return `<main><h1>${title}</h1>${body}</main>`; } };",
    ],
    [
      "an arrow member of an exported object",
      "export const lg = { page: (title: string, body: string) => `<main><h1>${title}</h1>${body}</main>` };",
    ],
    [
      "a function member of a nested exported object",
      "export const ui = { parts: { page: function (title: string, body: string) { return `<main><h1>${title}</h1>${body}</main>`; } } };",
    ],
    [
      "an object default export",
      "export default { page(title: string, body: string) { return `<main><h1>${title}</h1>${body}</main>`; } };",
    ],
    [
      "a local function an exported object names in shorthand",
      "function page(title: string, body: string) { return `<main><h1>${title}</h1>${body}</main>`; }\nexport const lg = { page };",
    ],
    [
      "module.exports",
      "module.exports = { page(title, body) { return `<main><h1>${title}</h1>${body}</main>`; } };",
    ],
    [
      "an exports property",
      "exports.page = function (title, body) { return `<main><h1>${title}</h1>${body}</main>`; };",
    ],
    [
      "untyped JavaScript parameters",
      "export function layout(title, body) { return `<main><h1>${title}</h1>${body}</main>`; }",
    ],
    [
      "a string or number parameter",
      "export function layout(title: string | number, body: string) { return `<main><h1>${title}</h1>${body}</main>`; }",
    ],
    [
      "a binding read from the parameter",
      "export function layout(title: string, body: string) { const heading = title.trim(); return `<main><h1>${heading}</h1>${body}</main>`; }",
    ],
  ])("%s: no fix, warning kept, with the caller advice", (_name, body) => {
    for (const hole of ["${body}"]) {
      for (const d of holes(body, hole)) {
        expect(d.template?.fixable).toBe(false);
        expect(d.message).toContain(CALLER_TEXT);
        expect(d.message).toContain("html");
      }
    }
  });

  it("the message names the function the hole's parameter belongs to", () => {
    const body =
      "export class Layout { render(title: string, body: string) { return `<main><h1>${title}</h1>${body}</main>`; } }\nexport const lg = { page(title: string, body: string) { return `<main><h1>${title}</h1>${body}</main>`; } };\nexport default (title: string) => `<h1>${title}</h1>`;\nexport class Card { constructor(title: string) { this.out = `<h2>${title}</h2>`; } }";
    const owners = unescaped(body, { directive: "module" })
      .filter((d) => body.slice(d.start, d.end) === "${title}")
      .map((d) => /a parameter of (.+?), which/.exec(d.message)?.[1]);
    expect(owners).toEqual([
      "Layout.render()",
      "lg.page()",
      "the default export",
      "new Card()",
    ]);
  });

  it("the fix is withheld though no other module is known to call it", () => {
    const body =
      "export default (title: string, body: string) => `<main><h1>${title}</h1>${body}</main>`;";
    expect(holes(body, "${title}")[0].template?.fixable).toBe(false);
  });

  it.each([
    [
      "number and boolean parameters",
      'export function badge(count: number, open: boolean) { return `<span data-open="${open}">${count}</span>`; }',
      "${count}",
    ],
    [
      "a bigint parameter with a default",
      "export const id = (n: bigint = 1n) => `<b>${n}</b>`;",
      "${n}",
    ],
    [
      "an optional union of number and boolean",
      "export class Meter { render(value?: number | boolean) { return `<meter>${value}</meter>`; } }",
      "${value}",
    ],
    [
      "a number member of an exported object",
      "export const ui = { count: (n: number) => `<b>${n}</b>` };",
      "${n}",
    ],
  ])(
    "%s withhold the fix: a JavaScript caller can pass markup whatever the type says (fix round 7)",
    (_name, body, hole) => {
      for (const d of holes(body, hole)) {
        expect(d.template?.fixable).toBe(false);
        expect(d.message).toContain("whatever its type says");
      }
    },
  );

  it.each([
    [
      "a local function whose callers pass plain data",
      'function row(name: string) { return `<li>${name}</li>`; }\nexport const list = row("Milk frother");',
      "${name}",
    ],
    [
      "a function nested in an exported one, called with plain data",
      'export function list() { function row(name: string) { return `<li>${name}</li>`; } return row("Milk frother"); }',
      "${name}",
    ],
  ])(
    "%s: a string parameter, so no fix (allowlist, fix round 6)",
    (_name, body, hole) => {
      for (const d of holes(body, hole))
        expect(d.template?.fixable).toBe(false);
    },
  );

  it("a local function an exported one passes its parameter: no fix", () => {
    const body =
      "function wrap(inner: string) { return `<main>${inner}</main>`; }\nexport function layout(body: string) { return wrap(body); }";
    expect(holes(body, "${inner}")[0].template?.fixable).toBe(false);
  });

  it.each([
    [
      "build",
      'export default function () {\n  const product = { name: "Milk frother" };\n  return `<h1>${product.name}</h1>`;\n}\n',
      "${product.name}",
    ],
    ["server", handler("`<p>${q}</p>`"), "${q}"],
  ])(
    "a %s directive script's own locals keep the fix",
    (directive, body, hole) => {
      const d = unescaped(body, {
        directive: directive as AnalyzeOptions["directive"],
      }).find((x) => body.slice(x.start, x.end) === hole);
      expect(d?.template?.fixable).toBe(true);
    },
  );
});

describe("every parameter whose callers this file cannot all see withholds the wrap fix (fix round 5)", () => {
  const holes = (body: string, hole: string) => {
    const found = unescaped(body, { directive: "module" }).filter(
      (x) => body.slice(x.start, x.end) === hole,
    );
    expect(found.length, `${hole} is reported`).toBeGreaterThan(0);
    return found;
  };
  const CALLER_TEXT = "may be markup from a caller";

  it.each([
    [
      "an array parameter's element in a map callback",
      'export function renderList(items: string[]): string { return items.map((item) => `<li>${item}</li>`).join(""); }',
      "${item}",
    ],
    [
      "a for...of loop variable",
      'export const renderList = (items: string[]): string => { let out = ""; for (const i of items) out += `<li>${i}</li>`; return out; };',
      "${i}",
    ],
    [
      "a destructured for...of loop variable",
      'export function dl(o: Record<string, string>) { let s = ""; for (const [k, v] of Object.entries(o)) s += `<dd>${v}</dd>`; return s; }',
      "${v}",
    ],
    [
      "a property of a callback's element",
      'export function rows(items: { name: string }[]): string { return items.map((item) => `<li>${item.name}</li>`).join(""); }',
      "${item.name}",
    ],
    [
      "a reduce callback",
      'export function ul(items: string[]) { return items.reduce((acc, i) => acc + `<li>${i}</li>`, ""); }',
      "${i}",
    ],
    [
      "a destructured callback parameter",
      'export function dl(o: Record<string, string>) { return Object.entries(o).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join(""); }',
      "${v}",
    ],
    [
      "a then callback",
      "export function later(p: Promise<string>) { return p.then((v) => `<p>${v}</p>`); }",
      "${v}",
    ],
    [
      "a local function passed to map",
      'function li(t: string) { return `<li>${t}</li>`; }\nexport function list(items: string[]) { return items.map(li).join(""); }',
      "${t}",
    ],
    [
      "a generic parameter that extends string",
      "export function f<T extends string>(t: T) { return `<p>${t}</p>`; }",
      "${t}",
    ],
    [
      "an unconstrained generic parameter",
      "export function g<T>(t: T) { return `<p>${t}</p>`; }",
      "${t}",
    ],
    [
      "a returned closure",
      "export function make() { return (t: string) => `<p>${t}</p>`; }",
      "${t}",
    ],
    [
      "a returned local function",
      "function inner(t: string) { return `<p>${t}</p>`; }\nexport function make() { return inner; }",
      "${t}",
    ],
    [
      "a method of a returned object",
      "export function make() { return { render(t: string) { return `<p>${t}</p>`; } }; }",
      "${t}",
    ],
    [
      "an exported function wrapped in a call",
      "const local = (t: string) => `<p>${t}</p>`;\nconst wrap = <F,>(f: F) => f;\nexport const h = wrap(local);",
      "${t}",
    ],
    [
      "an arrow in a frozen exported object",
      "export const api = Object.freeze({ render: (t: string) => `<p>${t}</p>` });",
      "${t}",
    ],
    [
      "a function in an exported array",
      "function render(t: string) { return `<p>${t}</p>`; }\nexport const renderers = [render];",
      "${t}",
    ],
    [
      "a function in an exported Map",
      'const render = (t: string) => `<p>${t}</p>`;\nexport const renderers = new Map([["a", render]]);',
      "${t}",
    ],
    [
      "an exported destructuring",
      "export const { render } = { render: (t: string) => `<p>${t}</p>` };",
      "${t}",
    ],
    [
      "an exported generator function",
      "export function* render(t: string) { yield `<p>${t}</p>`; }",
      "${t}",
    ],
    [
      "a callback passed to an imported function",
      'import { register } from "./reg.ts";\nregister((t: string) => `<p>${t}</p>`);',
      "${t}",
    ],
    [
      "a function assigned to globalThis",
      "(globalThis as any).render = (t: string) => `<p>${t}</p>`;\nexport {};",
      "${t}",
    ],
    [
      "the arguments object",
      "export function page() { const t = arguments[0]; return `<p>${t}</p>`; }",
      "${t}",
    ],
    [
      "a this field set from a constructor parameter",
      "export class C { body: string; constructor(body: string) { this.body = body; } render() { return `<p>${this.body}</p>`; } }",
      "${this.body}",
    ],
    [
      "a this field set from a method parameter",
      'export class C { body = ""; set(b: string) { this.body = b; return this; } render() { return `<p>${this.body}</p>`; } }',
      "${this.body}",
    ],
    [
      "a regex capture in a local helper an exported function calls",
      "function t(md: string) { return md.replace(/<pre>([\\s\\S]*?)<\\/pre>/g, (_, code: string) => `<cb>${code}</cb>`); }\nexport function render(md: string) { return t(md); }",
      "${code}",
    ],
    [
      "a regex match in a replace callback",
      "export function highlight(code: string, re: RegExp) { return code.replace(re, (m) => `<mark>${m}</mark>`); }",
      "${m}",
    ],
    [
      "an untyped JavaScript callback parameter",
      'export function list(items) { return items.map(function (t) { return `<li>${t}</li>`; }).join(""); }',
      "${t}",
    ],
  ])(
    "%s: no fix, warning kept, with the caller advice",
    (_name, body, hole) => {
      for (const d of holes(body, hole)) {
        expect(d.template?.fixable).toBe(false);
        expect(d.message).toContain(CALLER_TEXT);
      }
    },
  );

  it.each([
    [
      "a number callback parameter",
      'export function list(counts: number[]) { return counts.map((n: number) => `<li>${n}</li>`).join(""); }',
      "${n}",
    ],
    [
      "a union of number, bigint and boolean",
      "export function g(n: number | bigint | boolean) { return `<p>${n}</p>`; }",
      "${n}",
    ],
    [
      "a number and boolean method parameter of a local class",
      'class Meter { render(value: number, open: boolean) { return `<meter data-open="${open}">${value}</meter>`; } }\nexport const m = new Meter();',
      "${value}",
    ],
  ])(
    "%s withholds the fix: its callers are out of sight (fix round 7)",
    (_name, body, hole) => {
      for (const d of holes(body, hole)) {
        expect(d.template?.fixable).toBe(false);
        expect(d.message).toContain("whatever its type says");
      }
    },
  );

  it("a number parameter of a local function only called by name keeps the fix", () => {
    const body =
      "function g(n: number | bigint | boolean) { return `<p>${n}</p>`; }\nexport const out = g(1) + g(true);";
    for (const d of holes(body, "${n}")) expect(d.template?.fixable).toBe(true);
  });

  it("a build directive script's callback over its own data keeps its other fixes", () => {
    const body =
      'export default function () {\n  const product = { name: "Milk frother" };\n  return `<h1>${product.name}</h1>`;\n}\n';
    const d = unescaped(body, { directive: "build" }).find(
      (x) => body.slice(x.start, x.end) === "${product.name}",
    );
    expect(d?.template?.fixable).toBe(true);
  });
});

describe("the wrap fix is offered only for holes that are provably plain data (allowlist, fix round 6)", () => {
  const UNPROVEN = "cannot prove it is plain text";
  const holes = (
    body: string,
    hole: string,
    opts: Partial<AnalyzeOptions> = { directive: "module" },
  ) => {
    const found = unescaped(body, opts).filter(
      (x) => body.slice(x.start, x.end) === hole,
    );
    expect(found.length, `${hole} is reported`).toBeGreaterThan(0);
    return found;
  };
  const server = { directive: "server" } as const;
  const apiRoute = { directive: "module", requestTime: true } as const;

  it.each<[string, string, string, Partial<AnalyzeOptions>]>([
    [
      "a query parameter",
      'export default function (request) {\n  const q = new URL(request.url).searchParams.get("q") ?? "";\n  return `<p>${q}</p>`;\n}\n',
      "${q}",
      server,
    ],
    [
      "a header",
      'export default (request) => `<p>${request.headers.get("x-user")}</p>`;',
      '${request.headers.get("x-user")}',
      server,
    ],
    [
      "a JSON body field through a const",
      "export default async function (request) {\n  const body = await request.json();\n  return `<p>${body.name}</p>`;\n}\n",
      "${body.name}",
      server,
    ],
    [
      "a request value through string methods",
      "export default (request) => `<p>${new URL(request.url).pathname.slice(1).toUpperCase()}</p>`;",
      "${new URL(request.url).pathname.slice(1).toUpperCase()}",
      server,
    ],
    [
      "an environment variable",
      "export function footer() { return `<p>${process.env.SITE_NAME}</p>`; }",
      "${process.env.SITE_NAME}",
      { directive: "module" },
    ],
    [
      "a date through a const",
      "export function stamp() { const d = new Date(); return `<time>${d.toISOString()}</time>`; }",
      "${d.toISOString()}",
      { directive: "module" },
    ],
    [
      "a year from new Date()",
      "export function year() { return `<p>${new Date().getFullYear()}</p>`; }",
      "${new Date().getFullYear()}",
      { directive: "module" },
    ],
    [
      "a number parameter of a local function",
      "function f(n: number) { return `<p>${n}</p>`; }\nexport const out = f(1);",
      "${n}",
      { directive: "module" },
    ],
    [
      "String() of a number parameter, padded",
      'function f(n: number) { return `<p>${String(n).padStart(3, "0")}</p>`; }\nexport const out = f(1);',
      '${String(n).padStart(3, "0")}',
      { directive: "module" },
    ],
    [
      "a const object of literals read by a literal key",
      'const labels = { ok: "Fine", bad: "Broken" };\nfunction f(ok: boolean) { return `<p>${ok ? labels.ok : labels.bad}</p>`; }\nexport const out = f(true);',
      "${ok ? labels.ok : labels.bad}",
      { directive: "module" },
    ],
    [
      "a const array of literals read by a literal index",
      'const sizes = ["Small", "Large"];\nfunction f(big: boolean) { return `<p>${big ? sizes[1] : sizes[0]}</p>`; }\nexport const out = f(true);',
      "${big ? sizes[1] : sizes[0]}",
      { directive: "module" },
    ],
    [
      "a local helper that returns plain data",
      'function label(n: number) { return n === 1 ? "item" : "items"; }\nfunction f(n: number) { return `<p>${n} ${label(n)}</p>`; }\nexport const out = f(2);',
      "${label(n)}",
      { directive: "module" },
    ],
    [
      "a number guarded with Number.isFinite",
      'export default (request) => {\n  const n = Number(new URL(request.url).searchParams.get("d") ?? 0);\n  const delay = Number.isFinite(n) ? Math.min(n, 5) : 0;\n  return `<p data-delay="${delay}">${request.method}</p>`;\n};\n',
      "${request.method}",
      server,
    ],
    [
      "a const built from request data and literals",
      'export default (request) => {\n  const who = "User " + request.headers.get("x-user");\n  return `<p>${who}</p>`;\n};\n',
      "${who}",
      server,
    ],
  ])("%s keeps the fix", (_name, body, hole, opts) => {
    for (const d of holes(body, hole, opts)) {
      expect(d.template?.fixable).toBe(true);
      expect(d.message).toContain("Wrap the template in html");
    }
  });

  it.each<[string, string, string, Partial<AnalyzeOptions>?]>([
    [
      "an object field a setter writes",
      'const state = { body: "" };\nexport function set(v: string) { state.body = v; }\nexport function render() { return `<p>${state.body}</p>`; }',
      "${state.body}",
    ],
    [
      "an array slot written after creation",
      'const items: string[] = ["a"];\nexport function add(v: string) { items[0] = v; }\nexport function render() { return `<li>${items[0]}</li>`; }',
      "${items[0]}",
    ],
    [
      "an object field written through an alias",
      'const state = { body: "" };\nexport function set(v: string) { const s = state; s.body = v; }\nexport function render() { return `<p>${state.body}</p>`; }',
      "${state.body}",
    ],
    [
      "an object field written by Object.assign",
      'const state = { body: "" };\nexport function set(v: string) { Object.assign(state, { body: v }); }\nexport function render() { return `<p>${state.body}</p>`; }',
      "${state.body}",
    ],
    [
      "an object field written by a bracket",
      'const state: Record<string, string> = { body: "" };\nexport function set(v: string) { state["body"] = v; }\nexport function render() { return `<p>${state.body}</p>`; }',
      "${state.body}",
    ],
    [
      "a nested object field",
      'const state = { a: { body: "" } };\nexport function set(v: string) { state.a.body = v; }\nexport function render() { return `<p>${state.a.body}</p>`; }',
      "${state.a.body}",
    ],
    [
      "an exported object's field",
      'export const state = { body: "" };\nexport function render() { return `<p>${state.body}</p>`; }',
      "${state.body}",
    ],
    [
      "an object passed to an imported mutator",
      'import { fill } from "./mut.ts";\nconst state = { body: "" };\nfill(state);\nexport const out = `<p>${state.body}</p>`;',
      "${state.body}",
    ],
    [
      "a Map read",
      'const state = new Map<string, string>([["b", ""]]);\nexport function set(v: string) { state.set("b", v); }\nexport function render() { return `<p>${state.get("b")}</p>`; }',
      '${state.get("b")}',
    ],
    [
      "a Map in the same function",
      'export function f(t: string) { const a = new Map<string, string>(); a.set("k", t); return `<p>${a.get("k")}</p>`; }',
      '${a.get("k")}',
    ],
    [
      "an array slot in the same function",
      'export function f(t: string) { const a = [""]; a[0] = t; return `<p>${a[0]}</p>`; }',
      "${a[0]}",
    ],
    [
      "a static class field",
      'export class C { static body = ""; static set(v: string) { C.body = v; } static render() { return `<p>${C.body}</p>`; } }',
      "${C.body}",
    ],
    [
      "a closure's object field",
      'export function make() { const st = { b: "" }; return { set(v: string) { st.b = v; }, render() { return `<p>${st.b}</p>`; } }; }',
      "${st.b}",
    ],
    [
      "a catch binding",
      "export function f(t: string) { try { throw new Error(t); } catch (e) { return `<p>${(e as Error).message}</p>`; } }",
      "${(e as Error).message}",
    ],
    [
      "a for await variable",
      'export async function f(xs: string[]) { let s = ""; for await (const x of xs) s += `<li>${x}</li>`; return s; }',
      "${x}",
    ],
    [
      "globalThis",
      "export function f() { return `<p>${(globalThis as any).V7}</p>`; }",
      "${(globalThis as any).V7}",
    ],
    [
      "a value imported from a package",
      'import { tagline } from "some-package";\nexport const f = () => `<p>${tagline}</p>`;',
      "${tagline}",
    ],
    [
      "a string parameter of a local helper",
      'const row = (name: string) => `<li>${name}</li>`;\nexport const list = row("Milk frother") + row("Kettle");',
      "${name}",
    ],
    [
      "a number parameter cast with as",
      "export function f(n: number) { return `<p>${n as unknown as string}</p>`; }",
      "${n as unknown as string}",
    ],
    [
      "a number parameter reassigned through a cast",
      "export function f(n: number) { n = window.name as any; return `<p>${n}</p>`; }",
      "${n}",
    ],
    [
      "a let",
      'export function f(ok: boolean) { let label = "Fine"; if (!ok) label = "Broken"; return `<p>${label}</p><p>${process.env.SITE_NAME}</p>`; }',
      "${process.env.SITE_NAME}",
    ],
    [
      "a call to a package function",
      'import { slugify } from "some-package";\nexport function f(n: number) { return `<p id="${slugify(String(n))}">${n}</p>`; }',
      "${n}",
    ],
    [
      "an exported local helper",
      'export function label(n: number) { return n === 1 ? "item" : "items"; }\nexport function f(n: number) { return `<p>${label(n)}</p>`; }',
      "${label(n)}",
    ],
    [
      "a helper passed as a value",
      'function label(n: number) { return n === 1 ? "item" : "items"; }\nexport const labels = [1, 2].map(label);\nexport function f(n: number) { return `<p>${label(n)}</p>`; }',
      "${label(n)}",
    ],
    [
      "a request JSON object passed to a helper that may change it",
      "export default async function (request) {\n  const body = await request.json();\n  fill(body);\n  return `<p>${body.name}</p>`;\n}\n",
      "${body.name}",
      { directive: "server" },
    ],
    [
      "the platform context",
      "export default (request, context) => `<p>${context.platform.env.FOOTER}</p>`;",
      "${context.platform.env.FOOTER}",
      { directive: "server" },
    ],
  ])("%s: no fix, the warning says why", (_name, body, hole, opts) => {
    for (const d of holes(body, hole, opts ?? { directive: "module" })) {
      expect(d.template?.fixable).toBe(false);
      expect(d.message).toContain(UNPROVEN);
    }
  });

  it("an exported module function's request parameter, which other modules can call, gets no fix", () => {
    const body =
      "export async function GET(request, context) {\n  return new Response(`<p>${context.params.id}</p>`);\n}\n";
    for (const d of holes(body, "${context.params.id}", apiRoute))
      expect(d.template?.fixable).toBe(false);
  });

  it("the message names the value it cannot follow and why", () => {
    const body =
      'const state = { body: "" };\nexport function set(v: string) { state.body = v; }\nexport function render() { return `<p>${state.body}</p>`; }';
    const [d] = holes(body, "${state.body}");
    expect(d.message).toContain("state");
    expect(d.message).toMatch(/change|written|assign/);
  });

  it("a long chain of consts names only the first value and the hole's own name", () => {
    const chain = Array.from(
      { length: 5 },
      (_, i) => `const c${i} = ${i === 0 ? "state.body" : `c${i - 1}`};`,
    ).join("\n");
    const body = `const state = { body: "" };\nexport function set(v: string) { state.body = v; }\n${chain}\nexport const out = \`<p>\${c4}</p>\`;`;
    const [d] = holes(body, "${c4}");
    expect(d.message).toContain("reads state (through c4),");
  });

  it("an html value in another hole does not withhold the fix", () => {
    const body = `${IMPORT}export default (request) => \`<p>\${request.headers.get("x")}</p>\${html\`<b>hi</b>\`}\`;`;
    for (const d of holes(body, '${request.headers.get("x")}', server))
      expect(d.template?.fixable).toBe(true);
  });
});

describe("destructuring assignments into a module let are reassignments (fix round 6)", () => {
  it.each([
    [
      "an array pattern",
      'let body = "";\nexport function set(v: string) { [body] = [v]; }\nexport function render() { return `<p>${body}</p>`; }',
    ],
    [
      "an object pattern",
      'let body = "";\nexport function set(o: { body: string }) { ({ body } = o); }\nexport function render() { return `<p>${body}</p>`; }',
    ],
  ])("%s: the hole warns, with no fix", (_name, body) => {
    const found = unescaped(body, { directive: "module" }).filter(
      (x) => body.slice(x.start, x.end) === "${body}",
    );
    expect(found).toHaveLength(1);
    expect(found[0].template?.fixable).toBe(false);
  });

  it("an index assignment is not a destructuring", () => {
    const body =
      'let body = "";\nconst parts = [""];\nexport function set(v: string) { parts[0] = v; }\nexport function render() { return `<p>${body}</p>`; }';
    expect(
      unescaped(body, { directive: "module" }).filter(
        (x) => body.slice(x.start, x.end) === "${body}",
      ),
    ).toHaveLength(0);
  });
});

describe("entities, escaped markup, patched built-ins and exported parameters are not plain (allowlist, fix round 7)", () => {
  const UNPROVEN = "cannot prove it is plain text";
  const diagsAt = (
    body: string,
    hole: string,
    opts: Partial<AnalyzeOptions> = { directive: "module" },
  ) => {
    const found = unescaped(body, opts).filter(
      (x) => body.slice(x.start, x.end) === hole,
    );
    expect(found.length, `${hole} is reported`).toBeGreaterThan(0);
    return found;
  };
  const server = { directive: "server" } as const;
  /** A module whose template has a plain env hole beside `hole`. */
  const beside = (hole: string, before = "") =>
    `${before}export const out = \`<p>\${process.env.A}${hole}</p>\`;\n`;

  it.each<[string, string, string, Partial<AnalyzeOptions>?]>([
    [
      "an entity in a ?? fallback",
      'const s = process.env.X ?? "&mdash;";\nexport const out = `<p>${s}</p>`;\n',
      "${s}",
    ],
    [
      "an entity in an array of literals",
      'const a = ["&nbsp;", "x"];\nexport const out = `<p>${a[0]}</p>`;\n',
      "${a[0]}",
    ],
    [
      "an entity in an object of literals",
      'const t = { dash: "&mdash;" };\nexport const out = `<p>${t.dash}</p>`;\n',
      "${t.dash}",
    ],
    [
      "an entity concatenated to a number",
      'const g = (n: number) => `<p>${n.toString() + "&nbsp;"}</p>`;\nexport const out = g(1);\n',
      '${n.toString() + "&nbsp;"}',
    ],
    [
      "an entity repeated, beside a plain hole",
      beside('${"&amp;".repeat(2)}'),
      "${process.env.A}",
    ],
    [
      "an entity piece in padStart",
      beside('${"x".padStart(4, "&lt;")}'),
      "${process.env.A}",
    ],
    [
      "an entity in a nested template's text",
      beside("${`&mdash;${process.env.B}`}"),
      "${process.env.A}",
    ],
    [
      "an entity in a hole-less nested template",
      beside("${process.env.B ?? `&mdash;`}"),
      "${process.env.A}",
    ],
    [
      "a request header with an entity fallback",
      'export default (request) => `<p>${request.headers.get("x-name") ?? "&mdash;"}</p>`;',
      '${request.headers.get("x-name") ?? "&mdash;"}',
      server,
    ],
    [
      "markup written with \\x3c in replace",
      'const s = process.env.S ?? "Hi";\nexport const out = `<p>${s.replace("Hi", "\\x3cb>Hi\\x3c/b>")}</p>`;\n',
      '${s.replace("Hi", "\\x3cb>Hi\\x3c/b>")}',
    ],
    [
      "markup written with \\x3c after a comma operator",
      beside('${(1, "\\x3cb>Hi\\x3c/b>")}'),
      "${process.env.A}",
    ],
    [
      "markup written with \\x3c in concat",
      beside('${"a".concat("\\x3cb>Hi\\x3c/b>")}'),
      "${process.env.A}",
    ],
    [
      "markup written with \\u003c in a || fallback",
      'export default (request) => `<p>${new URL(request.url).searchParams.get("q") || "\\u003cem>none\\u003c/em>"}</p>`;',
      '${new URL(request.url).searchParams.get("q") || "\\u003cem>none\\u003c/em>"}',
      server,
    ],
    [
      "markup written with \\u{3c}",
      'const s = process.env.X ?? "\\u{3c}b>x";\nexport const out = `<p>${s}</p>`;\n',
      "${s}",
    ],
    [
      "markup written with an octal escape",
      "const s = process.env.X ?? '\\74b>x';\nexport const out = `<p>${s}</p>`;\n",
      "${s}",
    ],
    [
      "a file's own String function",
      'function String(x: number) { return "plain"; }\nexport const out = `<p>${String(1)}</p>`;\n',
      "${String(1)}",
    ],
    [
      "a patched String.prototype method",
      'String.prototype.toUpperCase = () => "<b>Hi</b>";\nexport const out = `<p>${process.env.A?.toUpperCase()}</p>`;\n',
      "${process.env.A?.toUpperCase()}",
    ],
    [
      "a patched Number.prototype method",
      'Number.prototype.toFixed = () => "<b>Hi</b>";\nconst g = (n: number) => `<p>${process.env.A}${n.toFixed(1)}</p>`;\nexport const out = g(1);\n',
      "${process.env.A}",
    ],
    [
      "a prototype changed through defineProperty",
      'Object.defineProperty(String.prototype, "trim", { value: () => "<b>x</b>" });\nexport const out = `<p>${process.env.A?.trim()}</p>`;\n',
      "${process.env.A?.trim()}",
    ],
    [
      "an env value written in the same file",
      'process.env.CF_A16 = "<b>Hi</b>";\nexport const out = `<p>${process.env.CF_A16}</p>`;\n',
      "${process.env.CF_A16}",
    ],
    [
      "an env value written with a bracket",
      'process.env["CF_A16"] = "<b>Hi</b>";\nexport const out = `<p>${process.env.CF_A16}</p>`;\n',
      "${process.env.CF_A16}",
    ],
    [
      "process.env handed to Object.assign",
      'Object.assign(process.env, { A: "<b>Hi</b>" });\nexport const out = `<p>${process.env.A}</p>`;\n',
      "${process.env.A}",
    ],
    [
      "a patched Math method",
      beside("${Math.max(1, 2)}", 'Math.max = (() => "<b>Hi</b>") as any;\n'),
      "${process.env.A}",
    ],
    [
      "a patched Date.now",
      'Date.now = (() => "<b>Hi</b>") as any;\nexport const out = `<p>${Date.now()}</p>`;\n',
      "${Date.now()}",
    ],
    [
      "a global written through globalThis",
      beside(
        "${Math.max(1, 2)}",
        '(globalThis as any).Math = { max: () => "<b>Hi</b>" };\n',
      ),
      "${process.env.A}",
    ],
    [
      "a number parameter of an exported function",
      "export function f(n: number) { return `<p>${n}</p>`; }",
      "${n}",
    ],
    [
      "an optional number parameter of an exported function",
      "export function f(n?: number) { return `<p>${n}</p>`; }",
      "${n}",
    ],
    [
      "a number | true parameter of an exported function",
      "export function f(n: number | true) { return `<p>${n}</p>`; }",
      "${n}",
    ],
    [
      "a number parameter of an exported arrow",
      "export const p15 = (w: number) => `<p>${w}</p>`;",
      "${w}",
    ],
    [
      "a number parameter of a default-exported arrow",
      "export default (t: number) => `<main>${t}</main>`;",
      "${t}",
    ],
    [
      "a number parameter of a function exported by name",
      "function f(n: number) { return `<p>${n}</p>`; }\nexport { f };",
      "${n}",
    ],
    [
      "a number parameter of a callback",
      "export const out = [1, 2].map((n: number) => `<li>${n}</li>`).join('');",
      "${n}",
    ],
  ])("%s: no fix, the warning says why", (_name, body, hole, opts) => {
    for (const d of diagsAt(body, hole, opts ?? { directive: "module" })) {
      expect(d.template?.fixable).toBe(false);
      // Object.assign(process.env, ...) is caught first as markup set in the file.
      expect(d.message).toMatch(
        new RegExp(`${UNPROVEN}|is set to a markup string in this file`),
      );
    }
  });

  it.each<[string, string, string, Partial<AnalyzeOptions>?]>([
    [
      "a plain ?? fallback",
      'const s = process.env.X ?? "-";\nexport const out = `<p>${s}</p>`;\n',
      "${s}",
    ],
    [
      "plain padding",
      'const g = (n: number) => `<p>${String(n).padStart(3, "0")}</p>`;\nexport const out = g(1);\n',
      '${String(n).padStart(3, "0")}',
    ],
    [
      "a plain escape (\\u00a0, \\n)",
      'const s = process.env.X ?? "Milk\\u00a0frother\\n";\nexport const out = `<p>${s}</p>`;\n',
      "${s}",
    ],
    [
      "a number parameter of a local helper called by name",
      "function f(n: number) { return `<p>${n}</p>`; }\nexport const out = f(1) + f(2);\n",
      "${n}",
    ],
    [
      "a request header with a plain fallback",
      'export default (request) => `<p>${request.headers.get("x-name") ?? "-"}</p>`;',
      '${request.headers.get("x-name") ?? "-"}',
      server,
    ],
    [
      "Math.max read beside an unrelated field named max",
      beside("${Math.max(1, limits.max)}", "const limits = { max: 3 };\n"),
      "${process.env.A}",
    ],
  ])("%s keeps the fix", (_name, body, hole, opts) => {
    for (const d of diagsAt(body, hole, opts ?? { directive: "module" }))
      expect(d.template?.fixable).toBe(true);
  });
});

describe("call arguments, html turned into text, decoded URLs, changed request data and number arguments are not plain (allowlist, fix round 8)", () => {
  const UNPROVEN = "cannot prove it is plain text";
  const diagsAt = (
    body: string,
    hole: string,
    opts: Partial<AnalyzeOptions> = { directive: "module" },
  ) => {
    const found = unescaped(body, opts).filter(
      (x) => body.slice(x.start, x.end) === hole,
    );
    expect(found.length, `${hole} is reported`).toBeGreaterThan(0);
    return found;
  };
  const server = { directive: "server" } as const;
  /** A value Bascik cannot follow, built without a markup literal. */
  const M =
    'const m = String.fromCharCode(60) + "b>Hi" + String.fromCharCode(60) + "/b>";\n';
  const HTML = 'import { html, raw } from "@bascik/bascik/html";\n';

  it.each<[string, string, string, Partial<AnalyzeOptions>?]>([
    // (1) Every argument of every call in the chain.
    [
      "an unknown argument of a call on a Date's members",
      `${M}const d = new Date(0);\nexport const out = \`<p>\${d.constructor.name.concat(m)}</p>\`;\n`,
      "${d.constructor.name.concat(m)}",
    ],
    [
      "an unknown argument of replace on a new Date's members",
      `${M}export const out = \`<p>\${new Date(0).constructor.name.replace("Date", m)}</p>\`;\n`,
      '${new Date(0).constructor.name.replace("Date", m)}',
    ],
    [
      "an unknown argument of a Date method",
      `${M}export const out = \`<p>\${new Date(0).toLocaleDateString(m)}</p>\`;\n`,
      "${new Date(0).toLocaleDateString(m)}",
    ],
    [
      "an unknown argument of an optional call on request data",
      `${M}export default function (request) { return \`<p>\${request.url.concat?.(m)}</p>\`; }\n`,
      "${request.url.concat?.(m)}",
      server,
    ],
    [
      "an unknown argument of an optional replace on request data",
      `${M}export default function (request) { return \`<p>\${request.method.replace?.("GET", m)}</p>\`; }\n`,
      '${request.method.replace?.("GET", m)}',
      server,
    ],
    // (2) An html value turned into a string.
    [
      "raw() turned into a string with toString()",
      `${HTML}${M}export const out = \`<p>\${raw(m).toString()}</p>\`;\n`,
      "${raw(m).toString()}",
    ],
    [
      "String() of an html value",
      `${HTML}export const out = \`<p>\${String(html\`<b>Hi</b>\`)}</p>\`;\n`,
      "${String(html`<b>Hi</b>`)}",
    ],
    [
      "a local helper that returns an html value + ''",
      `${HTML}function g() { return html\`<b>Hi</b>\` + ""; }\nexport const out = \`<p>\${g()}</p>\`;\n`,
      "${g()}",
    ],
    [
      "a local helper's html value + ''",
      `${HTML}function g() { return html\`<b>Hi</b>\`; }\nexport const out = \`<p>\${g() + ""}</p>\`;\n`,
      '${g() + ""}',
    ],
    [
      "an html const in a nested untagged template",
      `${HTML}const h = html\`<b>Hi</b>\`;\nexport const out = \`<p>\${\`\${h}\`}</p>\`;\n`,
      "${`${h}`}",
    ],
    [
      "an html const in concat()",
      `${HTML}const h = html\`<b>Hi</b>\`;\nexport const out = \`<p>\${"a".concat(h)}</p>\`;\n`,
      '${"a".concat(h)}',
    ],
    [
      "a parenthesized html value turned into a string",
      `${HTML}const h = html\`<b>Hi</b>\`;\nexport const out = \`<p>\${(h).toString()}</p>\`;\n`,
      "${(h).toString()}",
    ],
    // (3) A URL or URLSearchParams built from literals decodes %3C and %26.
    [
      "URLSearchParams of a literal",
      'export const out = `<p>${new URLSearchParams("q=%3Cb%3EHi%3C%2Fb%3E").get("q")}</p>`;\n',
      '${new URLSearchParams("q=%3Cb%3EHi%3C%2Fb%3E").get("q")}',
    ],
    [
      "a URL of a literal, through a const",
      'const u = new URL("https://example.com/?q=%3Cb%3EHi%3C/b%3E");\nexport const out = `<p>${u.searchParams.get("q")}</p>`;\n',
      '${u.searchParams.get("q")}',
    ],
    [
      "URLSearchParams of a literal joined to a const",
      'const tail = "%3C/b%3E";\nconst q = new URLSearchParams("q=%3Cb%3EHi" + tail);\nexport const out = `<p>${q.get("q")}</p>`;\n',
      '${q.get("q")}',
    ],
    [
      "URLSearchParams of a literal beside request data",
      'export default function (request) { return `<p>${new URLSearchParams("q=%3Cb%3E").get("q") ?? request.method}</p>`; }\n',
      '${new URLSearchParams("q=%3Cb%3E").get("q") ?? request.method}',
      server,
    ],
    [
      "a URL of a literal in request-time code",
      'export default function (request) { const u = new URL("http://x/?q=%3Cb%3EHi%3C/b%3E"); return `<p>${u.searchParams.get("q")}</p>`; }\n',
      '${u.searchParams.get("q")}',
      server,
    ],
    // (4) Request data the script changes or hands to other code.
    [
      "a header the script sets",
      'export default function (request) {\n  request.headers.set("x-name", "Hi");\n  return `<p>${request.headers.get("x-name")}</p>`;\n}\n',
      '${request.headers.get("x-name")}',
      server,
    ],
    [
      "a header the script appends",
      'export default function (request) {\n  request.headers.append("x-extra", "Hi");\n  return `<p>${request.headers.get("x-extra")}</p>`;\n}\n',
      '${request.headers.get("x-extra")}',
      server,
    ],
    [
      "a header the script deletes, through an alias",
      'export default function (request) {\n  const h = request.headers;\n  h.delete("x-name");\n  return `<p>${request.headers.get("x-name")}</p>`;\n}\n',
      '${request.headers.get("x-name")}',
      server,
    ],
    [
      "searchParams handed to a local function",
      'function fill(p) { p.set("q", "Hi"); }\nexport default function (request) {\n  const u = new URL(request.url);\n  fill(u.searchParams);\n  return `<p>${u.searchParams.get("q")}</p>`;\n}\n',
      '${u.searchParams.get("q")}',
      server,
    ],
    [
      "headers handed to a local function",
      'function fill(h) { h.set("x-name", "Hi"); }\nexport default function (request) {\n  fill(request.headers);\n  return `<p>${request.headers.get("x-name")}</p>`;\n}\n',
      '${request.headers.get("x-name")}',
      server,
    ],
    [
      "params written through an alias",
      'export default function (request, context) {\n  const p = context.params;\n  p.id = "Hi";\n  return `<p>${context.params.id}</p>`;\n}\n',
      "${context.params.id}",
      server,
    ],
    [
      "the request handed to other code",
      "export default function (request) {\n  stamp(request);\n  return `<p>${request.method}</p>`;\n}\n",
      "${request.method}",
      server,
    ],
    [
      "searchParams written",
      'export default function (request) {\n  const u = new URL(request.url);\n  u.searchParams.set("q", "Hi");\n  return `<p>${u.searchParams.get("q")}</p>`;\n}\n',
      '${u.searchParams.get("q")}',
      server,
    ],
    // (5) A Date the script changes or hands on.
    [
      "a Date handed to Object.assign",
      'const d = new Date(0);\nObject.assign(d, { toISOString: () => "Hi" });\nexport const out = `<p>${d.toISOString()}</p>`;\n',
      "${d.toISOString()}",
    ],
    // (6) Number parameters keep the fix only for number arguments.
    [
      "a number parameter whose default is an any value",
      `${M}const a: any = m;\nfunction g(n: number = a) { return n; }\nexport const out = \`<p>\${g()}</p>\`;\n`,
      "${g()}",
    ],
    [
      "a number parameter called with an any value",
      `${M}const a: any = m;\nfunction g(n: number) { return n; }\nexport const out = \`<p>\${g(a)}</p>\`;\n`,
      "${g(a)}",
    ],
    [
      "a number parameter called with JSON.parse()",
      'const text = JSON.stringify("Hi");\nfunction g(n: number) { return n; }\nexport const out = `<p>${g(JSON.parse(text))}</p>`;\n',
      "${g(JSON.parse(text))}",
    ],
    [
      "a number parameter called with a string from the environment",
      "function g(n: number) { return n; }\nexport const out = `<p>${g(process.env.N as any)}</p>`;\n",
      "${g(process.env.N as any)}",
    ],
    [
      "a number parameter called with a spread",
      "const xs = [1];\nfunction g(n: number) { return n; }\nexport const out = `<p>${g(...xs)}</p>`;\n",
      "${g(...xs)}",
    ],
  ])("%s: no fix, the warning says why", (_name, body, hole, opts) => {
    for (const d of diagsAt(body, hole, opts ?? { directive: "module" })) {
      expect(d.template?.fixable).toBe(false);
      expect(d.message).toContain(UNPROVEN);
    }
  });

  it.each<[string, string]>([
    ["eval", 'eval("1");\n'],
    ["new Function", 'new Function("return 1");\n'],
    ["Function()", 'Function("return this")();\n'],
    [
      "Object.defineProperty",
      'Object.defineProperty({}, "a", { value: 1 });\n',
    ],
    [
      "Reflect.defineProperty",
      'Reflect.defineProperty({}, "a", { value: 1 });\n',
    ],
    ["Reflect.set", 'Reflect.set({}, "a", 1);\n'],
    ["Object.setPrototypeOf", "Object.setPrototypeOf({}, null);\n"],
    [
      "a prototype member written through a template key",
      "(String as any)[`prototype`].trim = function () { return 'x'; };\n",
    ],
    [
      "a prototype written through a string key",
      '(Array as any)["prototype"][1] = "x";\n',
    ],
  ])(
    "a file that calls %s gets no wrap fix anywhere (out of scope: code that rewrites built-ins)",
    (_name, before) => {
      const body = `${before}const T = { a: "x" };\nfunction count() { return 3; }\nexport const out = \`<p>\${process.env.A} \${T.a} \${count()} \${new Date(0).getUTCFullYear()}</p>\`;\n`;
      for (const hole of [
        "${process.env.A}",
        "${T.a}",
        "${count()}",
        "${new Date(0).getUTCFullYear()}",
      ])
        for (const d of diagsAt(body, hole)) {
          expect(d.template?.fixable).toBe(false);
          expect(d.message).toContain(UNPROVEN);
        }
    },
  );

  it.each<[string, string, string, Partial<AnalyzeOptions>?]>([
    [
      "an env value",
      "export const out = `<p>${process.env.HOME}</p>`;\n",
      "${process.env.HOME}",
    ],
    [
      "an env value with a fallback, joined",
      'export const out = `<p>${(process.env.USER ?? "guest") + " here"}</p>`;\n',
      '${(process.env.USER ?? "guest") + " here"}',
    ],
    [
      "a local helper that returns a number",
      "function count() { return 3; }\nexport const out = `<p>${count()}</p>`;\n",
      "${count()}",
    ],
    [
      "a const table read by literal keys",
      'const T = { name: "Milk frother", price: 12 };\nexport const out = `<p>${T.name}</p>`;\n',
      "${T.name}",
    ],
    [
      "a number parameter called with a number",
      "function money(n: number) { return n.toFixed(2); }\nexport const out = `<p>${money(4)}</p>`;\n",
      "${money(4)}",
    ],
    [
      "a number parameter called with Math, arithmetic, a number const and a table number",
      "const base = 2;\nconst T = { price: 12 };\nfunction money(n: number, k: number = 1) { return (n * k).toFixed(2); }\nexport const out = `<p>${money(Math.max(1, 2) * base - 1)} ${money(Number(process.env.P), -3)} ${money(T.price)}</p>`;\n",
      "${money(Math.max(1, 2) * base - 1)}",
    ],
    [
      "a number parameter passed on from another number parameter",
      "function money(n: number) { return n.toFixed(2); }\nfunction row(p: number) { return money(p + 1); }\nexport const out = `<p>${row(3)}</p>`;\n",
      "${row(3)}",
    ],
    [
      "Date and Math results",
      "export const out = `<p>${new Date(0).getUTCFullYear()} ${Math.max(1, 2)}</p>`;\n",
      "${new Date(0).getUTCFullYear()}",
    ],
    [
      "a Date method with a plain locale and an options object",
      'export const out = `<p>${new Date(0).toLocaleDateString("en-US", { month: "long", day: 2 })}</p>`;\n',
      '${new Date(0).toLocaleDateString("en-US", { month: "long", day: 2 })}',
    ],
    [
      "an html value chosen by a condition",
      `${HTML}const h = html\`<b>Hi</b>\`;\nconst on = process.env.ON === "1";\nexport const out = \`<p>\${process.env.A}\${on ? h : ""}</p>\`;\n`,
      "${process.env.A}",
    ],
    [
      "a URL of the request's own URL",
      'export default function (request) { return `<p>${new URL(request.url).searchParams.get("q")}</p>`; }\n',
      '${new URL(request.url).searchParams.get("q")}',
      server,
    ],
    [
      "request data read in a script that hands a header's value on",
      'export default function (request) {\n  const name = request.headers.get("x-name") ?? "-";\n  audit(name);\n  return `<p>${request.method}</p>`;\n}\n',
      "${request.method}",
      server,
    ],
  ])("%s keeps the fix", (_name, body, hole, opts) => {
    for (const d of diagsAt(body, hole, opts ?? { directive: "module" }))
      expect(d.template?.fixable).toBe(true);
  });
});

describe("html helper results bound to a name count like the call itself", () => {
  const codes = (body: string, opts: Partial<AnalyzeOptions> = {}) =>
    analyze(body, { directive: "module", ...opts }).map((d) => d.code);

  // The starter's seo.ts: json() stored in a const, then put in a JSON-LD script.
  const jsonLd = (bind: string) =>
    `${IMPORT}export function jsonLd(data: Record<string, unknown>) {\n  ${bind}\n  return html\`<script type="application/ld+json">\n    \${body}\n  </script>\`;\n}\n`;

  it("a const bound to json() in a JSON script is html's own form", () => {
    const body = jsonLd(
      'const body = json({ "@context": "https://schema.org", ...data });',
    );
    expect(codes(body)).toEqual([]);
    expect(codes(body, { requestTime: true })).toEqual([]);
    expect(
      codes(body.replace("export function jsonLd", "export default function"), {
        directive: "server",
      }),
    ).toEqual([]);
  });

  it("an alias of a json() const, and a never-reassigned let, are followed", () => {
    expect(
      codes(jsonLd("const value = json(data);\n  const body = value;")),
    ).toEqual([]);
    expect(codes(jsonLd("let body = json(data);"))).toEqual([]);
    expect(codes(jsonLd("const body = (json(data));"))).toEqual([]);
  });

  it("a namespace import's json() bound to a const is followed", () => {
    const body = `import * as b from "@bascik/bascik/html";\nexport const ld = (data: object) => {\n  const body = b.json(data);\n  return b.html\`<script type="application/json">\${body}</script>\`;\n};\n`;
    expect(codes(body)).toEqual([]);
  });

  it("misuse: a let reassigned to a plain string is still an error", () => {
    const body = jsonLd(
      'let body = json(data);\n  if (!data.name) body = "{}" + String(data.raw);',
    );
    const diags = analyze(body, { directive: "module" });
    expect(diags.map((d) => d.code)).toEqual([
      "server-script-sink-inline-script",
    ]);
    expect(diags[0].severity).toBe("error");
  });

  it("misuse: a const bound to something else, or to esc(), is still an error", () => {
    for (const bind of [
      "const body = JSON.stringify(data);",
      "const body = esc(String(data));",
      "const body = raw(String(data));",
      "const body = json;",
      "const body = json(data).toString();",
      "const body = data.json(data);",
    ])
      expect(codes(jsonLd(bind)), bind).toEqual([
        "server-script-sink-inline-script",
      ]);
  });

  it("misuse: a json() const in a script that is not JSON is still an error", () => {
    const body = `${IMPORT}export const f = (data: object) => {\n  const body = json(data);\n  return html\`<script>const d = \${body};</script>\`;\n};\n`;
    expect(codes(body)).toEqual(["server-script-sink-inline-script"]);
  });

  it("misuse: json not imported from @bascik/bascik/html is still an error", () => {
    const body = `import { html } from "@bascik/bascik/html";\nimport { json } from "./json.js";\nexport const f = (data: object) => {\n  const body = json(data);\n  return html\`<script type="application/json">\${body}</script>\`;\n};\n`;
    expect(codes(body)).toEqual(["server-script-sink-inline-script"]);
  });

  it("a const bound to esc() inside html`` is html-escaped-twice, like esc() in the hole", () => {
    const body = handler("html`<p>${safe}</p>`", IMPORT).replace(
      "return html",
      "const safe = esc(q);\n  return html",
    );
    const diags = analyze(body).filter((d) => d.code === "html-escaped-twice");
    expect(diags.map((d) => body.slice(d.start, d.end))).toEqual(["${safe}"]);
  });

  it("a let bound to esc() and then to a plain value is not html-escaped-twice", () => {
    const body = handler("html`<p>${safe}</p>`", IMPORT).replace(
      "return html",
      'let safe = esc(q);\n  if (!q) safe = "none";\n  return html',
    );
    expect(analyze(body).map((d) => d.code)).not.toContain(
      "html-escaped-twice",
    );
  });

  it("a const bound to esc() withholds the wrap fix as escaped already", () => {
    const body = handler("`<p>${q}${safe}</p>`", IMPORT).replace(
      "return `",
      "const safe = esc(q);\n  return `",
    );
    const diags = unescaped(body);
    expect(diags.map((d) => body.slice(d.start, d.end))).toEqual(["${q}"]);
    expect(diags[0].template?.fixable).toBe(false);
    expect(diags[0].message).toContain("is escaped already");
    expect(diags[0].message).toContain("without esc()");
  });

  it("a const bound to safeUrl() in a request-time URL attribute is checked", () => {
    const body = handler('`<a href="${u}">x</a>`', IMPORT).replace(
      "return `",
      "const u = esc(safeUrl(q));\n  return `",
    );
    // esc(safeUrl(q)) is exempt; the URL sink accepts safeUrl inside it.
    expect(analyze(body).map((d) => d.code)).toEqual([]);
    const direct = handler('html`<a href="${u}">x</a>`', IMPORT).replace(
      "return html",
      "const u = safeUrl(q);\n  return html",
    );
    expect(analyze(direct).map((d) => d.code)).toEqual([]);
  });

  it("misuse: a let bound to safeUrl() and then to request data is still a URL sink", () => {
    const body = handler('`<a href="${esc(u)}">x</a>`', IMPORT).replace(
      "return `",
      "let u = safeUrl(q);\n  if (q.length > 3) u = q;\n  return `",
    );
    expect(analyze(body).map((d) => d.code)).toEqual([
      "server-script-sink-url-attribute",
    ]);
  });
});

describe("the wrap fix is withheld where the template's value is typed string", () => {
  const H = "${process.env.SITE_NAME}";
  const T = `\`<p class="site">${H}</p>\``;
  const fixable = (body: string, opts: Partial<AnalyzeOptions> = {}) => {
    const found = unescaped(body, { directive: "module", ...opts }).filter(
      (d) => body.slice(d.start, d.end) === H,
    );
    expect(found, body).toHaveLength(1);
    return found[0];
  };

  it.each([
    [
      "a function returning string",
      `function site(): string {\n  return ${T};\n}\n`,
    ],
    [
      "an exported one",
      `export function site(): string {\n  return ${T};\n}\n`,
    ],
    ["an arrow typed string", `const site = (): string => ${T};\n`],
    [
      "an arrow with a block",
      `const site = (): string => {\n  return ${T};\n};\n`,
    ],
    [
      "a union with undefined",
      `function site(): string | undefined {\n  return (${T});\n}\n`,
    ],
    [
      "an async Promise<string>",
      `async function site(): Promise<string> {\n  return ${T};\n}\n`,
    ],
    [
      "a ternary branch",
      `function site(ok: boolean): string {\n  if (ok) {\n    return ok ? ${T} : "";\n  }\n  return "";\n}\n`,
    ],
    [
      "after ||",
      `function site(x?: string): string {\n  return x || ${T};\n}\n`,
    ],
    [
      "a method",
      `class Site {\n  render(): string {\n    return ${T};\n  }\n}\n`,
    ],
    [
      "a getter",
      `const site = {\n  get markup(): string {\n    return ${T};\n  },\n};\n`,
    ],
    ["a const typed string", `const site: string = ${T};\n`],
    ["a let typed string, assigned later", `let site: string;\nsite = ${T};\n`],
    ["a class field", `class Site {\n  markup: string = ${T};\n}\n`],
    [
      "a const then returned as string",
      `function site(): string {\n  const markup = ${T};\n  return markup;\n}\n`,
    ],
    ["as string", `const site = () => ${T} as string;\n`],
    ["satisfies string", `const site = ${T} satisfies string;\n`],
  ])("%s", (_name, body) => {
    const d = fixable(body);
    expect(d.template?.fixable).toBe(false);
    expect(d.message).toContain("SafeHtml");
    expect(d.message).toContain("string");
  });

  it.each([
    ["no annotation", `function site() {\n  return ${T};\n}\n`],
    [
      "SafeHtml",
      `import type { SafeHtml } from "@bascik/bascik/html";\nfunction site(): SafeHtml {\n  return ${T};\n}\n`,
    ],
    [
      "joined to a string",
      `function site(): string {\n  return "<!-- site -->" + ${T};\n}\n`,
    ],
    [
      "an argument of a call",
      `function site(): string {\n  return String(${T});\n}\n`,
    ],
    [
      "an inner callback's return",
      `function site(): string {\n  const parts = [1].map(() => {\n    return ${T};\n  });\n  return String(parts.length);\n}\n`,
    ],
    [
      "a string in an if condition",
      `function site(): string {\n  if (${T}) return "x";\n  return "";\n}\n`,
    ],
    [
      "a nested template",
      `function site(): string {\n  return \`<div>\${${T}}</div>\`;\n}\n`,
    ],
    [
      "a const used as a number elsewhere",
      `const markup = ${T};\nexport const size: number = 1;\n`,
    ],
    [
      "an object property typed elsewhere",
      `const box: { markup: unknown } = { markup: ${T} };\n`,
    ],
  ])("keeps the fix: %s", (_name, body) => {
    expect(fixable(body).template?.fixable).toBe(true);
  });

  it("names the annotation in the message", () => {
    const d = fixable(`export const page = (): string | null => ${T};\n`);
    expect(d.message).toBe(
      'This markup template (line 1) interpolates ${process.env.SITE_NAME} (hole 1) without html. Wrapping this template in html is not offered as a fix: its value goes where the code declares `: string | null`, and html makes a SafeHtml value, so type checking would fail. Change that type to SafeHtml (import type { SafeHtml } from "@bascik/bascik/html"), then wrap the template in html`...` from @bascik/bascik/html yourself.',
    );
  });
});
