import { describe, expect, test } from "vitest";
import { plain, planFill, shownAnswer, toldText } from "./forms.ts";
import type { ControlNames } from "./forms.ts";

describe("plain", () => {
  test("compares text by its letters and digits, in lower case", () => {
    expect(plain("  Add to Cart! ")).toBe("add to cart");
    expect(plain("Rate: 5★")).toBe("rate 5");
    expect(plain("Évaluer le livre")).toBe("évaluer le livre");
    expect(plain(null)).toBe("");
    expect(plain(undefined)).toBe("");
  });
});

describe("planFill", () => {
  const review: ControlNames = {
    boxes: ["title", "your review"],
    options: ["loved it", "liked it", "not for me"],
    buttons: ["send review", "skip"],
  };
  const contents =
    "This form has buttons: send review, skip. options: loved it, liked it, not for me. text boxes: title, your review.";

  test("presses the button whose name matches exactly, then by part", () => {
    expect(planFill({ press: "Skip" }, review)).toEqual({
      outcome: { press: 1 },
    });
    expect(planFill({ press: "send" }, review)).toEqual({
      outcome: { press: 0 },
    });
  });

  test("prefers an exact name to one that only contains it", () => {
    const names = { boxes: [], options: [], buttons: ["send later", "send"] };
    expect(planFill({ press: "send" }, names)).toEqual({
      outcome: { press: 1 },
    });
  });

  test("chooses an option before looking at the buttons, and does not send", () => {
    expect(planFill({ press: "liked it" }, review)).toEqual({
      outcome: {
        choose: 1,
        say: `Chose "liked it". It is not sent yet. ${contents}`,
      },
    });
  });

  test("types into the box the field names, or the first box", () => {
    expect(
      planFill(
        { text: "  A gripping read. ", field: "Review", press: "send review" },
        review,
      ),
    ).toEqual({
      fill: { box: 1, text: "A gripping read." },
      outcome: { press: 0 },
    });
    expect(
      planFill({ text: "Kindred", field: "author", press: "skip" }, review)
        .fill,
    ).toEqual({
      box: 0,
      text: "Kindred",
    });
    expect(planFill({ text: "Kindred", press: "skip" }, review).fill).toEqual({
      box: 0,
      text: "Kindred",
    });
  });

  test("ignores blank text", () => {
    expect(planFill({ text: "   ", press: "skip" }, review)).toEqual({
      outcome: { press: 1 },
    });
  });

  test("refuses text for a form with no text box", () => {
    const names = { boxes: [], options: [], buttons: ["ok"] };
    expect(planFill({ text: "Hello", press: "ok" }, names)).toEqual({
      outcome: {
        error: "Error: this form has no text box. This form has buttons: ok.",
      },
    });
  });

  test("asks what to press, after typing what it was given", () => {
    expect(planFill({ text: "Dawn" }, review)).toEqual({
      fill: { box: 0, text: "Dawn" },
      outcome: { error: `Error: say what to press. ${contents}` },
    });
    expect(planFill(null, review)).toEqual({
      outcome: { error: `Error: say what to press. ${contents}` },
    });
  });

  test("says when nothing matches, quoting what the model asked for", () => {
    expect(planFill({ press: "Buy now!" }, review)).toEqual({
      outcome: {
        error: `Error: no button or option says "Buy now!". ${contents}`,
      },
    });
  });

  test("names unnamed controls, and leaves out kinds the form lacks", () => {
    const names = { boxes: [""], options: [], buttons: [""] };
    expect(planFill({ press: "go" }, names)).toEqual({
      outcome: {
        error:
          'Error: no button or option says "go". This form has buttons: unnamed. text boxes: unnamed.',
      },
    });
  });
});

describe("shownAnswer", () => {
  test("shows the words on a button that carries the answer", () => {
    expect(
      shownAnswer({ named: true, pressed: "\n      Not sure\n    " }),
    ).toBe("Not sure");
    // A button with no name only sends the form: the message is shown.
    expect(shownAnswer({ named: false, pressed: "Send" })).toBeUndefined();
    expect(shownAnswer({ named: true })).toBeUndefined();
  });

  test("lets the form's own show field win: its text, or nothing", () => {
    expect(
      shownAnswer({ show: " Kept 2 of 3 ", named: true, pressed: "Done" }),
    ).toBe("Kept 2 of 3");
    expect(shownAnswer({ show: "", named: true, pressed: "Done" })).toBe("");
    expect(shownAnswer({ show: "", mode: "message", named: false })).toBe("");
  });

  test("shows the message when the form asks for it", () => {
    expect(
      shownAnswer({ mode: "message", named: true, pressed: "Save answer" }),
    ).toBeUndefined();
  });

  test("shows the picked option's words, or the button's, when asked for the label", () => {
    expect(
      shownAnswer({
        mode: "label",
        named: false,
        pressed: "Send",
        chosen: " Short enough\n for a weekend ",
      }),
    ).toBe("Short enough for a weekend");
    expect(
      shownAnswer({ mode: "label", named: false, pressed: "Hold it" }),
    ).toBe("Hold it");
    expect(shownAnswer({ mode: "label", named: false })).toBeUndefined();
  });

  test("keeps markup and replacement tokens as the text they are", () => {
    expect(shownAnswer({ named: true, pressed: "<b>$1</b> $&" })).toBe(
      "<b>$1</b> $&",
    );
  });
});

describe("toldText", () => {
  const COMMAND = "Decision on returns-window (fact): unsure";

  test("reads a pressed form as what it said, not as its label", () => {
    const told = new Map([["sent-form:0", COMMAND]]);
    expect(toldText([{ id: "sent-form:0", text: "Not sure" }], told)).toBe(
      COMMAND,
    );
    // A form that shows nothing is still told to the model.
    expect(toldText([{ id: "sent-form:0", text: "" }], told)).toBe(COMMAND);
  });

  test("keeps the words said around a form the model pressed", () => {
    const told = new Map([["sent-form:0", COMMAND]]);
    expect(
      toldText(
        [
          { id: "u1", text: "I am not sure about that one" },
          { id: "sent-form:0", text: "\nNot sure" },
          { id: "u2", text: "next please" },
        ],
        told,
      ),
    ).toBe(`I am not sure about that one\n${COMMAND} next please`);
  });

  test("is the turn as it was heard when no form was sent", () => {
    expect(toldText([{ id: "", text: " Hello " }], new Map())).toBe("Hello");
  });
});
