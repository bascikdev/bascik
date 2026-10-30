#!/usr/bin/env node
import { join } from "node:path";
import {
  SKILLS_QUESTION,
  answeredNo,
  createPrompter,
  installSkills,
  skillsLaterLines,
  skillsRef,
  skillsReportLines,
} from "./agent-setup.js";
import { USAGE, parseCliOptions, type CliOptions } from "./cli.js";
import { runNpm } from "./npm.js";
import {
  BASCIK_VERSION,
  scaffold,
  validateProjectName,
  type Template,
} from "./scaffold.js";

const args = process.argv.slice(2);

let options: CliOptions;
try {
  options = parseCliOptions(args);
} catch (err) {
  console.error(`\nError: ${(err as Error).message}\n`);
  process.exit(1);
}
if (options.helpFlag) {
  console.log(USAGE);
  process.exit(0);
}
const {
  yesFlag,
  noDevFlag,
  noInstallFlag,
  noSkillsFlag,
  template: templateArg,
  projectName: nameArg,
} = options;

// Without a terminal, such as in CI with no -y, piped answers are used and
// every question after the input ends takes its default.
const rl = createPrompter();

let projectName: string;

if (nameArg) {
  projectName = nameArg;
} else {
  const answer = await rl.ask("Project name (bascik-app): ");
  projectName = answer.trim() || "bascik-app";
}

const error = validateProjectName(projectName);
if (error) {
  rl.close();
  console.error(`\nError: ${error}\n`);
  process.exit(1);
}

let template: Template;

if (templateArg) {
  template = templateArg;
} else if (yesFlag) {
  template = "default";
} else {
  const cloudflareAnswer = await rl.ask("Deploy to Cloudflare Workers? (y/N) ");
  // The other prompts default to yes, so "yes" typed in full is accepted here too.
  template = /^y(es)?$/i.test(cloudflareAnswer.trim())
    ? "cloudflare"
    : "default";
}

console.log(`\nCreating Bascik project "${projectName}"…\n`);
const { notes } = await scaffold(projectName, process.cwd(), { template });
console.log(`✓ Scaffolded ${projectName}/\n`);
for (const note of notes) console.log(`  ${note}`);

/** A yes/no question that defaults to yes. Its `--no-*` flag always wins, and -y answers yes. */
const confirm = async (question: string, skip: boolean): Promise<boolean> =>
  skip ? false : yesFlag ? true : !answeredNo(await rl.ask(question));

const shouldInstallSkills = await confirm(SKILLS_QUESTION, noSkillsFlag);
const shouldInstall = await confirm(
  "Install dependencies now? (Y/n) ",
  noInstallFlag,
);
const shouldDev = await confirm(
  "Start the dev server after install? (Y/n) ",
  noDevFlag,
);

rl.close();

const projectDir = join(process.cwd(), projectName);

/** Printed when the skills were declined, as bascik init does, so the pinned command is not lost. */
const skillsLater = shouldInstallSkills
  ? []
  : [
      `To install the Bascik agent skills later, run this in ${projectName}:`,
      ...skillsLaterLines(skillsRef(BASCIK_VERSION)),
      "",
    ];

if (shouldInstallSkills) {
  console.log("\nInstalling the Bascik agent skills…");
  const result = installSkills(projectDir, { version: BASCIK_VERSION });
  for (const line of skillsReportLines(result)) console.log(line);
}

if (shouldInstall) {
  console.log("\nInstalling dependencies…\n");
  const installed = runNpm(["install"], projectDir);
  if (installed.error)
    console.error(
      `\nCould not run npm: ${installed.error}\nRun "npm install" in ${projectName} yourself.\n`,
    );
}

if (shouldDev) {
  if (skillsLater.length > 0) console.log(`\n${skillsLater.join("\n")}`);
  console.log("\nStarting dev server…\n");
  const started = runNpm(["run", "dev"], projectDir);
  if (started.error)
    console.error(
      `\nCould not run npm: ${started.error}\nRun "npm run dev" in ${projectName} yourself.\n`,
    );
  console.log(`\nTo start again:  cd ${projectName} && npm run dev\n`);
} else {
  console.log("\nNext steps:\n");
  if (!shouldInstall) console.log(`  cd ${projectName}`);
  if (!shouldInstall) console.log("  npm install");
  console.log("  npm run dev\n");
  for (const line of skillsLater) console.log(line);
}

if (template === "cloudflare") {
  console.log("To preview in workerd:  npm run build && npm run preview");
  console.log("To deploy:              npm run build && npm run deploy\n");
}
