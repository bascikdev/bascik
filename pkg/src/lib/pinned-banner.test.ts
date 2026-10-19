import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canPinBanner,
  formatBanner,
  isPinningDisabled,
  needsEmptyScrollback,
  pinServerUrl,
  readCursorPosition,
  type PinnedBannerInput,
  type PinnedBannerStream,
} from "./pinned-banner.ts";
import { stripColors } from "./colors.ts";

const ESC = "\u001B";

const makeStream = (overrides: Partial<PinnedBannerStream> = {}) => {
  const writes: string[] = [];
  const listeners = new Set<() => void>();
  const stream: PinnedBannerStream = {
    isTTY: true,
    rows: 24,
    columns: 80,
    write: (chunk) => {
      writes.push(chunk);
      return true;
    },
    on: (_event, listener) => {
      listeners.add(listener);
      return stream;
    },
    off: (_event, listener) => {
      listeners.delete(listener);
      return stream;
    },
    ...overrides,
  };
  return { stream, writes, listeners };
};

/**
 * A stdin that behaves like a terminal's: when the cursor-position request is written to the output, it answers
 * with `reply` (or says nothing). It records whether raw mode is on, and how it was left.
 */
const makeInput = (
  options: { reply?: string | string[]; isRaw?: boolean; isTTY?: boolean } = {},
) => {
  const dataListeners = new Set<(chunk: Buffer | string) => void>();
  const state = {
    raw: options.isRaw === true,
    rawCalls: [] as boolean[],
    paused: false,
    requested: 0,
  };
  const input: PinnedBannerInput = {
    isTTY: options.isTTY ?? true,
    get isRaw() {
      return state.raw;
    },
    setRawMode: (mode: boolean) => {
      state.raw = mode;
      state.rawCalls.push(mode);
    },
    resume: () => {
      state.paused = false;
    },
    pause: () => {
      state.paused = true;
    },
    on: (_event, listener) => {
      dataListeners.add(listener);
    },
    off: (_event, listener) => {
      dataListeners.delete(listener);
    },
  };
  /** Wire an output stream so the request is answered. */
  const answer = (stream: PinnedBannerStream) => {
    const original = stream.write.bind(stream);
    stream.write = (chunk: string) => {
      if (chunk.includes(`${ESC}[6n`)) {
        state.requested++;
        const replies =
          options.reply === undefined
            ? []
            : Array.isArray(options.reply)
              ? options.reply
              : [options.reply];
        queueMicrotask(() => {
          for (const piece of replies)
            for (const listener of [...dataListeners]) listener(piece);
        });
      }
      return original(chunk);
    };
  };
  return { input, state, answer, listenerCount: () => dataListeners.size };
};

describe("pinned-banner", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("canPinBanner", () => {
    it("accepts an interactive terminal", () => {
      expect(canPinBanner(makeStream().stream, {})).toBe(true);
    });

    it.each([
      ["piped output", { isTTY: false }, {}],
      ["a terminal with too few rows", { rows: 3 }, {}],
      ["a terminal with too few columns", { columns: 10 }, {}],
      ["CI", {}, { CI: "true" }],
      ["TERM=dumb", {}, { TERM: "dumb" }],
    ])("rejects %s", (_name, streamOverrides, env) => {
      expect(canPinBanner(makeStream(streamOverrides).stream, env)).toBe(false);
    });
  });

  describe("needsEmptyScrollback", () => {
    it("is true only in VS Code's terminal with shell integration on, where sticky scroll draws over the top row", () => {
      expect(
        needsEmptyScrollback({ TERM_PROGRAM: "vscode", VSCODE_INJECTION: "1" }),
      ).toBe(true);
      expect(
        needsEmptyScrollback({
          TERM_PROGRAM: "vscode",
          VSCODE_SHELL_INTEGRATION: "1",
        }),
      ).toBe(true);
    });

    it.each([
      ["VS Code with shell integration off", { TERM_PROGRAM: "vscode" }],
      ["another terminal", { TERM_PROGRAM: "Apple_Terminal" }],
      [
        "an environment variable left over from VS Code in a different terminal",
        { TERM_PROGRAM: "ghostty", VSCODE_INJECTION: "1" },
      ],
      ["no terminal program", {}],
    ])("is false for %s, so their scrollback is kept", (_name, env) => {
      expect(needsEmptyScrollback(env)).toBe(false);
    });
  });

  describe("formatBanner", () => {
    it("shows the label and the full URL when it fits", () => {
      expect(stripColors(formatBanner("http://localhost:8080", 80))).toBe(
        "Server running at http://localhost:8080",
      );
    });

    it("shortens a URL that would wrap onto the second row", () => {
      const text = stripColors(
        formatBanner(`http://localhost:8080/${"a".repeat(100)}`, 40),
      );
      expect(text.length).toBeLessThanOrEqual(40);
      expect(text.endsWith("…")).toBe(true);
    });
  });

  describe("readCursorPosition", () => {
    it("returns the row and column from the terminal's reply", async () => {
      const { stream } = makeStream();
      const { input, answer } = makeInput({ reply: `${ESC}[17;3R` });
      answer(stream);
      expect(await readCursorPosition(stream, input)).toEqual({
        row: 17,
        column: 3,
      });
    });

    it("reads a reply that arrives in pieces, or after other typed characters", async () => {
      const { stream } = makeStream();
      const { input, answer } = makeInput({
        reply: ["ab", `${ESC}[1`, "2;1", "R"],
      });
      answer(stream);
      expect(await readCursorPosition(stream, input)).toEqual({
        row: 12,
        column: 1,
      });
    });

    it("gives up and answers undefined when the terminal says nothing", async () => {
      const { stream } = makeStream();
      const { input, answer } = makeInput({});
      answer(stream);
      expect(await readCursorPosition(stream, input, 20)).toBeUndefined();
    });

    it("never asks when stdin is not a terminal, or there is no stdin", async () => {
      const { stream, writes } = makeStream();
      expect(
        await readCursorPosition(stream, makeInput({ isTTY: false }).input),
      ).toBeUndefined();
      expect(await readCursorPosition(stream, undefined)).toBeUndefined();
      expect(writes).toEqual([]);
    });

    it.each([
      ["answers", { reply: `${ESC}[5;1R` }],
      ["stays silent", {}],
    ])(
      "leaves stdin exactly as it found it when the terminal %s: raw mode off, listener removed, paused",
      async (_name, options) => {
        const { stream } = makeStream();
        const { input, state, answer, listenerCount } = makeInput(options);
        answer(stream);
        await readCursorPosition(stream, input, 20);
        expect(state.raw).toBe(false);
        expect(state.rawCalls).toEqual([true, false]);
        expect(listenerCount()).toBe(0);
        expect(state.paused).toBe(true);
      },
    );

    it("restores raw mode to ON when it was already on, so a caller using raw input is not disturbed", async () => {
      const { stream } = makeStream();
      const { input, state, answer } = makeInput({
        reply: `${ESC}[2;1R`,
        isRaw: true,
      });
      answer(stream);
      await readCursorPosition(stream, input);
      expect(state.raw).toBe(true);
    });

    it("does not throw, and restores stdin, when raw mode cannot be switched", async () => {
      const { stream } = makeStream();
      const { input, state } = makeInput({});
      input.setRawMode = () => {
        throw new Error("EIO");
      };
      expect(await readCursorPosition(stream, input, 20)).toBeUndefined();
      expect(state.paused).toBe(true);
    });
  });

  describe("BASCIK_PIN_SERVER_URL", () => {
    it.each(["0", "false", "FALSE", "off", "no", " 0 "])(
      "%j turns pinning off",
      (value) => {
        expect(isPinningDisabled({ BASCIK_PIN_SERVER_URL: value })).toBe(true);
      },
    );

    it.each([undefined, "", "1", "true", "on", "yes", "anything"])(
      "%j leaves pinning on",
      (value) => {
        expect(isPinningDisabled({ BASCIK_PIN_SERVER_URL: value })).toBe(false);
      },
    );

    it("pinServerUrl writes nothing, not even the cursor query, when it is off in an otherwise capable terminal", async () => {
      const { stream, writes } = makeStream();
      const { input } = makeInput({ reply: `${ESC}[3;1R` });
      expect(
        await pinServerUrl(
          "http://localhost:8080",
          stream,
          { BASCIK_PIN_SERVER_URL: "0" },
          input,
        ),
      ).toBeUndefined();
      expect(writes).toEqual([]);
    });
  });

  describe("pinServerUrl", () => {
    it("writes nothing and returns undefined when the stream cannot pin", async () => {
      const { stream, writes } = makeStream({ isTTY: false });
      expect(
        await pinServerUrl("http://localhost:8080", stream, {}, undefined),
      ).toBeUndefined();
      expect(writes).toEqual([]);
    });

    it("asks where the cursor is BEFORE touching the scroll region, because resetting it homes the cursor", async () => {
      const { stream, writes } = makeStream();
      const { input, answer } = makeInput({ reply: `${ESC}[3;1R` });
      answer(stream);
      const banner = await pinServerUrl(
        "http://localhost:8080",
        stream,
        {},
        input,
      );
      banner?.release();
      // The question is the very first thing written. Anything before it that moved the cursor would make the
      // answer "row 1", and only one line would be scrolled away.
      expect(writes[0]).toBe(`${ESC}[6n`);
      expect(
        writes.slice(1).join("").indexOf(`${ESC}[r`),
      ).toBeGreaterThanOrEqual(0);
    });

    it("forgets a stale scroll region and origin mode before anything else, so row numbers mean what they say", async () => {
      const { stream, writes } = makeStream({ rows: 24 });
      const { input, answer } = makeInput({ reply: `${ESC}[3;1R` });
      answer(stream);
      const banner = await pinServerUrl(
        "http://localhost:8080",
        stream,
        {},
        input,
      );
      banner?.release();
      expect(writes[1].startsWith(`${ESC}[r${ESC}[?6l`)).toBe(true);
    });

    it("moves the screen down one row to make room, without scrolling anything into the scrollback", async () => {
      const { stream, writes } = makeStream({ rows: 40 });
      const { input, answer } = makeInput({ reply: `${ESC}[7;5R` });
      answer(stream);
      const banner = await pinServerUrl(
        "http://localhost:8080",
        stream,
        {},
        input,
      );
      banner?.release();
      // Color is off here (stdout is not a terminal), so the text is the exact bytes written.
      const setup = writes[1];
      expect(setup).toBe(
        `${ESC}[r${ESC}[?6l` +
          // A blank line at the top moves everything down. The command's line stays on screen, which is what keeps
          // VS Code's sticky scroll overlay from covering the banner.
          `${ESC}[1;1H${ESC}[L` +
          `${ESC}[1;1H${ESC}[2KServer running at http://localhost:8080${ESC}[2;40r` +
          // The cursor was on row 7, column 5. That line is now on row 8, and the cursor goes back to it.
          `${ESC}[8;5H`,
      );
      // Nothing scrolls: no newline is written.
      expect(setup).not.toContain("\n");
    });

    it("leaves the scrollback alone outside VS Code's terminal", async () => {
      const { stream, writes } = makeStream({ rows: 24 });
      const { input, answer } = makeInput({ reply: `${ESC}[7;1R` });
      answer(stream);
      const banner = await pinServerUrl(
        "http://localhost:8080",
        stream,
        { TERM_PROGRAM: "Apple_Terminal" },
        input,
      );
      banner?.release();
      expect(writes[1]).not.toContain(`${ESC}[3J`);
    });

    describe("in VS Code's terminal", () => {
      const vscode = { TERM_PROGRAM: "vscode", VSCODE_INJECTION: "1" };

      it("erases the scrollback, so no earlier command is left above the screen to own the top row", async () => {
        const { stream, writes } = makeStream({ rows: 40 });
        const { input, answer } = makeInput({ reply: `${ESC}[7;5R` });
        answer(stream);
        const banner = await pinServerUrl(
          "http://localhost:8080",
          stream,
          vscode,
          input,
        );
        banner?.release();
        expect(writes[1]).toBe(
          `${ESC}[r${ESC}[?6l${ESC}[3J` +
            `${ESC}[1;1H${ESC}[L` +
            `${ESC}[1;1H${ESC}[2KServer running at http://localhost:8080${ESC}[2;40r` +
            `${ESC}[8;5H`,
        );
      });

      it("erases it AFTER scrolling a full screen, so the line that scroll pushed up goes too", async () => {
        const { stream, writes } = makeStream({ rows: 24 });
        const { input, answer } = makeInput({ reply: `${ESC}[24;1R` });
        answer(stream);
        const banner = await pinServerUrl(
          "http://localhost:8080",
          stream,
          vscode,
          input,
        );
        banner?.release();
        const setup = writes[1];
        expect(
          setup.startsWith(
            `${ESC}[r${ESC}[?6l${ESC}[24;1H\n${ESC}[3J${ESC}[1;1H${ESC}[L`,
          ),
        ).toBe(true);
      });

      it("erases it again on resize, because shrinking the window pushes the top rows into the scrollback", async () => {
        const { stream, writes, listeners } = makeStream();
        const { input, answer } = makeInput({ reply: `${ESC}[3;1R` });
        answer(stream);
        const banner = await pinServerUrl(
          "http://localhost:8080",
          stream,
          vscode,
          input,
        );
        for (const listener of listeners) listener();
        expect(
          (writes.at(-1) ?? "").startsWith(`${ESC}7${ESC}[3J${ESC}[1;1H`),
        ).toBe(true);
        banner?.release();
      });
    });

    it("scrolls exactly one line away when the screen is full, and puts the cursor back where it was", async () => {
      const { stream, writes } = makeStream({ rows: 24 });
      const { input, answer } = makeInput({ reply: `${ESC}[24;1R` });
      answer(stream);
      const banner = await pinServerUrl(
        "http://localhost:8080",
        stream,
        {},
        input,
      );
      banner?.release();
      const setup = writes[1];
      expect(
        setup.startsWith(`${ESC}[r${ESC}[?6l${ESC}[24;1H\n${ESC}[1;1H${ESC}[L`),
      ).toBe(true);
      expect(setup.split("\n")).toHaveLength(2);
      expect(setup.endsWith(`${ESC}[2;24r${ESC}[24;1H`)).toBe(true);
    });

    it("treats a terminal that does not answer as a full screen, which is always safe", async () => {
      vi.useFakeTimers();
      try {
        const { stream, writes } = makeStream({ rows: 24 });
        const { input, answer } = makeInput({});
        answer(stream);
        const pending = pinServerUrl(
          "http://localhost:8080",
          stream,
          {},
          input,
        );
        await vi.advanceTimersByTimeAsync(1000);
        const banner = await pending;
        banner?.release();
        expect(
          writes[1].startsWith(
            `${ESC}[r${ESC}[?6l${ESC}[24;1H\n${ESC}[1;1H${ESC}[L`,
          ),
        ).toBe(true);
        expect(writes[1].endsWith(`${ESC}[24;1H`)).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps the cursor on the screen, whatever the terminal claims", async () => {
      for (const [claimed, resume] of [
        [999, "24;1"],
        [0, "2;1"],
      ] as const) {
        const { stream, writes } = makeStream({ rows: 24 });
        const { input, answer } = makeInput({ reply: `${ESC}[${claimed};1R` });
        answer(stream);
        const banner = await pinServerUrl(
          "http://localhost:8080",
          stream,
          {},
          input,
        );
        banner?.release();
        expect(writes[1].endsWith(`${ESC}[${resume}H`)).toBe(true);
      }
    });

    it("redraws the banner and region on resize without moving the cursor", async () => {
      const { stream, writes, listeners } = makeStream();
      const { input, answer } = makeInput({ reply: `${ESC}[3;1R` });
      answer(stream);
      const banner = await pinServerUrl(
        "http://localhost:8080",
        stream,
        {},
        input,
      );
      stream.rows = 40;
      for (const listener of listeners) listener();
      const redraw = writes.at(-1) ?? "";
      expect(redraw.startsWith(`${ESC}7`)).toBe(true);
      expect(redraw).toContain(`${ESC}[2;40r`);
      expect(redraw).toContain("Server running at");
      expect(redraw.endsWith(`${ESC}8`)).toBe(true);
      banner?.release();
    });

    it("releases the region and handlers once, and the exit handler also resets the region", async () => {
      const { stream, writes, listeners } = makeStream();
      const { input, answer } = makeInput({ reply: `${ESC}[3;1R` });
      answer(stream);
      const exitListenersBefore = process.listenerCount("exit");
      const banner = await pinServerUrl(
        "http://localhost:8080",
        stream,
        {},
        input,
      );
      expect(listeners.size).toBe(1);
      expect(process.listenerCount("exit")).toBe(exitListenersBefore + 1);
      const resetsBefore = writes.filter((chunk) =>
        chunk.includes(`${ESC}[r`),
      ).length;
      banner?.release();
      banner?.release();
      expect(listeners.size).toBe(0);
      expect(process.listenerCount("exit")).toBe(exitListenersBefore);
      expect(
        writes.filter((chunk) => chunk.includes(`${ESC}[r`)).length -
          resetsBefore,
      ).toBe(1);
    });
  });
});
