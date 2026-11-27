export declare const WORKFLOW_FILE: string;
export declare const COMMENT_JOB: string;
export declare const RUNS_SEARCHED: number;

export interface WorkflowRun {
  id: number;
  status: string;
  conclusion: string | null;
  head_sha: string;
  html_url?: string;
}

export interface WorkflowJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
}

export declare function choosePreviewRun(
  runs: readonly { run: WorkflowRun; job: WorkflowJob | undefined }[],
):
  | { action: "rerun"; run: WorkflowRun; job: WorkflowJob }
  | { action: "wait"; run: WorkflowRun; job: WorkflowJob }
  | { action: "none"; reason: string };

export declare function run(
  env: Record<string, string | undefined>,
  options?: {
    fetchImpl?: typeof fetch;
    log?: (line: string) => void;
    sleep?: (ms: number) => Promise<void>;
    pollMs?: number;
    maxWaitMs?: number;
  },
): Promise<{ rerun: number | undefined; reason?: string }>;
