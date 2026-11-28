// This file is kept byte for byte the same in `pkg/src/lib/` and `lsp/src/`: the compiler and the language server
// cannot import each other, and both must give one verdict. `docs/scripts/compat-matcher-parity.test.ts` compares
// the two copies. It imports nothing, so the same text works in both packages.

/** One selector of a style rule: an item of the comma-separated list before a `{`. */
export interface CssSelector {
  /** Where the selector starts in the scanned text, after the comma or brace before it. */
  start: number;
  /** Where it ends: the offset of the comma or `{` that follows it. */
  end: number;
  /**
   * Where the selector list this selector belongs to starts: the first character of its first selector. An ignore
   * comment on the line above the list covers every selector of the list, however the list is wrapped.
   */
  listStart: number;
  /**
   * Whether a scoped class stands at the top level of the selector (outside parentheses and brackets), or the
   * rule it is nested in is anchored. Such a selector cannot match outside the component.
   */
  hasAnchor: boolean;
  /**
   * The offset from which the selector is past an anchor and a combinator (`.card ` in `.card :is(p)`), or -1
   * when it never is. A compound that starts at or after this offset is a relative of an anchored element.
   */
  anchoredFrom: number;
  /**
   * Whether the selector is nested, without `&`, in a rule that is not itself led by a standalone attribute
   * selector. It then continues its parent (`#panel { [open] {} }` means `#panel [open]`), so its first compound
   * is not the start of a selector.
   */
  followsParent: boolean;
  /**
   * The top-level compounds that hold a scoped class or `&`, as pairs of offsets: the class (or `&`), then the
   * end of its compound. Read them with `hasClassBeforeInCompound`.
   */
  classSpans: number[];
}

/** A block that is open at the scan position, and what it means for a rule nested directly in it. */
interface OpenBlock {
  /** A style rule is open here or further out, so a selector here is a nested one. */
  inStyleRule: boolean;
  /** Every selector around is anchored on a scoped class. */
  anchored: boolean;
  /** A selector around starts with an attribute selector and has no scoped class. */
  attributeLed: boolean;
}

/** End of the quoted string that opens at `start`, past its closing quote, or -1 when it never closes. */
function closeQuoted(text: string, start: number, quote: string): number {
  for (let j = start + 1; j < text.length; j++) {
    const c = text[j];
    if (c === "\\") j++;
    else if (c === quote) return j + 1;
  }
  return -1;
}

const isClassStart = (text: string, dot: number): boolean => {
  const next = text[dot + 1];
  if (next === undefined) return false;
  if (/[A-Za-z_]/.test(next)) return true;
  return next === "-" && /[A-Za-z_-]/.test(text[dot + 2] ?? "");
};

/**
 * Every selector of every style rule in `css`, in source order, with whether a scoped class anchors it. Pass text
 * whose comments are already blanked out (`maskComments`); offsets are offsets into that text.
 *
 * A selector is read whole, from the brace, semicolon, or comma before it to the comma or `{` after it, so one
 * that a formatter wraps over several lines is the same selector as the one-line form. Strings, parentheses, and
 * brackets hide the commas and braces inside them. Declarations and at-rule preludes (`@media (...)`) are not
 * selectors and are left out; the rules inside `@media`, `@supports`, `@container`, and `@layer` blocks are read
 * like top-level ones. A nested rule is a relative of its parent: `.card { [open] {} }` means `.card [open]`.
 *
 * One pass over the text. An unclosed quote or `url(` is remembered and read as plain text, so the scan stays
 * linear on text an editor sends mid-edit, and a brace always opens or closes a block, so an unclosed
 * parenthesis hides at most the rest of its own rule.
 */
export function findCssSelectors(css: string): CssSelector[] {
  const selectors: CssSelector[] = [];
  const blocks: OpenBlock[] = [
    { inStyleRule: false, anchored: false, attributeLed: false },
  ];
  const unclosedQuotes = new Set<string>();
  let noClosingParen = false;

  // The statement being read: a declaration, an at-rule, or the selector list of a style rule.
  let pending: CssSelector[] = [];
  let pendingAttributeLed = false;
  let listStart = 0;
  let sawContent = false;
  let isAtRule = false;
  let parens = 0;
  let inBrackets = false;
  // The selector being read, an item of that list.
  let selectorStart = 0;
  let selectorLead = "";
  let classSpans: number[] = [];
  let compoundAnchor = -1;
  let firstClass = -1;
  let gapAfterClass = -1;
  let firstNesting = -1;
  let gapAfterNesting = -1;
  let hasNesting = false;

  const startSelector = (at: number) => {
    selectorStart = at;
    selectorLead = "";
    classSpans = [];
    compoundAnchor = -1;
    firstClass = -1;
    gapAfterClass = -1;
    firstNesting = -1;
    gapAfterNesting = -1;
    hasNesting = false;
  };
  const startStatement = (at: number) => {
    pending = [];
    pendingAttributeLed = false;
    listStart = at;
    sawContent = false;
    isAtRule = false;
    parens = 0;
    inBrackets = false;
    startSelector(at);
  };
  // Ends the compound being read: a class or `&` in it stands before everything up to `at`.
  const endCompound = (at: number) => {
    if (compoundAnchor >= 0) classSpans.push(compoundAnchor, at);
    compoundAnchor = -1;
  };
  const endSelector = (end: number) => {
    endCompound(end);
    const block = blocks[blocks.length - 1];
    // No `&` in a nested rule: the whole selector is a descendant of the parent.
    const continuesParent = block.inStyleRule && !hasNesting;
    let hasAnchor: boolean;
    let anchoredFrom: number;
    if (block.anchored && !hasNesting) {
      hasAnchor = true;
      anchoredFrom = selectorStart;
    } else {
      // `&` stands for the parent, so it anchors only when the parent is anchored.
      const nestingAnchors = block.anchored && firstNesting >= 0;
      const gaps = [
        gapAfterClass,
        nestingAnchors ? gapAfterNesting : -1,
      ].filter((gap) => gap >= 0);
      hasAnchor = firstClass >= 0 || nestingAnchors;
      anchoredFrom = gaps.length > 0 ? Math.min(...gaps) : -1;
    }
    // `[a] { [b] {} }`: the nested selector is led by attribute selectors only, as its parent is.
    if (
      !hasAnchor &&
      selectorLead === "[" &&
      (!continuesParent || block.attributeLed)
    ) {
      pendingAttributeLed = true;
    }
    pending.push({
      start: selectorStart,
      end,
      listStart,
      hasAnchor,
      anchoredFrom,
      followsParent: continuesParent && !block.attributeLed,
      classSpans,
    });
  };

  let i = 0;
  while (i < css.length) {
    const c = css[i];
    if (c === '"' || c === "'") {
      if (!sawContent) listStart = i;
      sawContent = true;
      if (selectorLead === "") selectorLead = c;
      if (!unclosedQuotes.has(c)) {
        const end = closeQuoted(css, i, c);
        if (end >= 0) {
          i = end;
          continue;
        }
        unclosedQuotes.add(c);
      }
      i++;
      continue;
    }
    const atTopLevel = parens === 0 && !inBrackets;
    if (c === " " || c === "\n" || c === "\t" || c === "\r" || c === "\f") {
      if (atTopLevel) {
        endCompound(i);
        if (firstClass >= 0 && gapAfterClass < 0) gapAfterClass = i;
        if (firstNesting >= 0 && gapAfterNesting < 0) gapAfterNesting = i;
      }
      i++;
      continue;
    }
    if (!sawContent) {
      // `<!--` and `-->` between rules are skipped by CSS (a stylesheet wrapped in an HTML comment).
      const wrapper = css.startsWith("<!--", i)
        ? 4
        : css.startsWith("-->", i)
          ? 3
          : 0;
      if (wrapper > 0) {
        i += wrapper;
        startStatement(i);
        continue;
      }
      sawContent = true;
      listStart = i;
      isAtRule = c === "@";
    }
    if (selectorLead === "") selectorLead = c;
    switch (c) {
      case "{": {
        const block = blocks[blocks.length - 1];
        if (isAtRule) {
          blocks.push(block);
        } else {
          endSelector(i);
          for (const selector of pending) selectors.push(selector);
          blocks.push({
            inStyleRule: true,
            anchored:
              block.anchored || pending.every((selector) => selector.hasAnchor),
            attributeLed: pendingAttributeLed,
          });
        }
        startStatement(i + 1);
        break;
      }
      case "}":
        if (blocks.length > 1) blocks.pop();
        startStatement(i + 1);
        break;
      case ";":
        if (atTopLevel) startStatement(i + 1);
        break;
      case "(":
        parens++;
        break;
      case ")":
        if (parens > 0) parens--;
        break;
      case "[":
        inBrackets = true;
        break;
      case "]":
        inBrackets = false;
        break;
      case ",":
        if (atTopLevel) {
          endSelector(i);
          startSelector(i + 1);
        }
        break;
      case ".":
        if (atTopLevel && isClassStart(css, i)) {
          if (firstClass < 0) firstClass = i;
          if (compoundAnchor < 0) compoundAnchor = i;
        }
        break;
      case "&":
        hasNesting = true;
        if (atTopLevel) {
          if (firstNesting < 0) firstNesting = i;
          if (compoundAnchor < 0) compoundAnchor = i;
        }
        break;
      case ">":
      case "+":
      case "~":
        if (atTopLevel) {
          endCompound(i);
          if (firstClass >= 0 && gapAfterClass < 0) gapAfterClass = i;
          if (firstNesting >= 0 && gapAfterNesting < 0) gapAfterNesting = i;
        }
        break;
      case "u":
        // An unquoted `url(...)` may hold braces, commas, and semicolons. It ends at the first `)`.
        if (!noClosingParen && css.startsWith("url(", i)) {
          let j = i + 4;
          while (css[j] === " " || css[j] === "\n" || css[j] === "\t") j++;
          if (css[j] !== '"' && css[j] !== "'") {
            const close = css.indexOf(")", j);
            if (close < 0) noClosingParen = true;
            else {
              i = close + 1;
              continue;
            }
          }
        }
        break;
    }
    i++;
  }
  return selectors;
}

/** The selector's text with its line breaks as spaces, so a pattern reads a wrapped selector as one line. */
export function selectorOnOneLine(css: string, selector: CssSelector): string {
  return css.slice(selector.start, selector.end).replace(/[\n\r\f]/g, " ");
}

/**
 * Whether `offset` is in a top-level compound of the selector that has a scoped class or `&` before it: the
 * `:has(img)` of `.wrap .card:has(img)`, but not the `:is(p)` of `.wrap :is(p)`.
 */
export function hasClassBeforeInCompound(
  selector: CssSelector,
  offset: number,
): boolean {
  const spans = selector.classSpans;
  // The spans are in order and do not overlap: find the last one that starts before the offset.
  let low = 0;
  let high = spans.length / 2 - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (spans[middle * 2] < offset) low = middle;
    else high = middle - 1;
  }
  return (
    spans.length > 0 && spans[low * 2] < offset && offset < spans[low * 2 + 1]
  );
}
