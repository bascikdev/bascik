// src/client/confetti-entry.ts: the browser entry point.
// Bare specifiers are fine here because esbuild resolves and bundles them.
import confetti from "canvas-confetti";

export const celebrate = () => confetti();
