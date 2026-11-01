/** How the Milk frother runs. */
export interface FrotherSettings {
  /** Revolutions per minute. */
  rpm: number;
  foam: "light" | "dense";
}

export const frotherSettings: FrotherSettings = { rpm: 1200, foam: "dense" };

/** Froths milk at a level from 1 to 3. */
export function froth(level: number): string {
  return "foam".repeat(level);
}
