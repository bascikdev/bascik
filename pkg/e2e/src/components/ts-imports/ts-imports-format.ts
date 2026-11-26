// Pure logic for <ts-imports>, imported by both of its scripts. A unit test
// could import this file directly.
import { clampRating } from "./ts-imports-rating.ts";

export const formatRating = (title: string, rating: number): string =>
  `${title}: ${clampRating(rating)}/5`;
