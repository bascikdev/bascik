// Imported by ts-imports-format.ts only: proves imports are followed through
// more than one file. The dev reload test lowers the cap below and expects
// the open page to show the new rating.
export const clampRating = (rating: number): number =>
  Math.min(5, Math.max(0, Math.round(rating)));
