#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { parseCliOptions, type CliOptions } from "./cli.js";
import { runNpm } from "./npm.js";
import { scaffold, validateProjectName, type Template } from "./scaffold.js";

const args = process.argv.slice(2);

let options: CliOptions;
try {
  options = parseCliOptions(args);
} catch (err) {
  console.error(`\nError: ${(err as Error).message}\n`);
  process.exit(1);
}
const {
  yesFlag,
  noDevFlag,
  noInstallFlag,
  template: templateArg,
  projectName: nameArg,
} = options;

const rl = createInterface({ input: process.stdin, output: process.stdout });

let projectName: string;

if (nameArg) {
  projectName = nameArg;
} else {
  const answer = await rl.question("Project name (bascik-app): ");
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
  const cloudflareAnswer = await rl.question(
    "Deploy to Cloudflare Workers? (y/N) ",
  );
  // The other prompts default to yes, so "yes" typed in full is accepted here too.
  template = /^y(es)?$/i.test(cloudflareAnswer.trim())
    ? "cloudflare"
    : "default";
}

console.log(`\nCreating Bascik project "${projectName}"…\n`);
await scaffold(projectName, process.cwd(), { template });
console.log(`✓ Scaffolded ${projectName}/\n`);

let shouldInstall: boolean;
let shouldDev: boolean;

if (yesFlag) {
  shouldInstall = !noInstallFlag;
  shouldDev = !noDevFlag;
} else {
  const installAnswer = await rl.question("Install dependencies now? (Y/n) ");
  shouldInstall = installAnswer.trim().toLowerCase() !== "n";
  const devAnswer = await rl.question(
    "Start the dev server after install? (Y/n) ",
  );
  shouldDev = devAnswer.trim().toLowerCase() !== "n";
}

rl.close();

const projectDir = join(process.cwd(), projectName);

if (shouldInstall) {
  console.log("\nInstalling dependencies…\n");
  const installed = runNpm(["install"], projectDir);
  if (installed.error)
    console.error(
      `\nCould not run npm: ${installed.error}\nRun "npm install" in ${projectName} yourself.\n`,
    );
}

if (shouldDev) {
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
}

if (template === "cloudflare") {
  console.log("To preview in workerd:  npm run build && npm run preview");
  console.log("To deploy:              npm run build && npm run deploy\n");
}
