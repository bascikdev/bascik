type Workspace =
  | "pkg"
  | "create"
  | "lsp"
  | "docs"
  | "skills"
  | "extension"
  | "adapter-cloudflare"
  | "adapter-netlify";

type ChangedWorkspaceOutput =
  | `run-${Workspace}`
  | "run-shop-unit"
  | "run-shop-integration"
  | "run-shop-e2e"
  | "run-node-floor"
  | "run-linear-time"
  | "docs-only"
  | "run-any";

export function changedWorkspaces(
  paths: readonly string[],
  options?: { all?: boolean },
): Record<ChangedWorkspaceOutput, string>;
