/**
 * What a server or stream script's return value prints (prompt 158 R3-04,
 * F060). The helper is portable: Node's runServerScriptJob and the
 * Cloudflare Worker's job runner both classify a return with it, so the two
 * hosts print the same bytes and report the same mistake the same way.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  serverScriptOutput,
  serverScriptOutputErrorMessage,
  type ServerScriptOutputError,
} from "./server-script-output.ts";
import { html, json, raw } from "./html-template.ts";

const text = (value: unknown): string => {
  const result = serverScriptOutput(value);
  if (result.error) throw new Error(`expected text, got ${result.error.kind}`);
  return result.text;
};

const error = (value: unknown): ServerScriptOutputError => {
  const result = serverScriptOutput(value);
  if (!result.error) throw new Error(`expected an error, got "${result.text}"`);
  return result.error;
};

describe("serverScriptOutput: values that print", () => {
  it("a string is the markup as it is (a server script returns markup, nothing is escaped)", () => {
    expect(text("<p>Milk frother</p>")).toBe("<p>Milk frother</p>");
    expect(text("")).toBe("");
  });

  it("a string that holds regex replacement tokens is kept byte for byte", () => {
    expect(text("$1 $& $` $' $$")).toBe("$1 $& $` $' $$");
  });

  it("a number, bigint or true is its text, as html prints it", () => {
    expect(text(42)).toBe("42");
    expect(text(0)).toBe("0");
    expect(text(-1.5)).toBe("-1.5");
    expect(text(Number.NaN)).toBe("NaN");
    expect(text(12n)).toBe("12");
    expect(text(true)).toBe("true");
  });

  it("null, undefined and false print nothing, as in an html hole", () => {
    expect(text(null)).toBe("");
    expect(text(undefined)).toBe("");
    expect(text(false)).toBe("");
  });

  it("an html`...` or raw() value is its markup", () => {
    expect(text(html`<li>${"a<b"}</li>`)).toBe("<li>a&lt;b</li>");
    expect(text(raw("<b>bold</b>"))).toBe("<b>bold</b>");
  });

  it("a json() value is its text", () => {
    expect(text(json({ q: "</script>" }))).toBe(
      String(json({ q: "</script>" })),
    );
  });

  it("an html value from another copy of the module (a registered symbol brand) is its markup", () => {
    const foreign = Object.freeze({
      [Symbol.for("bascik.html")]: "<i>other copy</i>",
    });
    expect(text(foreign)).toBe("<i>other copy</i>");
  });

  it("an array of strings is joined with no separator, so .map needs no .join", () => {
    const items = ["Milk frother", "Kettle"];
    expect(text(items.map((name) => `<li>${name}</li>`))).toBe(
      "<li>Milk frother</li><li>Kettle</li>",
    );
  });

  it("an array of html values is joined with no separator", () => {
    const items = [{ name: "a<" }, { name: "b&" }];
    expect(text(items.map((p) => html`<li>${p.name}</li>`))).toBe(
      "<li>a&lt;</li><li>b&amp;</li>",
    );
  });

  it("nested arrays are flattened in order", () => {
    expect(text(["<a>", ["<b>", ["<c>", html`<d></d>`]], "<e>"])).toBe(
      "<a><b><c><d></d><e>",
    );
  });

  it("null, undefined and false items are holes that print nothing, as in an html hole", () => {
    expect(text(["<a>", null, undefined, false, "<b>"])).toBe("<a><b>");
    // A sparse array's holes too.
    const sparse = ["<a>", , "<b>"];
    expect(text(sparse)).toBe("<a><b>");
  });

  it("number, bigint and true items are their text", () => {
    expect(text([1, 2n, true, "x"])).toBe("12truex");
  });

  it("an empty array prints nothing", () => {
    expect(text([])).toBe("");
    expect(text([[], [[]]])).toBe("");
  });

  it("an object with its own toString (a Date, a URL, a class) is that text, as before", () => {
    const url = new URL("https://example.com/frother");
    expect(text(url)).toBe("https://example.com/frother");
    class Price {
      toString() {
        return "<b>$9.99</b>";
      }
    }
    expect(text(new Price())).toBe("<b>$9.99</b>");
    const date = new Date(0);
    expect(text(date)).toBe(String(date));
  });
});

describe("serverScriptOutput: values that are a mistake (misuse lens)", () => {
  it("a Promise (a forgotten await) is a promise error, never [object Promise]", () => {
    const e = error(Promise.resolve("<p>late</p>"));
    expect(e.kind).toBe("promise");
    expect(e.received).toBe("a Promise");
  });

  it("a thenable that is not a native Promise is a promise error too", () => {
    expect(error({ then: () => undefined }).kind).toBe("promise");
  });

  it("an async .map (an array of Promises) names the first Promise's index", () => {
    const e = error(["<a>", Promise.resolve("<b>")]);
    expect(e.kind).toBe("promise");
    expect(e.received).toBe("an array holding a Promise at [1]");
  });

  it("a Response (the API-route habit) is a response error", () => {
    const e = error(new Response("<p>x</p>"));
    expect(e.kind).toBe("response");
    expect(e.received).toBe("a Response");
  });

  it("a plain object is an object error, never [object Object]", () => {
    const e = error({ name: "Milk frother" });
    expect(e.kind).toBe("object");
    expect(e.received).toBe("an object ([object Object])");
  });

  it("a Map, a Set and a null-prototype object are object errors", () => {
    expect(error(new Map()).received).toBe("an object ([object Map])");
    expect(error(new Set()).kind).toBe("object");
    const bare = Object.create(null) as object;
    const e = error(bare);
    expect(e.kind).toBe("object");
    expect(e.received).toBe("an object that cannot be converted to text");
  });

  it("an object whose toString throws a TypeError is an object error; any other throw from the author's code passes through", () => {
    expect(error({ toString: "x" }).kind).toBe("object");
    const boom = new Error("author's own bug");
    expect(() =>
      serverScriptOutput({
        toString() {
          throw boom;
        },
      }),
    ).toThrow(boom);
  });

  it("a returned Error (catch (e) { return e; }) is an error error, so its message never reaches the visitor", () => {
    const e = error(new Error("db password rejected for user admin"));
    expect(e.kind).toBe("error");
    expect(e.received).toBe("an Error (Error)");
    expect(error(new TypeError("x")).received).toBe("an Error (TypeError)");
    class LookupError extends Error {
      override name = "LookupError";
      override toString() {
        return "custom";
      }
    }
    // Its own toString does not make an Error markup.
    expect(error(new LookupError("y")).received).toBe("an Error (LookupError)");
    expect(error(["<a>", new RangeError("z")]).received).toBe(
      "an array holding an Error (RangeError) at [1]",
    );
  });

  it("a function (a forgotten call) is a function error", () => {
    const e = error(() => "<p>never called</p>");
    expect(e.kind).toBe("function");
    expect(e.received).toBe("a function");
  });

  it("a symbol is a symbol error", () => {
    const e = error(Symbol("x"));
    expect(e.kind).toBe("symbol");
    expect(e.received).toBe("a symbol");
  });

  it("an object nested in an array names its index path", () => {
    const e = error(["<a>", ["<b>", { name: "x" }]]);
    expect(e.kind).toBe("object");
    expect(e.received).toBe(
      "an array holding an object ([object Object]) at [1][1]",
    );
  });

  it("an array that contains itself is an array-depth error, not a stack overflow", () => {
    const loop: unknown[] = ["<a>"];
    loop.push(loop);
    const e = error(loop);
    expect(e.kind).toBe("array-depth");
  });

  it("an array nested more than 1000 levels is an array-depth error; 1000 levels print", () => {
    const nest = (levels: number): unknown => {
      let value: unknown = "<x>";
      for (let i = 0; i < levels; i++) value = [value];
      return value;
    };
    expect(text(nest(1000))).toBe("<x>");
    expect(error(nest(1001)).kind).toBe("array-depth");
  });
});

describe("serverScriptOutputErrorMessage", () => {
  const url = "http://localhost/catalog?q=1";

  it("names the route, the script and the received type, in the frame every server-script error uses", () => {
    const message = serverScriptOutputErrorMessage(
      error(Promise.resolve("")),
      url,
      "server script in src/pages/catalog.html:12",
    );
    expect(message).toMatch(
      /^\[bascik\] server script error at "\/catalog":\n/,
    );
    expect(message).toContain(
      "The server script in src/pages/catalog.html:12 returned a Promise",
    );
    expect(message).toContain("await");
    expect(message).not.toContain("[object Promise]");
  });

  it("gives each kind its own fix", () => {
    const where = "stream script in src/pages/x.html:3";
    expect(
      serverScriptOutputErrorMessage(
        error(["", Promise.resolve("")]),
        url,
        where,
      ),
    ).toContain("Promise.all");
    expect(
      serverScriptOutputErrorMessage(error(new Response("")), url, where),
    ).toContain("API route");
    expect(serverScriptOutputErrorMessage(error({}), url, where)).toContain(
      "html`",
    );
    expect(
      serverScriptOutputErrorMessage(
        error(() => ""),
        url,
        where,
      ),
    ).toContain("Call it");
    expect(
      serverScriptOutputErrorMessage(error(new Error("x")), url, where),
    ).toContain("throw it");
  });

  it("without an owner the message still reads", () => {
    expect(
      serverScriptOutputErrorMessage(error(Symbol("s")), url, undefined),
    ).toContain("The script returned a symbol");
  });

  it("the production form says the slot is empty and that it is logged once", () => {
    const message = serverScriptOutputErrorMessage(
      error({}),
      url,
      "server script in src/pages/x.html:3",
      { production: true },
    );
    expect(message).toContain("The slot is empty");
    expect(message).toContain("once");
  });
});

describe("server-script-output module", () => {
  it("is portable: no node: imports (the Worker classifies with it)", () => {
    const source = readFileSync(
      new URL("./server-script-output.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/from\s+["']node:/);
    expect(source).not.toMatch(/from\s+["']\.\/config/);
  });
});
