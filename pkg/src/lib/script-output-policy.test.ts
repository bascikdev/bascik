/**
 * The one rule every host settles a server or stream script by: what a
 * returned or yielded value prints, what happens to a value that is not
 * markup, and what a failure becomes under `scripts.onServerScriptError`.
 *
 * Node (`server-scripts.ts`), the Cloudflare Worker and the Netlify function
 * each used to carry their own copy of this; they now call
 * `settleScriptOutput` and `scriptJobOutput` with a policy that names only
 * what differs between them (where a log goes, how a failure is described,
 * which error class is thrown, how "once per script" is remembered). These
 * tests pin the shared behavior once, with a policy made of spies.
 *
 * Misuse lens: a value that is not markup, a `toString` that throws, a
 * hostile getter, an aborted request, a timeout, a host hook that throws,
 * and a policy missing its optional hooks.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { encodeOutputScope } from "./output-scope.ts";
import { invokeWithDeadline } from "./request-execution.ts";
import {
  scriptJobOutput,
  settleScriptOutput,
  type ScriptOutputPolicy,
  type ScriptSettleResult,
} from "./script-output-policy.ts";

const HTML = Symbol.for("bascik.html");
const URL_ = "https://example.test/orders?q=1";

type Spied = ScriptOutputPolicy & {
  warn: ReturnType<typeof vi.fn<(message: string) => void>>;
  firstRefusal: ReturnType<typeof vi.fn<() => boolean>>;
  describeFailure: ReturnType<
    typeof vi.fn<(error: Error, result: ScriptSettleResult) => string>
  >;
};

/** A production policy under "error" whose every hook is a spy. */
const policy = (overrides: Partial<ScriptOutputPolicy> = {}): Spied =>
  ({
    onServerScriptError: "error",
    production: true,
    requestUrl: URL_,
    owner: "stream script in src/pages/orders.html:12",
    warn: vi.fn(),
    firstRefusal: vi.fn(() => true),
    describeFailure: vi.fn((error: Error) => `described: ${error.message}`),
    ...overrides,
  }) as Spied;

const ok = (value: unknown): ScriptSettleResult => ({ ok: true, value });
const failed = (
  error: Error,
  extra: Partial<ScriptSettleResult> = {},
): ScriptSettleResult => ({ ok: false, error, ...extra });

describe("settleScriptOutput: what a value prints", () => {
  it("prints markup by the shared rule: a string as it is, an html value, an array joined, a number; nothing for null, undefined and false", () => {
    const p = policy();
    expect(settleScriptOutput(ok("<p>a</p>"), false, p)).toBe("<p>a</p>");
    expect(settleScriptOutput(ok({ [HTML]: "<b>x</b>" }), false, p)).toBe(
      "<b>x</b>",
    );
    expect(settleScriptOutput(ok(["<i>", ["a"], "</i>"]), false, p)).toBe(
      "<i>a</i>",
    );
    expect(settleScriptOutput(ok(42), false, p)).toBe("42");
    for (const empty of [null, undefined, false])
      expect(settleScriptOutput(ok(empty), false, p)).toBe("");
    expect(p.warn).not.toHaveBeenCalled();
    expect(p.describeFailure).not.toHaveBeenCalled();
  });

  it("strips terminal color codes unless stripAnsi is false", () => {
    const colored = "<li>\u001b[31mred\u001b[0m</li>";
    expect(settleScriptOutput(ok(colored), false, policy())).toBe(
      "<li>red</li>",
    );
    expect(
      settleScriptOutput(ok(colored), false, policy({ stripAnsi: true })),
    ).toBe("<li>red</li>");
    expect(
      settleScriptOutput(ok(colored), false, policy({ stripAnsi: false })),
    ).toBe(colored);
  });

  it("applies a component's output scope to the printed markup, and leaves a page script's output alone", () => {
    const outputScope = encodeOutputScope({
      classes: { row: "bascik__orders__row" },
      elements: {},
    });
    const scoped = settleScriptOutput(
      ok('<li class="row">x</li>'),
      false,
      policy({ outputScope }),
    );
    expect(scoped).toContain("bascik__orders__row");
    expect(
      settleScriptOutput(ok('<li class="row">x</li>'), false, policy()),
    ).toBe('<li class="row">x</li>');
  });

  it("strips color codes before scoping, so a code inside a tag cannot hide its class", () => {
    const outputScope = encodeOutputScope({
      classes: { row: "bascik__orders__row" },
      elements: {},
    });
    const out = settleScriptOutput(
      ok('<li class="\u001b[1mrow\u001b[0m">x</li>'),
      false,
      policy({ outputScope }),
    );
    expect(out).toContain("bascik__orders__row");
  });

  it("misuse: an undecodable output scope leaves the markup as printed instead of throwing", () => {
    expect(
      settleScriptOutput(ok("<p>a</p>"), false, policy({ outputScope: "%%%" })),
    ).toBe("<p>a</p>");
  });
});

describe("settleScriptOutput: a value that is not markup, in production", () => {
  it("is an empty output with one located warning that says the slot is empty", () => {
    const p = policy();
    expect(settleScriptOutput(ok({ title: "Dune" }), false, p)).toBe("");
    expect(p.firstRefusal).toHaveBeenCalledTimes(1);
    expect(p.warn).toHaveBeenCalledTimes(1);
    const message = p.warn.mock.calls[0][0];
    expect(message).toContain('[bascik] server script error at "/orders"');
    expect(message).toContain(
      "The stream script in src/pages/orders.html:12 returned an object ([object Object])",
    );
    expect(message).toContain("The slot is empty");
    expect(p.describeFailure).not.toHaveBeenCalled();
  });

  it("never throws, whatever the policy says about failures", () => {
    for (const onServerScriptError of ["error", "warn", "ignore"] as const)
      expect(
        settleScriptOutput(
          ok(() => "fn"),
          false,
          policy({ onServerScriptError }),
        ),
      ).toBe("");
  });

  it("is logged only when the host says this is the script's first refusal", () => {
    const p = policy({ firstRefusal: vi.fn(() => false) });
    expect(settleScriptOutput(ok({}), false, p)).toBe("");
    expect(p.firstRefusal).toHaveBeenCalledTimes(1);
    expect(p.warn).not.toHaveBeenCalled();
  });

  it('under "ignore" nothing is logged and the first refusal is not used up', () => {
    const p = policy({ onServerScriptError: "ignore" });
    expect(settleScriptOutput(ok({}), false, p)).toBe("");
    expect(p.firstRefusal).not.toHaveBeenCalled();
    expect(p.warn).not.toHaveBeenCalled();
  });

  it("a yielded value says yielded and that only that value is skipped", () => {
    const p = policy();
    expect(settleScriptOutput(ok({}), true, p)).toBe("");
    const message = p.warn.mock.calls[0][0];
    expect(message).toContain("yielded an object");
    expect(message).toContain("That value is skipped");
    expect(message).not.toContain("The slot is empty");
  });

  it("without an owner the message still names the script", () => {
    const p = policy({ owner: undefined });
    settleScriptOutput(ok(Symbol("s")), false, p);
    expect(p.warn.mock.calls[0][0]).toContain("The script returned a symbol");
  });
});

describe("settleScriptOutput: a value that is not markup, in development", () => {
  const dev = (onServerScriptError: "error" | "warn" | "ignore") =>
    policy({ production: false, onServerScriptError });

  it('under "error" it throws the located message, without the production note, through the host\'s error class', () => {
    class HostError extends Error {}
    const p = policy({
      production: false,
      createError: (message) => new HostError(message),
    });
    let thrown: unknown;
    try {
      settleScriptOutput(ok([Promise.resolve("x")]), false, p);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HostError);
    const message = (thrown as Error).message;
    expect(message).toContain("returned an array holding a Promise at [0]");
    expect(message).not.toContain("The slot is empty");
    expect(p.warn).not.toHaveBeenCalled();
    expect(p.firstRefusal).not.toHaveBeenCalled();
  });

  it('under "warn" it logs every time, with no once-per-script gate, and the output is empty', () => {
    const p = dev("warn");
    expect(settleScriptOutput(ok({}), false, p)).toBe("");
    expect(settleScriptOutput(ok({}), false, p)).toBe("");
    expect(p.warn).toHaveBeenCalledTimes(2);
    expect(p.firstRefusal).not.toHaveBeenCalled();
  });

  it('under "ignore" the output is empty and nothing is logged', () => {
    const p = dev("ignore");
    expect(settleScriptOutput(ok({}), false, p)).toBe("");
    expect(p.warn).not.toHaveBeenCalled();
  });

  it("a yielded value is worded as a yield", () => {
    expect(() => settleScriptOutput(ok({}), true, dev("error"))).toThrow(
      /yielded an object/,
    );
  });

  it("without createError it throws a plain Error", () => {
    let thrown: unknown;
    try {
      settleScriptOutput(ok({}), false, dev("error"));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).constructor).toBe(Error);
  });
});

describe("settleScriptOutput: a failed call or pull", () => {
  it('under "error" it throws the framed report the host described', () => {
    const boom = new Error("boom");
    const p = policy();
    const result = failed(boom);
    expect(() => settleScriptOutput(result, false, p)).toThrow(
      '[bascik] server script error at "/orders":\ndescribed: boom',
    );
    expect(p.describeFailure).toHaveBeenCalledWith(boom, result);
    expect(p.warn).not.toHaveBeenCalled();
  });

  it('under "warn" it logs that report and the output is empty', () => {
    const p = policy({ onServerScriptError: "warn" });
    expect(settleScriptOutput(failed(new Error("boom")), false, p)).toBe("");
    expect(p.warn).toHaveBeenCalledWith(
      '[bascik] server script error at "/orders":\ndescribed: boom',
    );
  });

  it('under "ignore" the output is empty, nothing is logged and the failure is not even described', () => {
    const p = policy({ onServerScriptError: "ignore" });
    expect(settleScriptOutput(failed(new Error("boom")), false, p)).toBe("");
    expect(p.warn).not.toHaveBeenCalled();
    expect(p.describeFailure).not.toHaveBeenCalled();
  });

  it("is the same in development and production", () => {
    for (const production of [true, false])
      expect(() =>
        settleScriptOutput(
          failed(new Error("boom")),
          false,
          policy({ production }),
        ),
      ).toThrow(/described: boom/);
  });

  it("throws through the host's error class", () => {
    class HostError extends Error {}
    expect(() =>
      settleScriptOutput(
        failed(new Error("boom")),
        false,
        policy({ createError: (message) => new HostError(message) }),
      ),
    ).toThrow(HostError);
  });

  it('a client that went away is an empty output with no report, even under "error"', () => {
    const p = policy();
    expect(
      settleScriptOutput(
        failed(new Error("gone"), { aborted: true, timedOut: false }),
        false,
        p,
      ),
    ).toBe("");
    expect(p.describeFailure).not.toHaveBeenCalled();
    expect(p.warn).not.toHaveBeenCalled();
  });

  it("a timeout is reported, and the host is told it was one", () => {
    const p = policy();
    const result = failed(new Error("Script execution timed out after 30ms"), {
      timedOut: true,
    });
    expect(() => settleScriptOutput(result, false, p)).toThrow(/timed out/);
    expect(p.describeFailure.mock.calls[0][1]).toBe(result);
    expect(p.describeFailure.mock.calls[0][1].timedOut).toBe(true);
  });

  it("a failure the host calls silent (a socket reset) is an empty output with no report", () => {
    const reset = failed(new Error("ECONNRESET"), {
      thrown: { code: "ECONNRESET" },
    });
    const isSilentFailure = vi.fn(
      (result: ScriptSettleResult) =>
        (result.thrown as { code?: string })?.code === "ECONNRESET",
    );
    const p = policy({ isSilentFailure });
    expect(settleScriptOutput(reset, false, p)).toBe("");
    expect(isSilentFailure).toHaveBeenCalledWith(reset);
    expect(p.describeFailure).not.toHaveBeenCalled();
    // Any other failure still reports.
    expect(() =>
      settleScriptOutput(failed(new Error("boom")), false, p),
    ).toThrow(/boom/);
  });

  it("misuse: a failed result that carries no error still reports one", () => {
    const p = policy();
    expect(() => settleScriptOutput({ ok: false }, false, p)).toThrow(
      /described: Server script failed/,
    );
  });

  it("is the same for a pull (yielded) as for a call", () => {
    expect(() =>
      settleScriptOutput(failed(new Error("row failed")), true, policy()),
    ).toThrow(
      '[bascik] server script error at "/orders":\ndescribed: row failed',
    );
  });
});

describe("settleScriptOutput: the author's own toString", () => {
  const throwing = {
    toString() {
      throw new RangeError("toString blew up");
    },
  };

  it("a toString that throws is the script failing: it follows the failure policy, not the refusal one", () => {
    const p = policy();
    expect(() => settleScriptOutput(ok(throwing), false, p)).toThrow(
      /described: toString blew up/,
    );
    expect(p.describeFailure.mock.calls[0][0]).toBeInstanceOf(RangeError);
    // The host is handed a failed result, never the ok one it passed in.
    expect(p.describeFailure.mock.calls[0][1].ok).toBe(false);
    expect(p.firstRefusal).not.toHaveBeenCalled();
  });

  it('under "warn" it is logged and the output is empty; under "ignore" it is silent', () => {
    const warn = policy({ onServerScriptError: "warn" });
    expect(settleScriptOutput(ok(throwing), false, warn)).toBe("");
    expect(warn.warn).toHaveBeenCalledTimes(1);
    const ignore = policy({ onServerScriptError: "ignore" });
    expect(settleScriptOutput(ok(throwing), false, ignore)).toBe("");
    expect(ignore.warn).not.toHaveBeenCalled();
  });

  it("a toString that throws something that is not an Error is reported as one", () => {
    const p = policy();
    expect(() =>
      settleScriptOutput(
        ok({
          toString() {
            // eslint-disable-next-line no-throw-literal
            throw "just a string";
          },
        }),
        false,
        p,
      ),
    ).toThrow(/described: just a string/);
  });

  it("it is reported even when the request was not aborted and no silent rule applies to it", () => {
    const isSilentFailure = vi.fn(() => false);
    expect(() =>
      settleScriptOutput(ok(throwing), false, policy({ isSilentFailure })),
    ).toThrow(/toString blew up/);
  });
});

describe("settleScriptOutput: the result it is given is never changed", () => {
  it("leaves the caller's result object as it was", () => {
    const result = ok({
      toString() {
        throw new Error("x");
      },
    });
    const before = { ...result };
    expect(() => settleScriptOutput(result, false, policy())).toThrow();
    expect(result).toEqual(before);
  });
});

describe("scriptJobOutput", () => {
  it("a call that returned is settled as one string", () => {
    const p = policy();
    expect(scriptJobOutput(ok("<p>a</p>"), p)).toBe("<p>a</p>");
  });

  it("a call that failed follows the policy at once", () => {
    expect(() => scriptJobOutput(failed(new Error("boom")), policy())).toThrow(
      /described: boom/,
    );
    expect(
      scriptJobOutput(
        failed(new Error("boom")),
        policy({ onServerScriptError: "ignore" }),
      ),
    ).toBe("");
  });

  it("a script that yields gives an iterable: each value settled as a yield, by the same policy", async () => {
    const invoked = await invokeWithDeadline(
      async function* () {
        yield "<li>\u001b[31mone\u001b[0m</li>";
        yield null;
        yield ["<li>", "two", "</li>"];
        yield { title: "not markup" };
        yield "<li>three</li>";
      },
      { chunks: true },
    );
    const p = policy();
    const output = scriptJobOutput(invoked, p);
    expect(typeof output).not.toBe("string");
    const chunks: string[] = [];
    for await (const chunk of output as AsyncIterable<string>)
      chunks.push(chunk);
    expect(chunks).toEqual(["<li>one</li>", "<li>two</li>", "<li>three</li>"]);
    expect(p.warn).toHaveBeenCalledTimes(1);
    expect(p.warn.mock.calls[0][0]).toContain("yielded an object");
  });

  it('a pull that fails under "error" throws from next(), after the values already given', async () => {
    const invoked = await invokeWithDeadline(
      async function* () {
        yield "<li>one</li>";
        throw new Error("row two failed");
      },
      { chunks: true },
    );
    const iterator = (
      scriptJobOutput(invoked, policy()) as AsyncIterable<string>
    )[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toBe("<li>one</li>");
    await expect(iterator.next()).rejects.toThrow(
      '[bascik] server script error at "/orders":\ndescribed: row two failed',
    );
    expect((await iterator.next()).done).toBe(true);
  });

  it('a pull that fails under "warn" ends the output there and logs once', async () => {
    const invoked = await invokeWithDeadline(
      async function* () {
        yield "<li>one</li>";
        throw new Error("row two failed");
      },
      { chunks: true },
    );
    const p = policy({ onServerScriptError: "warn" });
    const chunks: string[] = [];
    for await (const chunk of scriptJobOutput(
      invoked,
      p,
    ) as AsyncIterable<string>)
      chunks.push(chunk);
    expect(chunks).toEqual(["<li>one</li>"]);
    expect(p.warn).toHaveBeenCalledTimes(1);
  });

  it("a pull that fails because the client went away ends the output with no report", async () => {
    const upstream = new AbortController();
    const invoked = await invokeWithDeadline(
      async function* () {
        yield "<li>one</li>";
        await new Promise(() => {});
      },
      { chunks: true, signal: upstream.signal },
    );
    const p = policy();
    const iterator = (scriptJobOutput(invoked, p) as AsyncIterable<string>)[
      Symbol.asyncIterator
    ]();
    await iterator.next();
    const pending = iterator.next();
    upstream.abort(new Error("client went away"));
    expect((await pending).done).toBe(true);
    expect(p.describeFailure).not.toHaveBeenCalled();
    expect(p.warn).not.toHaveBeenCalled();
  });

  it("the host's silent rule sees the raw rejection of a failed pull", async () => {
    const invoked = await invokeWithDeadline(
      async function* () {
        yield "<li>one</li>";
        // eslint-disable-next-line no-throw-literal
        throw { code: "ECONNRESET" };
      },
      { chunks: true },
    );
    const p = policy({
      isSilentFailure: (result) =>
        (result.thrown as { code?: string })?.code === "ECONNRESET",
    });
    const chunks: string[] = [];
    for await (const chunk of scriptJobOutput(
      invoked,
      p,
    ) as AsyncIterable<string>)
      chunks.push(chunk);
    expect(chunks).toEqual(["<li>one</li>"]);
    expect(p.describeFailure).not.toHaveBeenCalled();
  });

  it("a development refusal of a yielded value ends the output and closes the generator", async () => {
    const cleanedUp = vi.fn();
    const invoked = await invokeWithDeadline(
      async function* () {
        try {
          yield "<li>one</li>";
          yield { not: "markup" };
          yield "<li>never</li>";
        } finally {
          cleanedUp();
        }
      },
      { chunks: true },
    );
    const iterator = (
      scriptJobOutput(
        invoked,
        policy({ production: false }),
      ) as AsyncIterable<string>
    )[Symbol.asyncIterator]();
    await iterator.next();
    await expect(iterator.next()).rejects.toThrow(/yielded an object/);
    await new Promise((r) => setTimeout(r, 0));
    expect(cleanedUp).toHaveBeenCalledTimes(1);
  });

  it("a value the generator returns is settled as its last yield", async () => {
    const invoked = await invokeWithDeadline(
      async function* () {
        yield "<li>one</li>";
        return "<li>last</li>";
      },
      { chunks: true },
    );
    const chunks: string[] = [];
    for await (const chunk of scriptJobOutput(
      invoked,
      policy(),
    ) as AsyncIterable<string>)
      chunks.push(chunk);
    expect(chunks).toEqual(["<li>one</li>", "<li>last</li>"]);
  });
});

describe("script-output-policy module", () => {
  it("is portable: no node: imports and no config (a Worker settles with it)", () => {
    const source = readFileSync(
      new URL("./script-output-policy.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/from\s+["']node:/);
    expect(source).not.toMatch(/from\s+["']\.\/config/);
    expect(source).not.toMatch(/\bprocess\.|\bBuffer\b|console\./);
  });

  it("is exported from the runtime entry adapters bundle", async () => {
    const runtime = await import("../runtime.ts");
    expect(runtime.settleScriptOutput).toBe(settleScriptOutput);
    expect(runtime.scriptJobOutput).toBe(scriptJobOutput);
  });
});
