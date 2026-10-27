import { TEMPLATES, type Template } from "./scaffold.js";

export interface CliOptions {
  yesFlag: boolean;
  noDevFlag: boolean;
  noInstallFlag: boolean;
  /** Left undefined when no `--template` flag was given so the entry can ask interactively. */
  template?: Template;
  /** The first positional argument, the project name, with flag values excluded. */
  projectName?: string;
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

/**
 * Parse the CLI arguments. `--template` takes its value either as the next token
 * or after `=`, so the project name is whichever positional is left over.
 * Throws on an unknown or missing template value, and on a second positional
 * because that is what npm hands over when `--template cloudflare` was given
 * before `--`: npm keeps the flag and forwards its value as a plain argument.
 *
 * npm exposes the flags it consumed as `npm_config_*` environment variables.
 * `-y` becomes `npm_config_yes=true`, which is honored so the documented
 * `npm create bascik@rc my-site -y` skips every prompt (and npm's own install
 * prompt, which is why that flag belongs before `--`). `--template=<name>`
 * becomes `npm_config_template=<name>` and is honored too, while the two-token
 * form only yields `npm_config_template=true`, so that case is reported instead
 * of being guessed at.
 */
export function parseCliOptions(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): CliOptions {
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
    noDevFlag: args.includes("--no-dev"),
    noInstallFlag: args.includes("--no-install"),
    template,
    projectName: positionals[0],
  };
}
