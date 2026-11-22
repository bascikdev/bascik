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
  | "run-any"
  | "preview-templates";

export declare const PREVIEW_TEMPLATES: readonly string[];

export function changedTemplates(paths: readonly string[]): string[];

export function changedWorkspaces(
  paths: readonly string[],
  options?: { all?: boolean },
): Record<ChangedWorkspaceOutput, string>;
