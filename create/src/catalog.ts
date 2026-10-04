/**
 * catalog.ts: which examples `create-bascik --example` can fetch, and where from.
 *
 * Two kinds of source exist:
 * - an official example id (`blog`). It lives in `templates/<id>` of this repository, and users get the
 *   branch `examples/<id>`, which .github/scripts/sync-examples.sh updates only when a release is
 *   published;
 * - a public GitHub URL, optionally pointing at a branch, tag, commit, and folder.
 *
 * Nothing here touches the network or the file system. Only github.com is supported, so every
 * archive comes from codeload.github.com and a link can never name another host.
 */

export interface OfficialExample {
  id: string;
  description: string;
}

/** Examples shipped in `templates/` of the Bascik repository. Add an entry when a template lands. */
export const OFFICIAL_EXAMPLES: readonly OfficialExample[] = [
  { id: "blog", description: "Markdown blog with tags, a paginated archive, an Atom feed, and page metadata" },
];

export const OFFICIAL_SOURCE = {
  owner: "bascikdev",
  repo: "bascik",
  /** Official example `<id>` is the whole of the branch `<branchPrefix><id>`. */
  branchPrefix: "examples/",
} as const;

export interface ExampleSource {
  kind: "official" | "github";
  owner: string;
  repo: string;
  /** Branch, tag, or commit. `null` means the repository's default branch. */
  ref: string | null;
  /** Folder inside the repository, with no leading or trailing slash. Empty means the root. */
  path: string;
  /** What to show a person: `blog` or `github.com/owner/repo/tree/main/app`. */
  label: string;
}

export class SourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceError";
  }
}

const OWNER_OR_REPO = /^[A-Za-z0-9_.-]+$/;
const REF = /^[A-Za-z0-9_.@+-]+$/;
const OFFICIAL_ID = /^[a-z0-9][a-z0-9-]*$/;
const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

function decodeSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new SourceError(`The link contains an invalid percent escape: "${raw}".`);
  }
}

/** Split and validate a folder path from a link or `--example-path`. */
export function normalizeExamplePath(value: string): string {
  const segments = value.replace(/^\/+|\/+$/g, "").split("/");
  if (segments.length === 1 && segments[0] === "") return "";
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new SourceError(`"${value}" is not a valid folder path: it has an empty, "." or ".." part.`);
    }
    if (/[\\\u0000-\u001f\u007f]/.test(segment)) {
      throw new SourceError(`"${value}" is not a valid folder path: backslashes and control characters are not allowed.`);
    }
  }
  return segments.join("/");
}

/** `URL` resolves `.` and `..` (also written `%2e`) before we see them, so check the text as typed. */
const DOT_SEGMENT = /\/(?:\.|%2e){1,2}(?=[/?#]|$)/i;

function parseGithubUrl(value: string, examplePath: string | undefined): ExampleSource {
  if (DOT_SEGMENT.test(value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "/"))) {
    throw new SourceError(`"${value}" is not a valid link: it has a "." or ".." part.`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SourceError(`"${value}" is not a valid URL.`);
  }
  if (url.protocol !== "https:") {
    throw new SourceError(`Only https://github.com links are supported, got "${url.protocol}//".`);
  }
  if (!GITHUB_HOSTS.has(url.hostname)) {
    throw new SourceError(`Only github.com links are supported, got "${url.hostname}". Clone other hosts yourself and copy the folder.`);
  }
  if (url.username || url.password || url.port) {
    throw new SourceError("The link must not contain credentials or a port.");
  }
  if (url.search || url.hash) {
    throw new SourceError("The link must not contain a query string or a fragment. Use /tree/<branch>/<folder> to pick a folder.");
  }

  const segments = url.pathname.split("/").slice(1);
  if (segments.at(-1) === "") segments.pop();
  const [owner, rawRepo, kind, rawRef, ...rest] = segments.map(decodeSegment);
  if (!owner || !rawRepo) {
    throw new SourceError("Use a link to a repository, for example https://github.com/owner/repo.");
  }
  const repo = rawRepo.replace(/\.git$/, "");
  if (!OWNER_OR_REPO.test(owner) || !OWNER_OR_REPO.test(repo) || owner === "." || owner === ".." || repo === "." || repo === "..") {
    throw new SourceError(`"${owner}/${rawRepo}" is not a valid GitHub repository name.`);
  }

  let ref: string | null = null;
  let linkPath = "";
  if (kind !== undefined) {
    if (kind === "blob") {
      throw new SourceError("That link points at a file. Link to the folder that contains package.json instead.");
    }
    if (kind !== "tree" || !rawRef) {
      throw new SourceError(`Unsupported GitHub link "${url.pathname}". Use https://github.com/owner/repo or .../tree/<branch>/<folder>.`);
    }
    if (!REF.test(rawRef)) {
      throw new SourceError(`"${rawRef}" is not a supported branch, tag, or commit. Branch names with slashes are not supported; use a tag or a commit.`);
    }
    ref = rawRef;
    linkPath = normalizeExamplePath(rest.join("/"));
  }

  if (examplePath !== undefined && linkPath) {
    throw new SourceError("The link already names a folder, so --example-path would be ambiguous. Use one or the other.");
  }
  const path = examplePath !== undefined ? normalizeExamplePath(examplePath) : linkPath;
  const label = `github.com/${owner}/${repo}${ref ? `/tree/${ref}` : ""}${path ? (ref ? "/" : "/tree/HEAD/") + path : ""}`;
  return { kind: "github", owner, repo, ref, path, label };
}

/**
 * Turn the value of `--example` into a source. An id must be in the official catalog; anything that
 * looks like a URL must be a github.com link. Unknown ids fail here, before any network request.
 */
export function parseExampleSource(value: string, examplePath?: string): ExampleSource {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return parseGithubUrl(value, examplePath);

  if (!OFFICIAL_ID.test(value) || !OFFICIAL_EXAMPLES.some((example) => example.id === value)) {
    const known = OFFICIAL_EXAMPLES.map((example) => example.id).join(", ");
    throw new SourceError(
      `"${value}" is not an official example. Available: ${known}. ` +
      "To use a GitHub repository, pass its full https://github.com/... link.",
    );
  }
  if (examplePath !== undefined) {
    throw new SourceError("--example-path only applies to GitHub links. Official examples are chosen by name.");
  }
  return {
    kind: "official",
    owner: OFFICIAL_SOURCE.owner,
    repo: OFFICIAL_SOURCE.repo,
    ref: `${OFFICIAL_SOURCE.branchPrefix}${value}`,
    path: "",
    label: value,
  };
}
