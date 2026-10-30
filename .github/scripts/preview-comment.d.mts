export declare const MARKER: string;
export declare const BOT_LOGIN: string;
export interface PreviewLink {
  label: string;
  worker: string;
  url: string;
  paths: readonly string[];
}
export interface IssueComment {
  id: number;
  body?: string | null;
  user?: { login?: string } | null;
}
export declare function commentBody(input: {
  sha: string;
  branch: string;
  previews: readonly PreviewLink[];
  runUrl?: string;
}): string;
export declare function findStickyComment(
  comments: readonly IssueComment[],
): IssueComment | undefined;
export declare function findOpenPullRequests(input: {
  apiUrl?: string;
  repository: string;
  branch: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<number[]>;
export declare function upsertComment(input: {
  apiUrl?: string;
  repository: string;
  issue: number;
  token: string;
  body: string;
  fetchImpl?: typeof fetch;
}): Promise<{ action: "created" | "updated"; id: number }>;
export declare function run(
  env: Record<string, string | undefined>,
  options?: {
    fetchImpl?: typeof fetch;
    log?: (line: string) => void;
    appendSummary?: (path: string, text: string) => void;
  },
): Promise<{
  body: string;
  comments: { pr: number; action: "created" | "updated"; id: number }[];
}>;
