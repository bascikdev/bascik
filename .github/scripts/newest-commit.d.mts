export declare function tipOf(
  lsRemoteOutput: string,
  ref: string,
): string | undefined;
export declare function newestCommit(
  lsRemoteOutput: string,
  ref: string,
  sha: string,
): { newest: boolean; reason?: string };
