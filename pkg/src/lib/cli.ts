/**
 * @module cli
 *
 * CLI argument parsing for the `bascik` binary.
 *
 * `resolveCliAction` is a pure function that maps raw argv (minus node/script)
 * to a decision so `src/index.ts` stays a thin shell with no logic of its own,
 * and the parsing behavior can be unit tested without starting a server.
 */

export type CliAction =
  | "init"
  | "check"
  | "server"
  | "build"
  | "dev"
  | "help"
  | "version"
  | "error";

export interface CliDecision {
  action: CliAction;
  /** Flags that were not recognized, when action is "error". */
  unknownFlags?: string[];
}

/** Long-form flags the CLI understands. */
const KNOWN_FLAGS = new Set([
  "--build",
  "--server",
  "--check",
  "--help",
  "-h",
  "--version",
  "-v",
  "--log",
]);

/** Positional subcommands the CLI understands. */
const KNOWN_SUBCOMMANDS = new Set(["init"]);

/** Filters out common Node.js internal, profiling, and loader flags and their values. */
export const filterNodeArgs = (args: string[]): string[] => {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // Skip flags that have a separate parameter argument following them
    if (
      arg === "-r" ||
      arg === "--require" ||
      arg === "--import" ||
      arg === "--loader" ||
      arg === "--experimental-loader"
    ) {
      i++; // skip the parameter value
      continue;
    }

    // Skip self-contained flags or flags with inline values
    if (
      arg === "--prof" ||
      arg === "--print-opt-source" ||
      arg === "--expose-gc" ||
      arg === "--experimental-strip-types" ||
      arg === "--heapprofile" ||
      arg === "--cpuprof" ||
      arg.startsWith("--logfile=") ||
      arg.startsWith("--heapprofile=") ||
      arg.startsWith("--cpuprof=") ||
      arg.startsWith("--inspect=") ||
      arg.startsWith("--inspect-brk=") ||
      arg === "--inspect" ||
      arg === "--inspect-brk" ||
      arg.startsWith("--conditions=")
    ) {
      continue;
    }

    result.push(arg);
  }
  return result;
};

export const resolveCliAction = (args: string[]): CliDecision => {
  const filtered = filterNodeArgs(args);

  const unknownFlags = filtered.filter(
    (a) => a.startsWith("-") && !KNOWN_FLAGS.has(a),
  );

  if (unknownFlags.length > 0) {
    return { action: "error", unknownFlags };
  }
  if (filtered.includes("--help") || filtered.includes("-h")) {
    return { action: "help" };
  }
  if (filtered.includes("--version") || filtered.includes("-v")) {
    return { action: "version" };
  }
  if (filtered.includes("init")) {
    return { action: "init" };
  }
  if (filtered.includes("--check")) {
    return { action: "check" };
  }
  if (filtered.includes("--server")) {
    return { action: "server" };
  }
  if (filtered.includes("--build")) {
    return { action: "build" };
  }
  return { action: "dev" };
};

export const CLI_USAGE = `Usage: bascik [command] [options]

Commands:
  init            Scaffold a new Bascik project in the current directory

Options:
  (no flags)      Start the dev server with watch mode
  --build         Transpile all pages to output directory (production build)
  --server        Serve output directory over HTTP/2 (production server)
  --check         Validate the project (pages, components, config)
  --log [path]    Write build output to a log file (default: .bascik/build.log)
  -h, --help      Show this help text
  -v, --version   Show the installed Bascik version
`;

/** Known subcommands exported for use in error messages / tests. */
export const CLI_SUBCOMMANDS = KNOWN_SUBCOMMANDS;
