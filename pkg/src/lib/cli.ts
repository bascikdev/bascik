/**
 * @module cli
 *
 * CLI argument parsing for the `bascik` binary.
 *
 * `resolveCliAction` is THE one parser: a pure function that maps raw argv
 * (minus node/script) to a decision plus every parsed flag value. `src/index.ts`
 * stays a thin shell, and `config.ts` / `environment.ts` derive their mode and
 * flag values from this same parser so the CLI action and the resolved config
 * can never drift apart.
 *
 * Documented decisions:
 * - Conflicting mode flags (`--build --server`) are rejected, naming both.
 * - Unknown positionals are rejected with a near-match suggestion.
 * - Every value-taking flag accepts both `--flag value` and `--flag=value`.
 * - Repeating a boolean flag is a no-op; for value flags the last occurrence
 *   wins; `--env-file` is repeatable and appends.
 * - Unrecognized flags appearing BEFORE the first recognized bascik token are
 *   treated as Node runtime flags (profiler/wrapper resilience) and dropped;
 *   once a bascik token has been seen, unknown flags are an error.
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

/** Every value the parser extracted from argv. */
export interface CliFlags {
  config?: string;
  /** Log file path when `--log` was passed (bare `--log` uses the default). */
  log?: string;
  port?: number;
  host?: string;
  logLevel?: string;
  siteUrl?: string;
  envFiles: string[];
}

export interface CliDecision {
  action: CliAction;
  /** Flags that were not recognized, when action is "error". */
  unknownFlags?: string[];
  /** Human-readable error line(s), when action is "error". */
  errorMessage?: string;
  flags: CliFlags;
}

/** Default log path for a bare `--log`. */
export const DEFAULT_LOG_PATH = ".bascik/build.log";

// Mirrors LOG_LEVELS in config.ts. cli.ts cannot import config.ts (config.ts
// imports this module), so cli.test.ts carries a drift-guard test that keeps
// the two lists identical.
const CLI_LOG_LEVELS = ["silent", "error", "warn", "info", "debug"];

/** Boolean flags the CLI understands (no value). */
const BOOLEAN_FLAGS = new Set([
  "--build",
  "--server",
  "--check",
  "--help",
  "-h",
  "--version",
  "-v",
]);

/** Flags that require a value, in either `--flag value` or `--flag=value` form. */
const VALUE_FLAGS = new Set([
  "--config",
  "--port",
  "--host",
  "--log-level",
  "--site-url",
  "--env-file",
]);

/** `--log` is the one flag whose value is optional. */
const OPTIONAL_VALUE_FLAGS = new Set(["--log"]);

/** Positional subcommands the CLI understands. */
const KNOWN_SUBCOMMANDS = new Set(["init"]);

/** Candidates for "Did you mean …" suggestions on unknown tokens. */
const SUGGESTION_CANDIDATES = [
  "init",
  "--build",
  "--server",
  "--check",
  "--help",
  "--version",
  "--config",
  "--port",
  "--host",
  "--log-level",
  "--site-url",
  "--env-file",
  "--log",
];

/** Small Levenshtein distance, used only for typo suggestions. */
const editDistance = (a: string, b: string): number => {
  const prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  const curr: number[] = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
};

/** Best near-match candidate for a mistyped token, or undefined when none is close. */
const suggest = (token: string): string | undefined => {
  const normalized = token.replace(/^-+/, "").toLowerCase();
  if (!normalized) return undefined;
  let best: { candidate: string; distance: number } | undefined;
  for (const candidate of SUGGESTION_CANDIDATES) {
    const distance = editDistance(normalized, candidate.replace(/^-+/, ""));
    if (distance <= 2 && (best === undefined || distance < best.distance)) {
      best = { candidate, distance };
    }
  }
  return best?.candidate;
};

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

const isRecognizedToken = (arg: string): boolean => {
  if (KNOWN_SUBCOMMANDS.has(arg)) return true;
  if (BOOLEAN_FLAGS.has(arg) || VALUE_FLAGS.has(arg) || OPTIONAL_VALUE_FLAGS.has(arg)) {
    return true;
  }
  if (arg.startsWith("--") && arg.includes("=")) {
    const name = arg.slice(0, arg.indexOf("="));
    return VALUE_FLAGS.has(name) || OPTIONAL_VALUE_FLAGS.has(name) || BOOLEAN_FLAGS.has(name);
  }
  return false;
};

export const resolveCliAction = (args: string[]): CliDecision => {
  const filtered = filterNodeArgs(args);

  const flags: CliFlags = { envFiles: [] };
  const present = new Set<string>();
  const unknownFlags: string[] = [];
  const positionals: string[] = [];
  const valueErrors: string[] = [];
  // Profiler/wrapper resilience: unrecognized flags that precede the first
  // recognized bascik token are treated as Node runtime flags and dropped.
  // When argv contains no bascik token at all, unknown flags still error so a
  // typo like `bascik --builds` never silently starts the dev server.
  const hasKnownToken = filtered.some(isRecognizedToken);
  let seenKnownToken = false;

  const assignValue = (name: string, value: string) => {
    switch (name) {
      case "--config":
        flags.config = value;
        break;
      case "--port": {
        const port = Number.parseInt(value, 10);
        if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
          valueErrors.push(
            `Error: --port expects an integer between 1 and 65535 (received "${value}").`,
          );
          return;
        }
        flags.port = port;
        break;
      }
      case "--host":
        flags.host = value;
        break;
      case "--log-level":
        if (!CLI_LOG_LEVELS.includes(value)) {
          valueErrors.push(
            `Error: --log-level expects one of ${CLI_LOG_LEVELS.join(", ")} (received "${value}").`,
          );
          return;
        }
        flags.logLevel = value;
        break;
      case "--site-url":
        flags.siteUrl = value;
        break;
      case "--env-file":
        flags.envFiles.push(value);
        break;
      case "--log":
        flags.log = value || DEFAULT_LOG_PATH;
        break;
    }
  };

  for (let i = 0; i < filtered.length; i++) {
    const arg = filtered[i];

    // Inline `--flag=value` form.
    if (arg.startsWith("--") && arg.includes("=")) {
      const name = arg.slice(0, arg.indexOf("="));
      const value = arg.slice(arg.indexOf("=") + 1);
      if (VALUE_FLAGS.has(name) || OPTIONAL_VALUE_FLAGS.has(name)) {
        if (value === "" && !OPTIONAL_VALUE_FLAGS.has(name)) {
          valueErrors.push(`Error: ${name} requires a value.`);
        } else {
          assignValue(name, value);
        }
      } else if (BOOLEAN_FLAGS.has(name)) {
        valueErrors.push(`Error: ${name} does not take a value.`);
      } else if (seenKnownToken || !hasKnownToken) {
        unknownFlags.push(arg);
      }
      // Otherwise an unrecognized `--name=value` before the first bascik
      // token: Node's, drop.
      continue;
    }

    if (BOOLEAN_FLAGS.has(arg) || VALUE_FLAGS.has(arg) || OPTIONAL_VALUE_FLAGS.has(arg)) {
      seenKnownToken = true;
      present.add(arg);
      if (VALUE_FLAGS.has(arg)) {
        const next = filtered[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          assignValue(arg, next);
          i++;
        } else {
          valueErrors.push(`Error: ${arg} requires a value.`);
        }
      } else if (OPTIONAL_VALUE_FLAGS.has(arg)) {
        const next = filtered[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          assignValue(arg, next);
          i++;
        } else {
          assignValue(arg, "");
        }
      }
      continue;
    }

    if (arg.startsWith("-")) {
      // Unrecognized leading flags are treated as Node runtime flags (profiler
      // and wrapper resilience) and dropped rather than hard-failing. Once a
      // bascik token has been seen (or none exists at all), an unknown flag is
      // a user error.
      if (seenKnownToken || !hasKnownToken) {
        unknownFlags.push(arg);
      }
      continue;
    }

    // Positional.
    seenKnownToken = true;
    if (KNOWN_SUBCOMMANDS.has(arg)) {
      present.add(arg);
    } else {
      positionals.push(arg);
    }
  }

  const error = (errorMessage: string): CliDecision => ({
    action: "error",
    unknownFlags: unknownFlags.length > 0 ? unknownFlags : undefined,
    errorMessage,
    flags,
  });

  if (unknownFlags.length > 0) {
    if (unknownFlags.length === 1) {
      const hint = suggest(unknownFlags[0]);
      return error(
        `Error: unknown flag "${unknownFlags[0]}".${hint ? ` Did you mean "${hint}"?` : ""}`,
      );
    }
    return error(`Error: unknown flags: ${unknownFlags.join(", ")}`);
  }

  if (valueErrors.length > 0) {
    return error(valueErrors[0]);
  }

  if (present.has("--help") || present.has("-h")) {
    return { action: "help", flags };
  }
  if (present.has("--version") || present.has("-v")) {
    return { action: "version", flags };
  }

  if (positionals.length > 0) {
    const hint = suggest(positionals[0]);
    return error(
      `Error: unexpected argument "${positionals[0]}".${hint ? ` Did you mean "${hint}"?` : ""}`,
    );
  }

  if (present.has("init")) {
    return { action: "init", flags };
  }

  if (present.has("--build") && present.has("--server")) {
    return error(
      "Error: --build and --server cannot be used together. " +
      "Run `bascik --build` to produce the output directory, then `bascik --server` to serve it.",
    );
  }

  const action: CliAction = present.has("--check")
    ? "check"
    : present.has("--server")
      ? "server"
      : present.has("--build")
        ? "build"
        : "dev";

  if (flags.log !== undefined && action !== "build") {
    return error("Error: --log only applies to --build.");
  }

  return { action, flags };
};

export const CLI_USAGE = `Usage: bascik [command] [options]

Commands:
  init               Scaffold a new Bascik project in the current directory

Options:
  (no flags)         Start the dev server with watch mode
  --build            Transpile all pages to the output directory (production build)
  --server           Serve the production build over HTTP/1.1
                     (HTTP/2 when http.tls.enabled is set)
  --check            Validate the project (pages, components, config)
  --log [path]       Also write build output to a log file
                     (only with --build; default: .bascik/build.log)
  --port <n>         Override the server port
                     (overrides BASCIK_SERVER_PORT and http.port)
  --host <name>      Override the server hostname
                     (overrides BASCIK_SERVER_HOST and http.hostname)
  --log-level <lvl>  Override logging.level: silent, error, warn, info, debug
                     (overrides BASCIK_LOG_LEVEL and logging.level)
  --site-url <url>   Set the site URL for this run (overrides BASCIK_SITE_URL and .env)
  --env-file <path>  Load env vars from a file (repeatable; later files win).
                     Defaults to ./.env when present, silently skipped when not
  --config <path>    Load the config from a specific file instead of
                     ./bascik.config.js or ./bascik.config.ts
  -h, --help         Show this help text
  -v, --version      Show the installed Bascik version

All value-taking flags accept both "--flag value" and "--flag=value" forms.
`;

/** Known subcommands exported for use in error messages / tests. */
export const CLI_SUBCOMMANDS = KNOWN_SUBCOMMANDS;
