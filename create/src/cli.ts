export interface CliOptions {
  yesFlag: boolean;
  noDevFlag: boolean;
  helpFlag: boolean;
  /** The project name, when one was given as a positional argument. */
  projectName?: string;
  /** Value of `--example` / `-e`: an official id or a GitHub link. */
  example?: string;
  /** Value of `--example-path`. */
  examplePath?: string;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export const USAGE = `Usage: create-bascik [project-name] [options]

Options:
  -y, --yes                 Accept the defaults without prompting
      --no-dev              With --yes, install but do not start the dev server
  -e, --example <name|url>  Start from an official example or a public GitHub link
      --example-path <dir>  Folder inside the GitHub repository to use
  -h, --help                Show this help

Examples:
  create-bascik my-site
  create-bascik my-blog --example blog
  create-bascik my-app --example https://github.com/owner/repo/tree/main/starter
`;

/** Flags that take a value, in both "--flag value" and "--flag=value" forms. */
const VALUE_FLAGS = new Map<string, "example" | "examplePath">([
  ["--example", "example"],
  ["-e", "example"],
  ["--example-path", "examplePath"],
]);

/**
 * Parse arguments. A flag's value is consumed with it, so an example name or link is never
 * mistaken for the project name. Unknown flags are rejected: a typo such as `--exmaple` would
 * otherwise silently scaffold the default starter.
 */
export function parseCliOptions(args: string[]): CliOptions {
  const options: CliOptions = { yesFlag: false, noDevFlag: false, helpFlag: false };
  const positional: string[] = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (arg === "-y" || arg === "--yes") {
      options.yesFlag = true;
    } else if (arg === "--no-dev") {
      options.noDevFlag = true;
    } else if (arg === "-h" || arg === "--help") {
      options.helpFlag = true;
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    } else {
      const equals = arg.indexOf("=");
      const name = equals === -1 ? arg : arg.slice(0, equals);
      const key = VALUE_FLAGS.get(name);
      if (!key || (equals !== -1 && !name.startsWith("--"))) {
        throw new UsageError(`Unknown option "${arg}".`);
      }
      let value: string | undefined;
      if (equals !== -1) {
        value = arg.slice(equals + 1);
      } else {
        value = args[++index];
        if (value === undefined || value.startsWith("-")) {
          throw new UsageError(`${name} needs a value.`);
        }
      }
      if (value === "") throw new UsageError(`${name} needs a value.`);
      if (options[key] !== undefined) throw new UsageError(`${name} was given more than once.`);
      options[key] = value;
    }
  }

  if (positional.length > 1) {
    throw new UsageError(`Unexpected argument "${positional[1]}". Pass one project name.`);
  }
  if (positional.length === 1) options.projectName = positional[0];
  if (options.examplePath !== undefined && options.example === undefined) {
    throw new UsageError("--example-path needs --example.");
  }
  return options;
}