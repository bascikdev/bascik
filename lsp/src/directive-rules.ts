/**
 * Per-file checks on Bascik's own attributes and component layout.
 *
 * These need only the text of one file, so they live here and run in the editor as well as in
 * `bascik --check`. Checks that need the whole project (the set of pages, the route table, the config) live in
 * `@bascik/bascik` instead; see docs/content/internals/diagnostics.md for the split.
 */

/** `data-bascik-*` attributes that are a single fixed name. */
export const KNOWN_BASCIK_DATA_EXACT = [
  "data-bascik-slot",
  "data-bascik-build",
  "data-bascik-build-once",
  "data-bascik-server",
  "data-bascik-routes",
  "data-bascik-stream",
  "data-bascik-preserve",
  "data-bascik-server-id",
] as const;

/** `data-bascik-*` attributes whose name carries a suffix chosen by the author. */
export const KNOWN_BASCIK_DATA_PREFIXES = [
  "data-bascik-prop-",
  "data-bascik-attr-",
] as const;

const EXACT = new Set<string>(KNOWN_BASCIK_DATA_EXACT);

/** Whether a lower-cased attribute name starting with `data-bascik-` is one Bascik reads. */
export function isKnownBascikAttribute(name: string): boolean {
  return (
    EXACT.has(name) ||
    KNOWN_BASCIK_DATA_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

export function unknownBascikAttributeMessage(name: string): string {
  const known = [
    ...KNOWN_BASCIK_DATA_EXACT,
    ...KNOWN_BASCIK_DATA_PREFIXES.map((prefix) => `${prefix}...`),
  ]
    .sort()
    .join(", ");
  return `Unknown attribute "${name}". Bascik ignores it, so it is probably a typo. Known attributes: ${known}`;
}

export function unknownDirectiveValueMessage(
  directive = "data-bascik-build",
): string {
  return `${directive} does not take a value.`;
}

/** Whether a `data-bascik-build` value is empty, as with a bare directive. */
export function isKnownBuildValue(value: string): boolean {
  return value.trim() === "";
}

export interface StructureProblem {
  kind: "script-before-markup" | "style-after-markup";
  /** Offset of the offending `<script` or `<style` in the text that was scanned. */
  index: number;
  message: string;
}

/**
 * Checks the component template convention: `<style>` above the markup, `<script>` below it.
 *
 * `masked` is the file with comments and the bodies of `<script>`, `<style>` and `<textarea>` blanked out, so
 * the only `<` left are real tags and offsets still match the original file.
 */
export function findComponentStructureProblems(
  masked: string,
): StructureProblem[] {
  const problems: StructureProblem[] = [];
  // Closing tags start with `</`, so only opening tags of real markup count.
  const firstMarkup = masked.search(/<(?!\/?(?:style|script)\b)[a-z]/i);
  const firstScript = masked.search(/<script\b/i);
  const firstStyle = masked.search(/<style\b/i);

  if (firstScript >= 0 && firstMarkup >= 0 && firstScript < firstMarkup) {
    problems.push({
      kind: "script-before-markup",
      index: firstScript,
      message:
        "Component template convention: place <script> blocks after HTML markup.",
    });
  }
  if (firstStyle >= 0 && firstMarkup >= 0 && firstStyle > firstMarkup) {
    problems.push({
      kind: "style-after-markup",
      index: firstStyle,
      message:
        "Component template convention: place <style> blocks above HTML markup.",
    });
  }
  return problems;
}
