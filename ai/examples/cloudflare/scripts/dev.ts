/**
 * Serve the built example in local workerd: `wrangler dev` with the wrapper
 * config, local secrets that exist only for development, and the Durable
 * Objects' data kept in a folder that survives a restart.
 *
 *   PORT                  default 9879
 *   PERSIST_DIR           default .wrangler-state (relative to this folder)
 *   DEMO_MODEL_DELAY_MS   the scripted model's pace, default the config's
 *
 * Run `yarn build` first (`yarn dev` does). Never deploys anything.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const port = process.env.PORT ?? "9879";
const persist = process.env.PERSIST_DIR ?? ".wrangler-state";

const vars: Record<string, string> = {
  // Development only. Production sets real secrets (README.md).
  IP_SALT: "local-development-only",
  SESSION_SECRET: "local-development-only",
  GENUI_DEVELOPMENT: "1",
};
if (process.env.DEMO_MODEL_DELAY_MS) {
  vars.DEMO_MODEL_DELAY_MS = process.env.DEMO_MODEL_DELAY_MS;
}
for (const name of ["GENUI_IP_SENDS", "GENUI_IP_READERS"]) {
  if (process.env[name]) vars[name] = process.env[name];
}

const args = [
  "wrangler",
  "dev",
  "--config",
  "wrangler.wrapper.jsonc",
  "--local",
  "--ip",
  "127.0.0.1",
  "--port",
  port,
  "--persist-to",
  persist,
  "--show-interactive-dev-session=false",
  ...Object.entries(vars).flatMap(([name, value]) => [
    "--var",
    `${name}:${value}`,
  ]),
];

const child = spawn("npx", args, { cwd: root, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
