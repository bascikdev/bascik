export interface CliOptions {
  yesFlag: boolean;
  noDevFlag: boolean;
}

export function parseCliOptions(args: string[]): CliOptions {
  return {
    yesFlag: args.includes("-y") || args.includes("--yes"),
    noDevFlag: args.includes("--no-dev"),
  };
}