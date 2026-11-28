/**
 * What a voice model is offered: the `show` and `fill_form` tools beside the
 * app's own, and the system prompt that teaches a speaking model the catalog
 * and how to answer a form for the reader.
 */
import { catalogPrompt, type Catalog } from "../catalog.ts";
import type { Tool } from "../model.ts";

/** The name of the tool a voice model calls to put something on screen. */
export const SHOW_TOOL = "show";

/**
 * The name of the tool a voice model calls to fill in and send a form on the
 * reader's screen, when the reader says their answer instead of pressing it.
 * The reader's browser does it, where the reader can see it happen.
 */
export const FILL_TOOL = "fill_form";

/**
 * The tools a voice session offers: the app's own, `show`, and `fill_form`.
 * A client tool is left out: it is answered by a form in a text reply, which
 * a voice session has no turn for.
 */
export function voiceTools(tools: readonly Tool[]): Tool[] {
  return [
    ...tools.filter(
      (tool) =>
        !tool.client && tool.name !== SHOW_TOOL && tool.name !== FILL_TOOL,
    ),
    {
      name: SHOW_TOOL,
      description:
        "Put something on the reader's screen while you talk: cards, a chart, a table, a diagram, buttons. `markup` is written in the component format from your instructions. Call it whenever a visual answers better than speech.",
      inputSchema: {
        type: "object",
        properties: {
          markup: {
            type: "string",
            description:
              "Components, fences and the elements the format lists, in the component format. No prose.",
          },
        },
        required: ["markup"],
      },
    },
    {
      name: FILL_TOOL,
      description:
        "Fill in and send the form on the reader's screen for them, when they say their answer aloud instead of pressing it. `press` is the words on the button or option to press, such as Correct. `text` is what to type into the form's text box first, such as a note they dictated. Use only what the reader said: never choose for them, and never guess. It cannot answer a question about allowing an action: the reader presses that themselves.",
      inputSchema: {
        type: "object",
        properties: {
          press: {
            type: "string",
            description: "The words on the button or option to press",
          },
          text: {
            type: "string",
            description:
              "What to type into the form's text box before pressing",
          },
          field: {
            type: "string",
            description:
              "The label of the text box, when the form has more than one",
          },
        },
        required: ["press"],
      },
    },
  ];
}

/**
 * The part of a system prompt that teaches a speaking model the catalog: it
 * talks, and it shows components by calling `show`.
 */
export function voicePrompt(
  catalog: Catalog,
  options: Parameters<typeof catalogPrompt>[1] = {},
): string {
  return [
    "You are in a spoken conversation. The reader hears you and sees a screen beside the conversation.",
    "Everything you say is spoken aloud by a voice, and also printed on the screen as you say it. Speak briefly and naturally: at most two short sentences per turn. Never say markup, tags, tables, lists, code, steps, or web addresses: those go on the screen.",
    `The reader answers a form on the screen by speaking, and you enter it: when they say their answer ("yes, that is correct", "the second one", "add a note that..."), call ${FILL_TOOL} with the button or option that matches what they said. That is the reader's own answer, sent by the form in whatever shape it uses, and it is the normal way a form is answered here. Never ask the reader to type, to press it themselves, or to say a message in a special format, and never refuse because their words are not in some format. Ask again only when you cannot tell which button they mean.`,
    `When the reader asks to see something differently ("another way", "a different view", "can you change how that looks") without naming a component, change the kind of view, not the wording: pick other components from the catalog than the ones on screen. Cards can become a table, a table a chart, a list steps, a long answer a diagram. Keep the same content, and say in a few words what you changed it to. Showing the same components again is never the answer to that request.`,
    `The only way to put anything on the screen is the ${SHOW_TOOL} tool. Put every component you want shown, buttons included, in one ${SHOW_TOOL} call per turn. Its markup uses the format below, and holds only components, fences and the elements the format lists: no sentences of its own. Say in one short sentence what you are showing and stop: do not read out or summarize what is on the screen.`,
    "",
    "The format for markup:",
    "",
    catalogPrompt(catalog, options),
    "",
    "In a call, prose and the one sentence that introduces a component are spoken, never written in the markup.",
  ].join("\n");
}
