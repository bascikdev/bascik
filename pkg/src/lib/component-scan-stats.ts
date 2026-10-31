/**
 * Test-only instrumentation: bytes of already-resolved document prefix that a
 * component search had to skip over before reaching its match. A search from
 * offset zero on every substitution makes this quadratic in instance count;
 * a cursor resuming at the last replacement keeps it linear.
 */
export const __componentScanStatsForTests = {
  prefixBytesExamined: 0,
  attributeValueBytesScanned: 0,
  closureBytesChecked: 0,
  /** Bytes read to find and keep current where each component name's last close is. */
  closeFactBytesScanned: 0,
  /** Component-tag search regexes built (one per component list and names). */
  searchesCompiled: 0,
  reset(): void {
    this.prefixBytesExamined = 0;
    this.attributeValueBytesScanned = 0;
    this.closureBytesChecked = 0;
    this.closeFactBytesScanned = 0;
    this.searchesCompiled = 0;
  },
};

/** The expansion loop's state after a splice, for `__expansionProbeForTests`. */
export interface ExpansionSpliceProbe {
  /** The page after the splice. */
  html: string;
  /** The loop's mask of `html`, kept current incrementally where it can be. */
  masked: string;
  /** Where the next component search starts. */
  searchFrom: number;
  /** Whether the mask was spliced (true) or the page re-masked whole. */
  incremental: boolean;
  /**
   * The loop's upper bound for where the last close of a component name
   * starts in `masked`, or undefined while it has not been found yet.
   */
  lastCloseAt: ((tagName: string) => number) | undefined;
  /**
   * The loop's upper bounds for where the last raw-text closer and comment
   * end of each kind start in `html` (`MaskFacts.last`), or undefined while
   * they have not been found yet.
   */
  closerFacts: Readonly<Record<string, number>> | undefined;
}

/** The expansion loop's search result, for `__expansionProbeForTests`. */
export interface ExpansionSearchProbe {
  html: string;
  masked: string;
  searchFrom: number;
  /**
   * What the loop's search found (`getFirstComponent`): no name when none
   * is left; the offsets are non-enumerable properties of the result.
   */
  found: { name?: string };
}

/**
 * Test-only observer of `expandComponents` (component-expansion-core.ts): an
 * invariant oracle compares the incremental mask and the search the loop
 * makes with a whole re-mask and a search from the start. Unset, the loop
 * does no extra work.
 */
export const __expansionProbeForTests: {
  afterSplice?: (probe: ExpansionSpliceProbe) => void;
  afterSearch?: (probe: ExpansionSearchProbe) => void;
} = {};
