import { TEMPLATES, type Template } from "./scaffold.js";

export interface CliOptions {
  yesFlag: boolean;
  noDevFlag: boolean;
  noInstallFlag: boolean;
  /** `--no-skills`: do not ask about or install the agent skills. */
  noSkillsFlag: boolean;
  /** Left undefined when no `--template` flag was given so the entry can ask interactively. */
  template?: Template;
  /** The first positional argument, the project name, with flag values excluded. */
  projectName?: string;
  /** `--help` or `-h`: print the usage and exit 0, before anything else. */
  helpFlag: boolean;
}

/** `static` is accepted as a synonym because the default starter is a plain static site. */
const TEMPLATE_ALIASES: Record<string, Template> = { static: "default" };

const templateChoices = (): string =>
  [...TEMPLATES, ...Object.keys(TEMPLATE_ALIASES)].join(", ");

const parseTemplate = (value: string | undefined): Template => {
  if (value === undefined || value === "" || value.startsWith("-")) {
    throw new Error(
      `--template needs a value. Choose one of: ${templateChoices()}.`,
    );
  }
  const name = value.toLowerCase();
  if ((TEMPLATES as readonly string[]).includes(name)) return name as Template;
  if (Object.prototype.hasOwnProperty.call(TEMPLATE_ALIASES, name))
    return TEMPLATE_ALIASES[name];
  throw new Error(
    `Unknown template "${value}". Choose one of: ${templateChoices()}.`,
  );
};

/**
 * The form the docs recommend. npm keeps any flag that comes before `--` for
 * itself, so this is what the error messages point users back to.
 */
const NPM_CREATE_EXAMPLE =
  "npm create bascik@rc my-site -- --template cloudflare";

const unexpectedArgument = (arg: string): Error =>
  new Error(
    `Unexpected argument "${arg}". When running through npm create, put flags after "--": ${NPM_CREATE_EXAMPLE}`,
  );

/** Every flag create-bascik reads. */
export const CLI_FLAGS = [
  "-h",
  "--help",
  "-y",
  "--yes",
  "--no-install",
  "--no-dev",
  "--no-skills",
  "--template",
] as const;

/** Edit distance, for suggesting the flag a typo meant. */
const distance = (a: string, b: string): number => {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(
        prev[j] + 1,
        next[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = next;
  }
  return prev[b.length];
};

const unknownFlag = (arg: string): Error => {
  const name = arg.split("=")[0];
  const best = [...CLI_FLAGS]
    .map((flag) => ({ flag, d: distance(name, flag) }))
    .sort((a, b) => a.d - b.d)[0];
  const hint = best.d <= 3 ? ` Did you mean "${best.flag}"?` : "";
  return new Error(
    `Unknown option "${arg}".${hint} create-bascik accepts ${CLI_FLAGS.join(", ")}.`,
  );
};

/**
 * npm keeps a `--no-<name>` written before `--` for itself and exports it as
 * `npm_config_<name>`, set to the empty string (npm 11 writes a false boolean
 * that way). `"false"` is accepted too, for `--<name>=false` on older npm.
 */
const npmConfigIsFalse = (value: string | undefined): boolean =>
  value === "" || value === "false";

/**
 * Parse the CLI arguments. `--template` takes its value either as the next token
 * or after `=`, so the project name is whichever positional is left over.
 * Throws on an unknown flag, naming the closest one, on an unknown or missing template value, and on a second positional
 * because that is what npm hands over when `--template cloudflare` was given
 * before `--`: npm keeps the flag and forwards its value as a plain argument.
 *
 * npm exposes the flags it consumed as `npm_config_*` environment variables.
 * `-y` becomes `npm_config_yes=true`, which is honored so the documented
 * `npm create bascik@rc my-site -y` skips every prompt (and npm's own install
 * prompt, which is why that flag belongs before `--`). `--template=<name>`
 * becomes `npm_config_template=<name>` and is honored too, while the two-token
 * form only yields `npm_config_template=true`, so that case is reported instead
 * of being guessed at. `--no-skills` and `--no-install` are honored through
 * `npm_config_skills` and `npm_config_install`; `--no-dev` leaves no trace.
 */
export function parseCliOptions(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): CliOptions {
  // Help wins over everything else on the line, even a mistake elsewhere in it.
  if (args.includes("--help") || args.includes("-h")) {
    return {
      helpFlag: true,
      yesFlag: false,
      noDevFlag: false,
      noInstallFlag: false,
      noSkillsFlag: false,
    };
  }
  let template: Template | undefined;
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--template") {
      template = parseTemplate(args[i + 1]);
      i++;
    } else if (arg.startsWith("--template=")) {
      template = parseTemplate(arg.slice("--template=".length));
    } else if (!arg.startsWith("-")) {
      positionals.push(arg);
    } else if (!(CLI_FLAGS as readonly string[]).includes(arg)) {
      // A typo such as --no-skill would otherwise be ignored and do the opposite of what was meant.
      throw unknownFlag(arg);
    }
  }

  if (positionals.length > 1) throw unexpectedArgument(positionals[1]);

  const envTemplate = env.npm_config_template;
  if (template === undefined && envTemplate !== undefined) {
    if (envTemplate === "true") {
      throw new Error(
        `npm kept --template for itself and dropped its value. Put flags after "--": ${NPM_CREATE_EXAMPLE}`,
      );
    }
    template = parseTemplate(envTemplate);
  }

  return {
    yesFlag:
      args.includes("-y") ||
      args.includes("--yes") ||
      env.npm_config_yes === "true",
    // npm consumes `--no-dev` written before `--` as its own deprecated `dev`
    // setting and exports nothing, so only the form after `--` can be read.
    noDevFlag: args.includes("--no-dev"),
    noInstallFlag:
      args.includes("--no-install") || npmConfigIsFalse(env.npm_config_install),
    noSkillsFlag:
      args.includes("--no-skills") || npmConfigIsFalse(env.npm_config_skills),
    template,
    projectName: positionals[0],
    helpFlag: false,
  };
}

/** What `npm create bascik -- --help` prints. */
export const USAGE = `Usage: npm create bascik@rc [project-name] -- [options]

Creates a new Bascik project in ./<project-name> (asks for a name when none is given).

Options:
  --template <name>  The starter: ${TEMPLATES.join(", ")} (alias: static). Asks when not given.
  -y, --yes          Answer every question with its default: the default template,
                     install the agent skills, install dependencies, start the dev server
  --no-skills        Do not install the Bascik agent skills
  --no-install       Do not run npm install
  --no-dev           Do not start the dev server
  -h, --help         Show this help text

npm keeps flags written before "--" for itself, so put them after it:
  ${NPM_CREATE_EXAMPLE}
`;
