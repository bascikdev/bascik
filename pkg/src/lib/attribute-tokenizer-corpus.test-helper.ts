/**
 * One corpus of start-tag attribute text for every attribute tokenizer in
 * the repo (R2-05-c): pkg's html-scanner, component-attribute-scan,
 * styles.ts quotedAttributeValueRanges, id-references, the language
 * server's readers and the bascik skill's markup.mjs. Each case is the text
 * after the tag name, up to (not including) the closing `>`.
 *
 * The oracle is parse5, a spec-compliant tokenizer. Values here hold no
 * character references, so parse5's decoded values equal the raw text the
 * tokenizers return. Test-only; never imported by production code.
 */
import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";

export interface AttributeCase {
  /** What the case exercises. */
  name: string;
  /** Attribute text after the tag name. */
  attrs: string;
}

export const ATTRIBUTE_CORPUS: readonly AttributeCase[] = [
  { name: "double and single quotes", attrs: ` a="1" b='2'` },
  { name: "unquoted values", attrs: ` a=1 b=2` },
  { name: "whitespace around =", attrs: ` a = "1"  b =  '2'` },
  { name: "unquoted value, spaces around =", attrs: ` a = 1` },
  { name: "bare attribute", attrs: ` disabled a="1"` },
  { name: "empty quoted values", attrs: ` a="" b=''` },
  { name: "= with no value before >", attrs: ` a=` },
  { name: "quoted value then />", attrs: ` a="1"/` },
  { name: "unquoted value then /> keeps the slash", attrs: ` src=x.png/` },
  { name: "unquoted value ending in a slash", attrs: ` a=x/` },
  { name: "> inside a quoted value", attrs: ` a="x>y" b=2` },
  { name: "the other quote inside a value", attrs: ` a='it"s' b="it's"` },
  { name: "apostrophe in an unquoted value", attrs: ` title=it's b=2` },
  { name: "double quote in an unquoted value", attrs: ` a=x"y b=2` },
  { name: "= in an unquoted value", attrs: ` a=x=y` },
  { name: "backtick unquoted value", attrs: " a=`x`" },
  { name: "< in an unquoted value", attrs: ` a=<b` },
  { name: "backslash before the closing quote", attrs: ` a="c:\\" b="d"` },
  { name: "backslash in an unquoted value", attrs: ` a=b\\ c=d` },
  { name: "= inside a quoted value", attrs: ` a="x" b="y=z" c` },
  { name: "attribute-like text inside a quoted value", attrs: ` b=" a=foo"` },
  {
    name: "quoted attribute-like text, then the real one",
    attrs: ` b=' a="q" ' a=r`,
  },
  { name: "duplicate name, other case (first wins)", attrs: ` a="1" A="2"` },
  { name: "no whitespace after a quoted value", attrs: ` a="1"b="2"` },
  { name: "slash between attributes", attrs: ` a="1"/ b="2"` },
  { name: "slash before the first attribute", attrs: ` /a="1"` },
  { name: "newline inside a quoted value", attrs: ` a="x\ny"` },
  { name: "tab and form feed separators", attrs: `\ta="1"\fb="2"` },
  {
    name: "Prettier: one attribute per line, > on its own line",
    attrs: `\n  a="1"\n  b="2"\n`,
  },
  { name: "Prettier: /> on its own line", attrs: `\n  a="1"\n/` },
  { name: "class list and unquoted id", attrs: ` class="a b" id=c` },
  { name: "no-break space in an unquoted value", attrs: ` a=x\u00a0y` },
  { name: "no-break space inside a name", attrs: ` a\u00a0b="1"` },
];

/** The attributes the browser's tokenizer reads from `<x-t{attrs}>`, as [name, value] pairs. */
export const browserAttributes = (attrs: string): Array<[string, string]> => {
  const element = parseFragment(`<x-t${attrs}>`)
    .childNodes[0] as DefaultTreeAdapterTypes.Element;
  return element.attrs.map((attr) => [attr.name, attr.value]);
};

/**
 * `attrs` with every attribute-name token `a` (any case) renamed to `name`,
 * for tokenizers that only read one attribute (`for`, `id`). The oracle runs
 * on the renamed text too, so a token renamed inside a quoted value is fine.
 */
export const renameA = (attrs: string, name: string): string =>
  attrs.replace(
    /(^|[^\w-])[aA](?=[\t\n\f\r =\u00a0])/g,
    (_, before) => before + name,
  );

/** The first occurrence of each name, as the tokenizer keeps them. */
export const firstOfEachName = (
  pairs: Array<[string, string]>,
): Array<[string, string]> => {
  const seen = new Set<string>();
  return pairs.filter(([name]) =>
    seen.has(name) ? false : (seen.add(name), true),
  );
};
