export type GitResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};
export declare function releaseOnMain(
  tag: string,
  sha: string,
  git: (args: string[]) => GitResult,
): string;
