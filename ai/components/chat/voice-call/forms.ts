/*
 * Forms on screen during a call: the reader presses them, or the model fills
 * them in with what the reader said. The component finds the elements and
 * passes them here; the choice of what to fill and press is `planFill`.
 */
import { readerText } from "./reader.ts";
import type { ReaderPiece } from "./reader.ts";

/** Text as compared: lower case, letters and digits, single spaces. */
export const plain = (text: string | null | undefined): string =>
  (text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/*
 * A form's controls are also its properties, by name, and they win over
 * the form's own: `<input name="action">` makes `form.action` that input.
 * The model names the fields of the forms it writes, so a form in the
 * thread is read only through the prototype, never by property name.
 */
export const formGet = <K extends keyof HTMLFormElement>(
  form: HTMLFormElement,
  key: K,
): HTMLFormElement[K] =>
  Reflect.get(HTMLFormElement.prototype, key, form) as HTMLFormElement[K];

export const controlsOf = (form: HTMLFormElement): Element[] => [
  ...formGet(form, "elements"),
];

/**
 * A question about allowing an action is the reader's alone to answer. It
 * answers a call by a hidden field, which no field the model writes is.
 */
export const callOf = (form: HTMLFormElement): string | undefined =>
  controlsOf(form).find(
    (control): control is HTMLInputElement =>
      control instanceof HTMLInputElement &&
      control.type === "hidden" &&
      control.name === "call",
  )?.value;

export const isApproval = (form: HTMLFormElement): boolean =>
  callOf(form) !== undefined ||
  Element.prototype.closest.call(form, "[data-part]") !== null;

/** The newest form in `thread` that has not been sent. */
export function openForm(thread: Element | null): HTMLFormElement | null {
  const forms = [...(thread?.querySelectorAll("form") ?? [])].filter(
    (form) =>
      !formGet(form, "dataset").sent &&
      !isApproval(form) &&
      // One that is on the page but not shown is not one the reader means.
      Element.prototype.checkVisibility.call(form),
  );
  return forms.at(-1) ?? null;
}

/** The names of a form's text boxes, options and buttons, as `plain` text. */
export interface ControlNames {
  boxes: string[];
  options: string[];
  buttons: string[];
}

/** What filling in a form does: maybe type into a box, then one outcome. */
export interface FillPlan {
  /** Put `text` in the text box at `box` first. */
  fill?: { box: number; text: string };
  outcome:
    { error: string } | { choose: number; say: string } | { press: number };
}

/**
 * What to do with the model's `fill_form` input on a form whose controls
 * are named `names`. Pure: it reads names, and the caller does the rest.
 */
export function planFill(input: unknown, names: ControlNames): FillPlan {
  const { press, text, field } = (
    typeof input === "object" && input !== null ? input : {}
  ) as Record<string, unknown>;
  const has = (kind: string, list: string[]): string =>
    list.length
      ? ` ${kind}: ${list.map((name) => name || "unnamed").join(", ")}.`
      : "";
  const contents = `This form has${has("buttons", names.buttons)}${has("options", names.options)}${has("text boxes", names.boxes)}`;

  let fill: FillPlan["fill"];
  if (typeof text === "string" && text.trim()) {
    const wanted = plain(typeof field === "string" ? field : "");
    const found = wanted
      ? names.boxes.findIndex((name) => name.includes(wanted))
      : -1;
    const box = found >= 0 ? found : names.boxes.length ? 0 : -1;
    if (box < 0) {
      return {
        outcome: { error: `Error: this form has no text box. ${contents}` },
      };
    }
    fill = { box, text: text.trim() };
  }
  const plan = (outcome: FillPlan["outcome"]): FillPlan =>
    fill ? { fill, outcome } : { outcome };
  const wanted = plain(typeof press === "string" ? press : "");
  if (!wanted) return plan({ error: `Error: say what to press. ${contents}` });
  const match = (list: string[]): number => {
    const exact = list.findIndex((name) => name === wanted);
    return exact >= 0 ? exact : list.findIndex((name) => name.includes(wanted));
  };
  const option = match(names.options);
  if (option >= 0) {
    return plan({
      choose: option,
      say: `Chose "${names.options[option]}". It is not sent yet. ${contents}`,
    });
  }
  const button = match(names.buttons);
  if (button < 0) {
    return plan({
      error: `Error: no button or option says "${String(press)}". ${contents}`,
    });
  }
  return plan({ press: button });
}

type Control = HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement;

/** A form's text boxes, options and submit buttons, in the form's order. */
export function formControls(form: HTMLFormElement): {
  boxes: (HTMLInputElement | HTMLTextAreaElement)[];
  options: HTMLInputElement[];
  buttons: HTMLButtonElement[];
} {
  const controls = controlsOf(form) as Control[];
  return {
    boxes: controls.filter(
      (control): control is HTMLInputElement | HTMLTextAreaElement =>
        control instanceof HTMLTextAreaElement ||
        (control instanceof HTMLInputElement &&
          !["hidden", "radio", "checkbox", "submit", "button"].includes(
            control.type,
          )),
    ),
    options: controls.filter(
      (control): control is HTMLInputElement =>
        control instanceof HTMLInputElement &&
        (control.type === "radio" || control.type === "checkbox"),
    ),
    buttons: controls.filter(
      (control): control is HTMLButtonElement =>
        control instanceof HTMLButtonElement && control.type === "submit",
    ),
  };
}

/** A control's name: a button's text, or the text of a field's first label. */
export const controlName = (
  control: HTMLElement & { labels?: NodeListOf<HTMLLabelElement> | null },
): string =>
  control instanceof HTMLButtonElement
    ? plain(control.textContent)
    : plain(control.labels?.[0]?.textContent);

/** What a form says about how its answer is shown, as read from the page. */
export interface AnswerFacts {
  /** The form's own `show` field, when it has one. */
  show?: string;
  /** The form's `data-answer`: "message", "label", or nothing. */
  mode?: string;
  /** The words on the button that sent the form. */
  pressed?: string;
  /** Whether that button has a name, so that its value is the answer. */
  named: boolean;
  /** The words beside the picked option named `text`. */
  chosen?: string;
  /** Whether the reader wrote the message themselves, in a box named `text`. */
  typed?: boolean;
}

const words = (text: string | null | undefined): string | undefined =>
  text?.replace(/\s+/g, " ").trim() || undefined;

/**
 * What the thread shows for a form's message in place of the message, or
 * undefined when the message itself is shown. The form's own `show` field
 * wins: its text, or nothing when it is empty. Without one, a button that
 * carries the answer (it has a name) shows its words. `data-answer="message"`
 * on the form shows the message, and `"label"` shows the picked option's
 * words, or the button's.
 */
export function shownAnswer(facts: AnswerFacts): string | undefined {
  if (facts.show !== undefined) return facts.show.trim();
  if (facts.mode === "message") return undefined;
  if (facts.mode === "label") {
    return words(facts.chosen) ?? words(facts.pressed);
  }
  // Words the reader wrote are their turn: a button's label does not replace them.
  return facts.named && !facts.typed ? words(facts.pressed) : undefined;
}

/** `shownAnswer` for a form on the page, sent by `submitter` as `body`. */
export function shownFor(
  form: HTMLFormElement,
  submitter: HTMLElement | null,
  body: FormData,
): string | undefined {
  const own = body.get("show");
  const picked = controlsOf(form).find(
    (control): control is HTMLInputElement =>
      control instanceof HTMLInputElement &&
      control.type === "radio" &&
      control.name === "text" &&
      control.checked,
  );
  const button = submitter instanceof HTMLButtonElement ? submitter : null;
  const mode = formGet(form, "dataset").answer;
  const pressed = button?.textContent;
  const chosen = picked?.labels?.[0]?.textContent;
  return shownAnswer({
    ...(typeof own === "string" ? { show: own } : {}),
    ...(mode === undefined ? {} : { mode }),
    ...(pressed == null ? {} : { pressed }),
    named: Boolean(button?.name),
    ...(chosen == null ? {} : { chosen }),
    typed: controlsOf(form).some(
      (control) =>
        (control instanceof HTMLTextAreaElement ||
          (control instanceof HTMLInputElement &&
            !["hidden", "radio", "checkbox"].includes(control.type))) &&
        control.name === "text" &&
        control.value.trim() !== "",
    ),
  });
}

/**
 * What a sent form answered: `say` is for the model, and `show` is what the
 * thread shows as the reader's turn in its place (empty for nothing). With
 * no `show`, the thread shows `say`.
 */
export interface SentForm {
  say: string;
  show?: string;
}

/**
 * A reader's turn as the model reads it. `pieces` is the turn as the thread
 * shows it, and `told` has, by piece id, what each form sent in the turn
 * said: its piece shows the form's label, and reads as what the form said.
 */
export function toldText(
  pieces: readonly ReaderPiece[],
  told: ReadonlyMap<string, string>,
): string {
  return readerText(
    pieces.map((piece) => {
      const say = told.get(piece.id);
      return say === undefined ? piece : { id: piece.id, text: `\n${say}` };
    }),
  ).trim();
}

/**
 * Send a form the way a call needs it sent: to its own address, marked as
 * coming from a call. The server does what the form does and answers with
 * what it says, which goes to the speech model in place of a typed reply.
 * `run` wraps the request, so the status line says the call is working.
 */
export async function sendForm(
  form: HTMLFormElement,
  submitter: HTMLElement | null,
  run: <T>(job: () => Promise<T>) => Promise<T>,
): Promise<SentForm | null> {
  // Read before the controls are disabled: a disabled control is not sent.
  const body = new FormData(form, submitter);
  const shown = shownFor(form, submitter, body);
  if (shown !== undefined) body.set("show", shown);
  body.set("voice", "1");
  const locked = controlsOf(form).filter(
    (control): control is Control => "disabled" in control && !control.disabled,
  );
  const style = formGet(form, "style");
  Element.prototype.setAttribute.call(form, "aria-busy", "true");
  // A form is not part of this component's template, so it is dimmed here.
  style.cssText += ";opacity:0.7;cursor:progress";
  for (const control of locked) control.disabled = true;
  let answer: { say?: unknown; show?: unknown } | null = null;
  try {
    answer = await run(async () => {
      const response = await fetch(formGet(form, "action"), {
        method: "POST",
        body,
      });
      return response.ok
        ? ((await response.json().catch(() => null)) as {
            say?: unknown;
            show?: unknown;
          } | null)
        : null;
    });
  } finally {
    Element.prototype.removeAttribute.call(form, "aria-busy");
    style.opacity = "";
    style.cursor = "";
    for (const control of locked) control.disabled = false;
  }
  if (typeof answer?.say !== "string" || !answer.say.trim()) return null;
  // Sent once: it stays on screen as it was answered, and says so.
  formGet(form, "dataset").sent = "";
  Reflect.set(HTMLElement.prototype, "inert", true, form);
  style.opacity = "0.7";
  const pressed = submitter?.textContent?.trim();
  const note = document.createElement("p");
  note.dataset.testid = "voice-call-answered";
  note.style.cssText = "margin:0;font-size:0.8125rem;font-weight:600";
  note.textContent = pressed ? `Answered: ${pressed}` : "Answered";
  Element.prototype.append.call(form, note);
  // A record in a fixed shape is for the model; the thread shows its label.
  return typeof answer.show === "string"
    ? { say: answer.say.trim(), show: answer.show.trim() }
    : { say: answer.say.trim() };
}

/**
 * The model fills in `form` with what the reader said, and presses it.
 * `send` sends it; `answered` shows what was sent as the reader's turn.
 */
export async function fillForm(
  input: unknown,
  form: HTMLFormElement | null,
  send: (
    form: HTMLFormElement,
    button: HTMLButtonElement,
  ) => Promise<SentForm | null>,
  answered: (sent: SentForm) => void,
): Promise<string> {
  if (!form) return "Error: there is no form on the screen to fill in.";
  const { boxes, options, buttons } = formControls(form);
  const { fill, outcome } = planFill(input, {
    boxes: boxes.map(controlName),
    options: options.map(controlName),
    buttons: buttons.map(controlName),
  });
  if (fill) {
    const box = boxes[fill.box]!;
    box.value = fill.text;
    box.dispatchEvent(new Event("input", { bubbles: true }));
  }
  if ("error" in outcome) return outcome.error;
  if ("choose" in outcome) {
    const option = options[outcome.choose]!;
    option.checked = true;
    option.dispatchEvent(new Event("change", { bubbles: true }));
    return outcome.say;
  }
  const sent = await send(form, buttons[outcome.press]!);
  if (!sent) return "Error: the form could not be sent.";
  // What was sent is the reader's answer, and is shown and stored as theirs.
  answered(sent);
  return `Sent for the reader: ${sent.say}\nThis is the reader's answer, sent and recorded. Nothing more will arrive for it: carry on now with what comes next.`;
}
