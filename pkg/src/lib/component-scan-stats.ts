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
  reset(): void {
    this.prefixBytesExamined = 0;
    this.attributeValueBytesScanned = 0;
    this.closureBytesChecked = 0;
  },
};
