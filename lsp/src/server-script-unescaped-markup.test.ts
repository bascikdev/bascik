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

describe("server-script-unescaped-markup: build-time code (build, routes, module)", () => {
  const build = (
    body: string,
    directive: "build" | "routes" | "module" = "build",
  ) => analyze(body, { directive });
  const codes = (body: string, directive?: "build" | "routes" | "module") =>
    build(body, directive).map((d) => d.code);

  it("a Prettier-wrapped build script returning plain template markup: one warning per hole, with the fix", () => {
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
    expect(diags.every((d) => d.template?.fixable)).toBe(true);
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
    expect(diags[0].template?.fixable).toBe(false);
    expect(diags[1].template?.fixable).toBe(true);
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
    const body = 'export const p = (t: string) => `<p class="x">${t}</p>`;\n';
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
      'export const c = (x: string) => `<li class="item">${x}</li>`;',
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

  it("a package's function and a local function keep the fix", () => {
    expect(
      diagsOf(
        'import slugify from "slugify";\nexport default (t) => `<main>${slugify(t)}</main>`;',
      )[0].template?.fixable,
    ).toBe(true);
    expect(
      diagsOf(
        "const upper = (s) => s.toUpperCase();\nexport default (t) => `<main>${upper(t)}</main>`;",
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
          "const item = (t: string) => html`<li>${t}</li>`;\nexport const list = (title: string, x: string) => `<ul>${item(title)}${x}</ul>`;",
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
    ["a parameter", "export const g = (t: string) => `<p>${t}</p>`;", "${t}"],
    [
      "a local helper with no markup",
      "const upper = (s: string) => s.toUpperCase();\nexport const g = (t: string) => `<p>${upper(t)}</p>`;",
      "${upper(t)}",
    ],
    [
      "a local helper that builds its markup with html",
      'import { html } from "@bascik/bascik/html";\nconst item = (t: string) => html`<li>${t}</li>`;\nexport const g = (t: string, x: string) => `<ul>${item(t)}${x}</ul>`;',
      "${x}",
    ],
    [
      "a name bound to plain data",
      'export const g = (p: { n: string }) => { const label = p.n.trim() + " (new)"; return `<p>${label}</p>`; };',
      "${label}",
    ],
    [
      "a property of a parameter",
      "export const g = (p: { title: string }) => `<h2>${p.title}</h2>`;",
      "${p.title}",
    ],
  ])("%s keeps the fix", (_name, body, hole) => {
    expect(fixableAt(body, hole).fixable).toBe(true);
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
      "const ICONS2: Record<string, string> = { ok: '<svg class=\"ok\"></svg>' };\nexport function st2(s: string, l: string) { return `<td>${ICONS2[s]}${l}</td>`; }",
      "${l}",
      "ICONS2",
    ],
    [
      "a typed let accumulator",
      'let out: string = "";\nexport function e(t: string) { out += `<li>${t}</li>`; return `<ul>${out}</ul>`; }',
      "${out}",
      "out",
    ],
    [
      "a typed let declared without a value",
      "let out: string;\nexport function e(t: string) { out = `<li>${t}</li>`; return `<ul>${out}</ul>`; }",
      "${out}",
      "out",
    ],
    [
      "a typed markup constant",
      'const sep: string = "<br>";\nexport function f(a: string) { return `<p>${a}${sep}</p>`; }',
      "${a}",
      "sep",
    ],
    [
      "a typed array of markup strings",
      'export function e(items: string[]) { const lis: string[] = items.map((i) => "<li>" + i + "</li>"); return `<ul>${lis}</ul>`; }',
      "${lis}",
      "lis",
    ],
    [
      "an arrow with a function type annotation",
      'const ital: (t: string) => string = (t) => "<i>" + t + "</i>";\nexport function c(t: string) { return `<p>${ital(t)}</p>`; }',
      "${ital(t)}",
      "ital",
    ],
    [
      "a typed arrow with a generic annotation",
      'const b: Map<string, () => string> = new Map([["a", () => "<b>x</b>"]]);\nexport function c(t: string) { return `<p>${b.get(t)}</p>`; }',
      "${b.get(t)}",
      "b",
    ],
    [
      "a destructured binding",
      "const { icon } = { icon: '<svg class=\"i\"></svg>' };\nexport function c(t: string) { return `<p>${icon}${t}</p>`; }",
      "${t}",
      "icon",
    ],
    [
      "an array destructured binding",
      "const [first] = ['<svg class=\"i\"></svg>'];\nexport function c(t: string) { return `<p>${first}${t}</p>`; }",
      "${t}",
      "first",
    ],
    [
      "a parameter a local call fills with a markup string",
      'function layout(title: string, body: string) { return `<main><h1>${title}</h1>${body}</main>`; }\nexport const home = layout("Home", "<p>Welcome</p>");',
      "${title}",
      "body",
    ],
    [
      "a parameter a local call fills with a markup template",
      'function layout(title: string, body: string) { return `<main><h1>${title}</h1>${body}</main>`; }\nexport function page(y: string) { return layout("Home", `<p>${y}</p>`); }',
      "${title}",
      "body",
    ],
    [
      "a callback parameter",
      'export function wrap(render: () => string) { return `<div class="w">${render()}</div>`; }',
      "${render()}",
      "render",
    ],
    [
      "a function imported from a package",
      'import { marked } from "marked";\nexport function post(md: string, t: string) { return `<article><h1>${t}</h1>${marked(md)}</article>`; }',
      "${t}",
      "marked",
    ],
    [
      "a file read",
      'import fs from "node:fs";\nexport function withHeader(c: string) { const header = fs.readFileSync("partials/header.html", "utf8"); return `<body>${header}<p>${c}</p></body>`; }',
      "${c}",
      "header",
    ],
    [
      "a file read in the hole",
      'import { readFileSync } from "node:fs";\nexport function withHeader(c: string) { return `<body>${readFileSync("h.html", "utf8")}<p>${c}</p></body>`; }',
      "${c}",
      "readFileSync",
    ],
    [
      "a fetched response's text",
      'export async function part(c: string) { const res = await fetch("https://example.com/p"); const body = await res.text(); return `<div>${body}<p>${c}</p></div>`; }',
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
      'export const g = (p: { n: string }) => { const label: string = p.n.trim() + " (new)"; return `<p>${label}</p>`; };',
      "${label}",
    ],
    [
      "a parameter local calls fill with plain data",
      'function heading(title: string) { return `<h1>${title}</h1>`; }\nexport const home = heading("Home");\nexport const about = heading(`About ${"us"}`);',
      "${title}",
    ],
    [
      "a global conversion call",
      "export const g = (n: string) => `<p>${String(n)} ${encodeURIComponent(n)}</p>`;",
      "${String(n)}",
    ],
    [
      "a local helper with no markup, typed",
      "const upper: (s: string) => string = (s) => s.toUpperCase();\nexport const g = (t: string) => `<p>${upper(t)}</p>`;",
      "${upper(t)}",
    ],
  ])("%s keeps the fix", (_name, body, hole) => {
    expect(fixableAt(body, hole).fixable).toBe(true);
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
