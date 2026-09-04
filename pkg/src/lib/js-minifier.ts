/**
 * @module js-minifier
 * Built-in lightweight, safe JavaScript minifier for Bascik.
 *
 * Strips comments, collapses redundant whitespace, removes safe operator spaces,
 * and handles statement boundaries (ASI) safely without modifying literal content
 * or breaking valid JS syntax.
 */

/** Segment representing either literal text (strings, regex) or minifiable code */
type Segment = { literal: boolean; text: string };

/**
 * Test-only instrumentation: counts source characters the scanner examines.
 * Used by the complexity guard to assert linear work without asserting wall
 * time. Production code paths never read it; the increments are integer adds.
 */
export const __scanStatsForTests = {
  charsExamined: 0,
  reset(): void {
    this.charsExamined = 0;
  },
};

/** Keywords expecting an expression where a following `/` starts a regex literal */
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "case",
  "throw",
  "yield",
  "await",
  "delete",
  "typeof",
  "void",
  "default",
  "in",
  "of",
  "instanceof",
  "new",
  "do",
]);

/** Identifier/number characters: the "word" class the scanner tracks. */
const isWordChar = (c: string): boolean =>
  (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "_" || c === "$";

/** `\w` as JS regex defines it: word chars minus `$`. Needed to mirror `\b`. */
const isRegexWordChar = (c: string): boolean => c !== "$" && isWordChar(c);

const isDigit = (c: string): boolean => c >= "0" && c <= "9";

/**
 * Mirrors the `\s` class used by the previous prefix-trimming implementation
 * (ECMAScript WhiteSpace + LineTerminator), as a char-code test so the hot
 * per-character path does not enter the regex engine.
 */
const isSpace = (c: string): boolean => {
  const code = c.charCodeAt(0);
  if (code <= 32) return code === 32 || (code >= 9 && code <= 13);
  if (code < 0xa0) return false;
  return (
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
};

/**
 * Given the maximal run of word characters immediately before a `/`, return
 * the identifier the old implementation's `\b([a-zA-Z_$][a-zA-Z0-9_$]*)$`
 * match would have produced, or `undefined` when it would not have matched.
 *
 * `\b` is defined in terms of `\w`, which excludes `$`, so the match starts at
 * the leftmost position whose character is not a digit and where exactly one
 * of (previous char, this char) is a `\w` character. The character before the
 * run is never a word character (that is what ends the run), so at position 0
 * the boundary exists exactly when the run starts with a letter or `_`.
 * Examples: `return` -> `return`; `$return` -> `return`; `9return` -> none.
 *
 * Cost is the run length, and each run precedes at most one `/`, so total work
 * across a scan stays linear in the input.
 */
const lastWordBeforeSlash = (run: string): string | undefined => {
  for (let p = 0; p < run.length; p++) {
    const cur = run[p];
    __scanStatsForTests.charsExamined++;
    if (isDigit(cur)) continue;
    const prevIsW = p === 0 ? false : isRegexWordChar(run[p - 1]);
    if (prevIsW !== isRegexWordChar(cur)) return run.slice(p);
  }
  return undefined;
};

/**
 * Single forward pass that splits source into literal segments (strings,
 * templates, regex literals, kept verbatim) and code segments (everything
 * else, comments already stripped).
 *
 * Slash classification is context-sensitive and needs "what came before".
 * Instead of rescanning the accumulated code prefix on every `/`, three
 * pieces of state are maintained incrementally while code is appended:
 *   - `lastRaw`: the last character appended to the current code segment
 *   - `lastSig`: the last non-whitespace character appended (the old
 *     implementation's `trimmedAccum.slice(-1)`)
 *   - `wordRun`: the maximal word-character run ending at `lastSig`
 * Together they reproduce the previous decisions byte for byte in O(1)
 * amortized time per character.
 */
const scanSegments = (js: string): Segment[] => {
  const segments: Segment[] = [];
  let codeAccum = "";
  let lastRaw = "";
  let lastSig = "";
  let wordRun = "";
  let i = 0;
  const len = js.length;

  const flushCode = (): void => {
    if (codeAccum) {
      segments.push({ literal: false, text: codeAccum });
      codeAccum = "";
    }
    lastRaw = "";
    lastSig = "";
    wordRun = "";
  };

  const appendCode = (c: string): void => {
    codeAccum += c;
    if (isSpace(c)) {
      lastRaw = c;
      return;
    }
    if (isWordChar(c)) {
      wordRun = isWordChar(lastRaw) ? wordRun + c : c;
    } else {
      wordRun = "";
    }
    lastRaw = c;
    lastSig = c;
  };

  while (i < len) {
    const ch = js[i];
    __scanStatsForTests.charsExamined++;

    // Quoted string literals ("...", '...') — preserve verbatim
    if (ch === '"' || ch === "'") {
      flushCode();
      const quote = ch;
      let lit = ch;
      i++;
      while (i < len) {
        const c = js[i];
        __scanStatsForTests.charsExamined++;
        if (c === "\\" && i + 1 < len) {
          lit += c + js[i + 1];
          i += 2;
          continue;
        }
        lit += c;
        i++;
        if (c === quote) break;
      }
      segments.push({ literal: true, text: lit });
      continue;
    }

    // Template literals (`...`) — preserve verbatim
    if (ch === "`") {
      flushCode();
      let lit = "`";
      i++;
      while (i < len) {
        const c = js[i];
        __scanStatsForTests.charsExamined++;
        if (c === "\\" && i + 1 < len) {
          lit += c + js[i + 1];
          i += 2;
          continue;
        }
        lit += c;
        i++;
        if (c === "`") break;
      }
      segments.push({ literal: true, text: lit });
      continue;
    }

    // Potential comment, division, or regex literal — all start with "/".
    if (ch === "/") {
      const next = js[i + 1];

      // Disambiguate regex literal vs division operator:
      // A regex literal can only appear where an expression is expected.
      let couldBeRegex = false;
      if (next !== "/" && next !== "*") {
        if (!lastSig) {
          // No significant code yet in this segment — check previous segment if any
          const lastSeg = segments[segments.length - 1];
          if (!lastSeg || !lastSeg.literal) {
            couldBeRegex = true;
          }
        } else if (isWordChar(lastSig)) {
          // Preceded by a word token — regex only if word is an expression keyword (e.g. return /a/)
          const lastWord = lastWordBeforeSlash(wordRun);
          if (lastWord !== undefined && REGEX_PRECEDING_KEYWORDS.has(lastWord)) {
            couldBeRegex = true;
          }
        } else if (!/[)\\]}'"`]/.test(lastSig)) {
          // Preceded by operators/punctuation like '=', '(', '[', ':', ',', '!', '?', '&', '|', '+', '-', '*', ';'
          // NOTE: this regex is kept byte-for-byte from the original scanner
          // for output identity. Its class closes at `\\]`, so the pattern
          // is `[)\\]` followed by the literal text }'"` and can never match
          // a single character. Fixing it would change emitted bytes (for
          // example `(a) / (b) / c` is currently kept as a regex-shaped
          // literal); that is a separate output-policy decision.
          couldBeRegex = true;
        }
      }

      if (couldBeRegex) {
        let j = i + 1;
        let inClass = false;
        let closed = false;
        while (j < len) {
          const c = js[j];
          __scanStatsForTests.charsExamined++;
          if (c === "\\") {
            j += 2;
            continue;
          }
          if (c === "[") inClass = true;
          else if (c === "]") inClass = false;
          else if (c === "/" && !inClass) {
            closed = true;
            j++;
            break;
          } else if (c === "\n") break; // Unterminated — not a regex
          j++;
        }
        if (closed) {
          // Consume regex flags (e.g., /abc/gi)
          while (j < len && /[a-z]/i.test(js[j])) j++;
          flushCode();
          segments.push({ literal: true, text: js.slice(i, j) });
          i = j;
          continue;
        }
      }

      if (next === "*") {
        // Block comment: skip to */
        i += 2;
        while (i + 1 < len && !(js[i] === "*" && js[i + 1] === "/")) {
          __scanStatsForTests.charsExamined++;
          i++;
        }
        i += 2;
        // If stripping a block comment between two word characters (e.g., return/*x*/v),
        // preserve a space so token boundaries aren't lost.
        const nextChar = js[i];
        if (lastRaw && isWordChar(lastRaw) && nextChar && isWordChar(nextChar)) {
          appendCode(" ");
        }
        continue;
      }

      if (next === "/") {
        // Line comment: skip to end of line (preserve newline for statement separation)
        i += 2;
        while (i < len && js[i] !== "\n") {
          __scanStatsForTests.charsExamined++;
          i++;
        }
        continue;
      }
    }

    appendCode(ch);
    i++;
  }
  flushCode();
  return segments;
};

/**
 * Strip block/line comments and collapse whitespace from a JS string.
 * String literals, template literals, and regex literals are preserved verbatim
 * so their content is never altered.
 */
export const minifyJs = (js: string): string => {
  if (!js) return "";

  const segments = scanSegments(js);

  // Process code segments and assemble minified JS.
  // `resultLast` mirrors result.slice(-1) without flattening the growing
  // string on every segment (V8 rope flattening made that quadratic in the
  // number of segments).
  let result = "";
  let resultLast = "";
  for (let sIdx = 0; sIdx < segments.length; sIdx++) {
    const seg = segments[sIdx];
    if (seg.literal) {
      // Ensure space between preceding keyword/identifier and literal if needed
      if (result && isWordChar(resultLast) && isWordChar(seg.text[0])) {
        result += " ";
      }
      result += seg.text;
      resultLast = seg.text[seg.text.length - 1];
      continue;
    }

    let text = seg.text;

    // 1. Process line breaks: convert newlines to semicolons or spaces for ASI safety
    //
    // The join decision looks at the text accumulated so far ("prevLine").
    // Every test is `$`-anchored, and prevLine never has trailing whitespace
    // (each appended line is trimmed and non-empty), so the decision depends
    // only on a suffix. Three incrementally maintained views replace the
    // former whole-prefix trimEnd + regex scans:
    //   - `ptLast`: last character of processedText
    //   - `ptTail`: last TAIL_WINDOW characters (enough for every bounded
    //     pattern; the longest is `\bfinally$` which needs 7 + 1 for `\b`)
    //   - the paren region: when prevLine ends with `)`, the one unbounded
    //     pattern `\b(if|while|for|switch)\s*\([^)]*\)\s*$` must use that
    //     final `)` as its `\)`, and `[^)]*` cannot cross the previous `)`,
    //     so the whole match lies after the second-to-last `)`. That region
    //     is located lazily with one backward `lastIndexOf` and only when the
    //     line actually ends with `)`. Regions for successive `)`-terminated
    //     lines are disjoint, so total work stays linear.
    const TAIL_WINDOW = 8;
    const lines = text.split("\n");
    let processedText = "";
    let ptLast = "";
    let ptTail = "";

    const appendProcessed = (s: string): void => {
      processedText += s;
      ptLast = s[s.length - 1];
      ptTail = s.length >= TAIL_WINDOW ? s.slice(-TAIL_WINDOW) : (ptTail + s).slice(-TAIL_WINDOW);
    };

    for (let lIdx = 0; lIdx < lines.length; lIdx++) {
      const line = lines[lIdx].trim();
      if (!line) continue;

      if (!processedText) {
        appendProcessed(line);
        continue;
      }

      const lastChar = ptLast;
      const firstChar = line[0];
      __scanStatsForTests.charsExamined += ptTail.length;

      // Check if semicolon is required between prevLine and current line
      let needsSemicolon = false;

      // Statements ending in value tokens or return/break/continue/throw require ; before next statement
      if (/[a-zA-Z0-9_\)$\]'"`]/.test(lastChar)) {
        // Do NOT insert semicolon if line ends with an open control flow / operator
        let endsWithOpenControl = false;
        if (lastChar === ")") {
          const prevParen = processedText.lastIndexOf(")", processedText.length - 2);
          const region = processedText.slice(prevParen + 1);
          __scanStatsForTests.charsExamined += region.length;
          endsWithOpenControl = /\b(if|while|for|switch)\s*\([^)]*\)\s*$/.test(region);
        }
        endsWithOpenControl =
          endsWithOpenControl ||
          /\b(else|do|try|finally)\s*$/.test(ptTail) ||
          /(=|,|\+|\-|\*|\/|%|\?|:|=>|\.|\&\&|\|\||\?\?)\s*$/.test(ptTail);

        // Do NOT insert semicolon if next line starts with closing/continuation structures
        const startsWithContinuation =
          /^(else|catch|finally|while|instanceof|in|of|,|;|:|\)|\}|\]|\.|\?|\*|%|\^|<|>|=|\+(?!\+)|\-(?!\-)|&|\|)/.test(line);

        if (!endsWithOpenControl && !startsWithContinuation && !/[;{}:,]\s*$/.test(ptTail)) {
          needsSemicolon = true;
        }
      } else if (lastChar === "}") {
        // After }, insert semicolon unless followed by control continuation (else, catch, finally, while, etc.)
        if (!/^(else|catch|finally|while|instanceof|in|of|,|;|:|\)|\}|\]|\.|\?|\*|%|\^|<|>|=|\+(?!\+)|\-(?!\-)|&|\|)/.test(line)) {
          needsSemicolon = true;
        }
      }

      if (needsSemicolon) {
        appendProcessed(";" + line);
      } else if (isWordChar(lastChar) && isWordChar(firstChar)) {
        // Ensure space between word tokens when joining without semicolon
        appendProcessed(" " + line);
      } else {
        appendProcessed(line);
      }
    }

    // 2. Collapse remaining multi-space runs into a single space
    let code = processedText.replace(/\s+/g, " ");

    // 3. Strip spaces around safe structural punctuation
    code = code.replace(/\s*([{}();,:=?*!^~%])\s*/g, "$1");

    // 4. Strip spaces around < and >
    code = code.replace(/\s*(<|>|<=|>=|==|===|!=|!==|<<|>>|>>>|\&\&|\|\||\?\?|\+=|-=|\*=|\/=|%=)\s*/g, "$1");

    // 5. Strip spaces around + and - safely (avoid turning + + into ++ or - - into --)
    code = code.replace(/([^\s+-])\s*\+/g, "$1+");
    code = code.replace(/\+\s*([^\s+-])/g, "+$1");
    code = code.replace(/([^\s+-])\s*-/g, "$1-");
    code = code.replace(/-\s*([^\s+-])/g, "-$1");

    // 6. Strip spaces around . except when preceded by an integer literal (e.g. 1 .toString())
    code = code.replace(/([^\d\s])\s*\.\s*/g, "$1.");
    code = code.replace(/([^\d])\s*\.\s*([^\d\s])/g, "$1.$2");

    // Ensure boundary spacing with previous segment if both end/start with word chars.
    // `code` can be empty (a whitespace-only segment between two literals); the
    // original `/[a-zA-Z0-9_$]/.test(code[0])` coerced undefined to "undefined"
    // and matched, so an empty segment after a word char still emits a space.
    // Preserved for byte identity.
    const codeFirst = code[0];
    if (result && isWordChar(resultLast) && (codeFirst === undefined || isWordChar(codeFirst))) {
      result += " ";
      resultLast = " ";
    }

    result += code;
    if (code) resultLast = code[code.length - 1];
  }

  return result.trim();
};
