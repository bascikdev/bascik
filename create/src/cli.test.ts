import { describe, expect, it } from "vitest";
import { UsageError, parseCliOptions } from "./cli.js";

describe("parseCliOptions", () => {
  it("keeps the defaults", () => {
    expect(parseCliOptions([])).toEqual({ yesFlag: false, noDevFlag: false, helpFlag: false });
  });

  it("reads the project name and the existing flags in any order", () => {
    expect(parseCliOptions(["--no-dev", "-y", "my-site"])).toEqual({ yesFlag: true, noDevFlag: true, helpFlag: false, projectName: "my-site" });
  });

  it.each([
    [["site", "--example", "blog"]],
    [["site", "--example=blog"]],
    [["site", "-e", "blog"]],
    [["--example", "blog", "site"]],
    [["-e", "blog", "site"]],
  ])("never mistakes the example for the project name: %j", (args) => {
    expect(parseCliOptions(args)).toMatchObject({ projectName: "site", example: "blog" });
  });

  it("takes a link with an equals sign in it", () => {
    expect(parseCliOptions(["--example=https://github.com/o/r/tree/main/a=b"]).example).toBe("https://github.com/o/r/tree/main/a=b");
  });

  it("reads --example-path in both forms", () => {
    expect(parseCliOptions(["-e", "https://github.com/o/r", "--example-path", "a/b"]).examplePath).toBe("a/b");
    expect(parseCliOptions(["-e", "https://github.com/o/r", "--example-path=a/b"]).examplePath).toBe("a/b");
  });

  it("leaves a project name with no example", () => {
    expect(parseCliOptions(["site"]).example).toBeUndefined();
  });

  it("treats everything after -- as the project name", () => {
    expect(parseCliOptions(["--", "-weird"]).projectName).toBe("-weird");
  });

  it("supports --help", () => {
    expect(parseCliOptions(["-h"]).helpFlag).toBe(true);
    expect(parseCliOptions(["--help"]).helpFlag).toBe(true);
  });

  it.each([
    [["--exmaple", "blog"], /Unknown option "--exmaple"/],
    [["--example"], /--example needs a value/],
    [["-e"], /-e needs a value/],
    [["--example="], /--example needs a value/],
    [["--example", "--yes"], /--example needs a value/],
    [["-e", "blog", "--example", "other"], /more than once/],
    [["-e=blog"], /Unknown option "-e=blog"/],
    [["a", "b"], /Unexpected argument "b"/],
    [["--example-path", "x"], /--example-path needs --example/],
    [["--yes=true"], /Unknown option/],
    [["-x"], /Unknown option "-x"/],
  ])("rejects %j", (args, message) => {
    expect(() => parseCliOptions(args)).toThrow(UsageError);
    expect(() => parseCliOptions(args)).toThrow(message);
  });
});
