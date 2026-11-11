/** What `bascik-language-server` should do for a given argument list. */
export type BinMode = "check" | "help" | "missing-transport" | "serve";

export const BIN_USAGE = `Usage:
  bascik-language-server --check [--fix] [--typescript] [--project <dir>] [path ...]
      Lint Bascik files and print one finding per line (exit 1 on errors).
  bascik-language-server --stdio
      Start the language server for an editor (also --node-ipc or --socket=<port>).
  bascik-language-server --help
      Print this message.`;

/** The hint shown when the binary is started without a check flag or a transport. */
export const MISSING_TRANSPORT_HINT =
  "bascik-language-server needs a transport flag (--stdio, --node-ipc or --socket=<port>) or --check. Run it with --help for usage.";

const TRANSPORT_FLAG = /^--(?:stdio|node-ipc|socket(?:=.*)?|pipe(?:=.*)?)$/;

/** Decides the mode and exit code before anything is loaded, so a bare invocation never reaches the connection code. */
export function chooseBinMode(args: readonly string[]): {
  mode: BinMode;
  exitCode: number;
} {
  if (args.some((a) => a === "--help" || a === "-h" || a === "help"))
    return { mode: "help", exitCode: 0 };
  if (args.includes("--check") || args.includes("check"))
    return { mode: "check", exitCode: 0 };
  if (args.some((a) => TRANSPORT_FLAG.test(a)))
    return { mode: "serve", exitCode: 0 };
  return { mode: "missing-transport", exitCode: 1 };
}
