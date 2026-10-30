/**
 * Every timeout a troubleshooting heading quotes is a message Bascik prints.
 *
 * A reader searches the page for the line in their terminal, so a heading
 * that quotes a message no code path prints (a build script reported as
 * `Script execution timed out after 30000ms`, the request-time message,
 * once) sends them to the wrong entry. Each quoted timeout in a heading must
 * be a rendering, or the start of one, of a string literal in pkg/src, with
 * an interpolation standing for any text. The heading under "Build scripts"
 * must quote the message a build script's timeout prints.
 *
 * Misuse lens: a heading that quotes the message of another script kind, a
 * number or path where the source interpolates one, a heading that quotes
 * only the start of a message, and a message reworded in the source.
 */
import { describe, it, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const DOCS_ROOT = path.resolve(import.meta.dirname, "../..");
const PKG_SRC = path.resolve(DOCS_ROOT, "../pkg/src");
const TROUBLESHOOTING = path.join(
  DOCS_ROOT,
  "content/testing/troubleshooting.md",
);

/** A source string as literal characters and interpolations. */
type Token = { text: string } | { interpolation: true };

/** The string literals in a TypeScript source, template literals included. */
const stringLiterals = (source: string): Token[][] => {
  const found: Token[][] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    // Comments may quote messages loosely; they are not what is printed.
    if (ch === "/" && source[i + 1] === "/") {
      i = source.indexOf("\n", i);
      if (i === -1) break;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (ch !== '"' && ch !== "'" && ch !== "`") {
      i++;
      continue;
    }
    const tokens: Token[] = [];
    i++;
    while (i < source.length && source[i] !== ch) {
      if (source[i] === "\\") {
        tokens.push({ text: source[i + 1] });
        i += 2;
      } else if (ch === "`" && source[i] === "$" && source[i + 1] === "{") {
        // Skip the expression, nested braces included.
        let depth = 1;
        i += 2;
        while (i < source.length && depth > 0) {
          if (source[i] === "{") depth++;
          else if (source[i] === "}") depth--;
          i++;
        }
        tokens.push({ interpolation: true });
      } else if (ch !== "`" && source[i] === "\n") {
        break; // not a string after all (a stray quote in a regex)
      } else {
        tokens.push({ text: source[i] });
        i++;
      }
    }
    i++;
    found.push(tokens);
  }
  return found;
};

const sourceFiles = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
    else if (
      /\.ts$/.test(entry.name) &&
      !/\.test(?:-helper)?\.ts$/.test(entry.name)
    )
      out.push(full);
  }
  return out;
};

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether `quoted` is `tokens` with each interpolation replaced by some text,
 * or the start of such a rendering, and optionally without the source's
 * leading `[bascik] ` (the entries quote what follows it). A `...` in the
 * quote stands for text the heading leaves out.
 */
const renders = (quoted: string, tokens: Token[]): boolean => {
  const prefix = "[bascik] ";
  const literalStart = tokens
    .slice(0, prefix.length)
    .map((t) => ("text" in t ? t.text : "\u0000"))
    .join("");
  if (literalStart === prefix && renders(quoted, tokens.slice(prefix.length)))
    return true;
  const body = quoted.split("...").map(escape).join("[\\s\\S]*?");
  for (let end = tokens.length; end > 0; end--) {
    // A start of the message ends in its own text: one ending in an
    // interpolation would accept anything after it.
    if (end < tokens.length && "interpolation" in tokens[end - 1]) continue;
    // An interpolated value in a heading is a path, a number or a name.
    const pattern = tokens
      .slice(0, end)
      .map((token) => ("interpolation" in token ? "\\S+?" : escape(token.text)))
      .join("");
    const source = new RegExp(`^${pattern}$`);
    // Compare both ways: the heading against the source's pattern, with the
    // heading's own `...` as a wildcard for any source text.
    if (source.test(quoted)) return true;
    const literal = tokens
      .slice(0, end)
      .map((token) => ("interpolation" in token ? "\u0000" : token.text))
      .join("");
    if (
      quoted.includes("...") &&
      new RegExp(`^${body}$`).test(literal.replace(/\u0000/g, "..."))
    )
      return true;
  }
  return false;
};

/** The code spans in each `##`-`####` heading, with the section it is in. */
const headingQuotes = (markdown: string) => {
  const quotes: { section: string; heading: string; quoted: string }[] = [];
  let section = "";
  for (const line of markdown.split("\n")) {
    const heading = /^(#{2,4})\s+(.*)$/.exec(line);
    if (!heading) continue;
    if (heading[1] === "##") section = heading[2];
    for (const span of heading[2].matchAll(/(`+)\s?([\s\S]+?)\s?\1/g))
      quotes.push({ section, heading: heading[2], quoted: span[2] });
  }
  return quotes;
};

const timeoutMessages = async (): Promise<
  { file: string; tokens: Token[] }[]
> => {
  const messages: { file: string; tokens: Token[] }[] = [];
  for (const file of await sourceFiles(PKG_SRC)) {
    const source = await readFile(file, "utf8");
    for (const tokens of stringLiterals(source)) {
      const literal = tokens
        .map((t) => ("interpolation" in t ? "" : t.text))
        .join("");
      if (literal.includes("timed out"))
        messages.push({ file: path.relative(PKG_SRC, file), tokens });
    }
  }
  return messages;
};

describe("the matcher (self-checks)", () => {
  const tokens = stringLiterals(
    'const m = `[bascik] exec "${scriptPath}" timed out after ${timeoutMs}ms`;',
  )[0];

  it("accepts a rendering with values in the interpolations, without the [bascik] prefix", () => {
    expect(
      renders('exec "scripts/gen.ts" timed out after 30000ms', tokens),
    ).toBe(true);
  });

  it("accepts the start of a message", () => {
    expect(renders('exec "scripts/gen.ts" timed out', tokens)).toBe(true);
  });

  it("misuse: rejects a reworded message and text where the source has none", () => {
    expect(renders('exec "scripts/gen.ts" timed out at 30000ms', tokens)).toBe(
      false,
    );
    expect(renders("Script execution timed out after 30000ms", tokens)).toBe(
      false,
    );
  });

  it("skips comments and reads escapes", () => {
    const found = stringLiterals(
      '// \'Script execution timed out in a comment\'\nconst a = "say \\"timed out\\"";',
    );
    expect(found).toHaveLength(1);
    expect(found[0].map((t) => ("text" in t ? t.text : "")).join("")).toBe(
      'say "timed out"',
    );
  });
});

describe("troubleshooting: quoted timeout messages", () => {
  it("every timeout a heading quotes is a message pkg/src prints", async () => {
    const markdown = await readFile(TROUBLESHOOTING, "utf8");
    const quotes = headingQuotes(markdown).filter((q) =>
      q.quoted.includes("timed out"),
    );
    expect(quotes.length).toBeGreaterThanOrEqual(3);
    const messages = await timeoutMessages();
    const unmatched = quotes
      .filter((q) => !messages.some((m) => renders(q.quoted, m.tokens)))
      .map((q) => `${q.section} > ${q.heading}`);
    expect(unmatched).toEqual([]);
  });

  it("misuse: the Build scripts timeout heading quotes the build script's own message, not the request-time one", async () => {
    const markdown = await readFile(TROUBLESHOOTING, "utf8");
    const build = headingQuotes(markdown).filter(
      (q) => q.section === "Build scripts" && q.quoted.includes("timed out"),
    );
    expect(build).toHaveLength(1);
    const runner = await readFile(
      path.join(PKG_SRC, "lib/handler-runner.ts"),
      "utf8",
    );
    const directive = stringLiterals(runner).filter((tokens) =>
      tokens
        .map((t) => ("text" in t ? t.text : "\u0000"))
        .join("")
        .startsWith("Directive script (data-bascik-\u0000) timed out after"),
    );
    expect(
      directive,
      "the directive timeout in handler-runner.ts",
    ).toHaveLength(1);
    expect(build[0].quoted).toMatch(/^Directive script \(data-bascik-build\)/);
    expect(renders(build[0].quoted, directive[0])).toBe(true);
  });
});
