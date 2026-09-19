#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { parseCliOptions } from "./cli.js";
import { scaffold, validateProjectName } from "./scaffold.js";

const args = process.argv.slice(2);
const { yesFlag, noDevFlag } = parseCliOptions(args);
const nameArg = args.find((a) => !a.startsWith("-"));

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

console.log(`\nCreating Bascik project "${projectName}"…\n`);
await scaffold(projectName);
console.log(`✓ Scaffolded ${projectName}/\n`);

let shouldInstall: boolean;
let shouldDev: boolean;

if (yesFlag) {
  shouldInstall = true;
  shouldDev = !noDevFlag;
} else {
  const installAnswer = await rl.question("Install dependencies now? (Y/n) ");
  shouldInstall = installAnswer.trim().toLowerCase() !== "n";
  const devAnswer = await rl.question("Start the dev server after install? (Y/n) ");
  shouldDev = devAnswer.trim().toLowerCase() !== "n";
}

rl.close();

const projectDir = join(process.cwd(), projectName);
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

if (shouldInstall) {
  console.log("\nInstalling dependencies…\n");
  spawnSync(npmCmd, ["install"], { cwd: projectDir, stdio: "inherit" });
}

if (shouldDev) {
  console.log("\nStarting dev server…\n");
  spawnSync(npmCmd, ["run", "dev"], { cwd: projectDir, stdio: "inherit" });
  console.log(`\nTo start again:  cd ${projectName} && npm run dev\n`);
} else {
  console.log("\nNext steps:\n");
  if (!shouldInstall) console.log(`  cd ${projectName}`);
  if (!shouldInstall) console.log("  npm install");
  console.log("  npm run dev\n");
}
