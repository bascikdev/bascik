/*
 * Words as a recognizer heard them, against the words that were said: the
 * word error rate every speech system is measured by.
 */

/** Text as a list of words to compare: lower case, no punctuation, digits spelled as said. */
export function spokenWords(text: string): string[] {
  const DIGITS = [
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
  ];
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/['’]/g, "")
    .replace(/\b\d\b/g, (digit) => DIGITS[Number(digit)]!)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/**
 * The word error rate of `heard` against `said`: the words that must be
 * replaced, dropped or added to turn one into the other, divided by how
 * many words were said. 0 is every word right; it can be more than 1.
 */
export function wordErrorRate(said: string, heard: string): number {
  const expected = spokenWords(said);
  const got = spokenWords(heard);
  if (!expected.length) return got.length ? 1 : 0;
  // The edit distance between the two lists, a row at a time.
  let row = got.map((_word, at) => at + 1);
  for (let line = 0; line < expected.length; line++) {
    let diagonal = line;
    let left = line + 1;
    const next: number[] = [];
    for (let column = 0; column < got.length; column++) {
      const cost = expected[line] === got[column] ? 0 : 1;
      const best = Math.min(row[column]! + 1, left + 1, diagonal + cost);
      diagonal = row[column]!;
      left = best;
      next.push(best);
    }
    row = next;
  }
  return (got.length ? row.at(-1)! : expected.length) / expected.length;
}
