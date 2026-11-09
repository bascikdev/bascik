/**
 * The failure that stopped the dev server's first compile, while it stands.
 *
 * A component that does not compile when `bascik` starts (a half-written
 * TypeScript block, a component build script that throws) leaves no page in
 * memory. The dev server stays up instead of exiting (audit 159 finding 43):
 * every page request gets the boot page, whose live-reload connection is
 * told this error so the browser overlay shows it, and the next stored page
 * clears it.
 */
import type { SseBuildError } from "./sse.ts";

let bootFailure: SseBuildError | undefined;

export const setBootFailure = (failure: SseBuildError): void => {
  bootFailure = failure;
};

export const getBootFailure = (): SseBuildError | undefined => bootFailure;

export const clearBootFailure = (): void => {
  bootFailure = undefined;
};
