/** Linear-time tag tokenizer shared by the analyzer and component metadata. */

const isTagNameStart = (code: number): boolean =>
  (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
const isTagNameChar = (code: number): boolean =>
  isTagNameStart(code) ||
  (code >= 48 && code <= 57) ||
  code === 95 ||
  code === 45;

/**
 * Tag tokens in source order, matching what
 * `/<\/?([A-Za-z][\w-]*)(?:[^>"']|"[^"]*"|'[^']*')*>/g` finds, in linear time.
 * The regex retries every `<` and rescans to the end on an unclosed tag, which
 * is quadratic. The tag-body scan is deterministic (first `>` outside quotes),
 * so its result depends only on where the scan stands; `tagEndFrom` remembers
 * it per position and no position is scanned twice.
 */
export function* scanTags(
  source: string,
  from = 0,
): Generator<{
  name: string;
  closing: boolean;
  text: string;
  start: number;
  end: number;
}> {
  const length = source.length;
  // 0 = not scanned yet, -1 = no closing `>`, otherwise the index after `>`.
  const tagEndFrom = new Int32Array(length + 1);
  const visited: number[] = [];
  const findTagEnd = (from: number): number => {
    let position = from;
    let end = -1;
    visited.length = 0;
    while (position < length) {
      const known = tagEndFrom[position];
      if (known !== 0) {
        end = known;
        break;
      }
      visited.push(position);
      const code = source.charCodeAt(position);
      if (code === 62 /* > */) {
        end = position + 1;
        break;
      }
      if (code === 34 /* " */ || code === 39 /* ' */) {
        const close = source.indexOf(source[position], position + 1);
        if (close < 0) break;
        position = close + 1;
        continue;
      }
      position++;
    }
    for (const index of visited) tagEndFrom[index] = end;
    return end;
  };

  let cursor = from;
  while (cursor < length) {
    const open = source.indexOf("<", cursor);
    if (open < 0) return;
    const closing = source.charCodeAt(open + 1) === 47; /* / */
    const nameStart = open + (closing ? 2 : 1);
    if (!isTagNameStart(source.charCodeAt(nameStart))) {
      cursor = open + 1;
      continue;
    }
    let nameEnd = nameStart + 1;
    while (nameEnd < length && isTagNameChar(source.charCodeAt(nameEnd)))
      nameEnd++;
    const end = findTagEnd(nameEnd);
    if (end < 0) {
      cursor = open + 1;
      continue;
    }
    yield {
      name: source.slice(nameStart, nameEnd),
      closing,
      text: source.slice(open, end),
      start: open,
      end,
    };
    cursor = end;
  }
}
