/**
 * The dashboard template's settings form: labeled controls, validation, a
 * saved-confirmation live region and an error state. A demo that saves to
 * the browser only.
 *
 * Each entry is one file of the generated project, as it is written: its
 * path from the project root, then its content.
 */

import type { TemplateFile } from "../../scaffold.js";

export const SETTINGS_FILES: TemplateFile[] = [
  [
    "src/components/settings-form/settings-form.html",
    `<!-- @bascik
The settings form. A demo: it saves to this browser's localStorage and nothing else reads the values. settings-form.ts validates and stores them; its styles are in settings-form.css. Without JavaScript the buttons stay disabled and a note says why.
-->
<form class="card form" id="form" data-testid="settings-form">
  <p class="demo" data-testid="settings-form-demo-note">
    <strong>Demo.</strong> These settings are saved in this browser only and
    change nothing else. A real dashboard would send them to an API route that
    checks who is signed in.
  </p>
  <p
    class="problem"
    id="problem"
    role="alert"
    data-testid="settings-form-problem"
    hidden
  ></p>

  <label class="row" for="shop-name">
    Shop name
    <input
      class="field input"
      id="shop-name"
      name="shopName"
      type="text"
      autocomplete="organization"
      maxlength="60"
      required
      aria-describedby="shop-name-error"
      data-testid="settings-form-shop-name"
    />
  </label>
  <p class="error" id="shop-name-error" hidden></p>

  <label class="row" for="email">
    Order notifications email
    <input
      class="field input"
      id="email"
      name="email"
      type="email"
      autocomplete="email"
      required
      aria-describedby="email-error"
      data-testid="settings-form-email"
    />
  </label>
  <p class="error" id="email-error" hidden></p>

  <label class="row" for="low-stock">
    Low stock threshold
    <input
      class="field input"
      id="low-stock"
      name="lowStock"
      type="number"
      min="1"
      max="500"
      required
      aria-describedby="low-stock-hint low-stock-error"
      data-testid="settings-form-low-stock"
    />
  </label>
  <p class="hint" id="low-stock-hint">
    A title with this many copies or fewer is marked "Low stock".
  </p>
  <p class="error" id="low-stock-error" hidden></p>

  <label class="row" for="currency">
    Currency
    <select
      class="field input"
      id="currency"
      name="currency"
      aria-describedby="currency-error"
      data-testid="settings-form-currency"
    >
      <option value="USD">US dollar (USD)</option>
      <option value="CAD">Canadian dollar (CAD)</option>
      <option value="EUR">Euro (EUR)</option>
      <option value="GBP">Pound sterling (GBP)</option>
    </select>
  </label>
  <p class="error" id="currency-error" hidden></p>

  <label class="check" for="digest">
    <input
      id="digest"
      name="digest"
      type="checkbox"
      data-testid="settings-form-digest"
    />
    Email a weekly sales digest
  </label>

  <div class="actions">
    <button
      class="button button-primary"
      id="save"
      type="submit"
      data-testid="settings-form-save"
      disabled
    >
      Save settings
    </button>
    <button
      class="button"
      id="reset"
      type="button"
      data-testid="settings-form-reset"
      disabled
    >
      Restore defaults
    </button>
    <p
      class="saved"
      id="saved"
      role="status"
      data-testid="settings-form-saved"
    ></p>
  </div>
  <!-- Shown until the script runs, so a reader without JavaScript knows why the buttons are off. -->
  <p class="note" id="needs-script" data-testid="settings-form-needs-script">
    Saving needs JavaScript: this demo keeps the settings in your browser.
  </p>
</form>
<script type="module" src="settings-form.ts"></script>
`,
  ],

  [
    "src/components/settings-form/settings-form.css",
    `.form {
  display: grid;
  gap: var(--space-3);
  max-width: 34rem;
}

.demo {
  padding: var(--space-2) var(--space-3);
  border-inline-start: 3px solid var(--color-warn);
  background: var(--color-bg);
  font-size: 0.9375rem;
}

/* A label wraps its control, so the two are one block. */
.row {
  display: grid;
  gap: var(--space-1);
  font-weight: 600;
}

/* A hint or message belongs to the field above it, so it sits closer than the next field. */
.hint,
.error {
  margin-top: calc(var(--space-2) * -1);
  font-size: 0.875rem;
}

.hint {
  color: var(--color-muted);
}

.check {
  display: flex;
  gap: var(--space-2);
  align-items: center;
}

/* The label is bold; what is typed into its control is not. */
.input {
  font-weight: 400;
}

/* An invalid field has a thicker border and its message below it, not only a color. */
.input[aria-invalid="true"] {
  border-color: var(--color-down);
  border-width: 2px;
}

.error {
  color: var(--color-down);
  font-weight: 600;
}

.problem {
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-down);
  border-radius: var(--radius);
  color: var(--color-down);
}

/* An author display value beats the hidden attribute, so restate it. */
.error[hidden],
.problem[hidden] {
  display: none;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: center;
}

.note {
  color: var(--color-muted);
  font-size: 0.875rem;
}

.saved {
  color: var(--color-up);
  font-weight: 600;
}
`,
  ],

  [
    "src/components/settings-form/settings-form.ts",
    `/**
 * Validation and storage for <settings-form>.
 *
 * Demo only: the settings are saved to this browser's localStorage and nothing
 * else reads them. A real dashboard would send them to an API route
 * (src/api/settings.ts) that checks the signed-in user and validates again on
 * the server, because a browser check can be skipped.
 *
 * The component loads this file as a module, so the pure functions are
 * exported for settings-form.test.ts. \`mount()\` is the only part that touches
 * the page.
 */

export interface Settings {
  shopName: string;
  email: string;
  lowStock: number;
  currency: string;
  digest: boolean;
}

/** What the form holds before it is checked: every field is text, as typed. */
export interface SettingsInput {
  shopName: string;
  email: string;
  lowStock: string;
  currency: string;
  digest: boolean;
}

export type SettingsField = "shopName" | "email" | "lowStock" | "currency";
export type SettingsErrors = Partial<Record<SettingsField, string>>;

/** The result of a check: the settings when every field is valid, and one message per field that is not. */
export interface Validation {
  settings?: Settings;
  errors: SettingsErrors;
}

/** Settings read back from storage. \`problem\` says why the defaults are used instead. */
export interface Saved {
  settings: Settings;
  problem?: string;
}

export const STORAGE_KEY = "dashboard-settings";
export const CURRENCIES: readonly string[] = ["USD", "CAD", "EUR", "GBP"];
export const DEFAULT_SETTINGS: Settings = {
  shopName: "Corner Bookshop",
  email: "orders@example.com",
  lowStock: 8,
  currency: "USD",
  digest: true,
};

/** Checks what was typed. */
export function validateSettings(input: SettingsInput): Validation {
  const errors: SettingsErrors = {};
  const shopName = input.shopName.trim();
  const email = input.email.trim();
  const lowStock = Number(input.lowStock.trim());
  if (shopName === "") errors.shopName = "Enter the shop's name.";
  else if (shopName.length > 60)
    errors.shopName = "Use 60 characters or fewer.";
  if (email === "") errors.email = "Enter an email address.";
  else if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email))
    errors.email = "Enter an email address such as orders@example.com.";
  if (input.lowStock.trim() === "") errors.lowStock = "Enter a number.";
  else if (!Number.isInteger(lowStock) || lowStock < 1 || lowStock > 500)
    errors.lowStock = "Enter a whole number from 1 to 500.";
  if (!CURRENCIES.includes(input.currency))
    errors.currency = "Choose a currency from the list.";
  if (Object.keys(errors).length > 0) return { errors };
  return {
    settings: {
      shopName,
      email,
      lowStock,
      currency: input.currency,
      digest: input.digest,
    },
    errors,
  };
}

/**
 * Settings read back from storage. Saved text is untrusted (another script, an
 * older version, or a person can have written it), so it is checked like typed
 * input.
 */
export function parseSaved(text: string | null): Saved {
  if (text === null) return { settings: DEFAULT_SETTINGS };
  const problem =
    "The settings saved in this browser could not be read, so the defaults are shown. Saving replaces them.";
  let saved: unknown;
  try {
    saved = JSON.parse(text);
  } catch {
    return { settings: DEFAULT_SETTINGS, problem };
  }
  if (typeof saved !== "object" || saved === null)
    return { settings: DEFAULT_SETTINGS, problem };
  const record = saved as Record<string, unknown>;
  const { settings } = validateSettings({
    shopName: typeof record.shopName === "string" ? record.shopName : "",
    email: typeof record.email === "string" ? record.email : "",
    lowStock:
      typeof record.lowStock === "number" ? String(record.lowStock) : "",
    currency: typeof record.currency === "string" ? record.currency : "",
    digest: record.digest === true,
  });
  return settings ? { settings } : { settings: DEFAULT_SETTINGS, problem };
}

function mount(): void {
  const form = document.getElementById("form") as HTMLFormElement;
  const saved = document.getElementById("saved") as HTMLElement;
  const problem = document.getElementById("problem") as HTMLElement;
  const fields = {
    shopName: document.getElementById("shop-name") as HTMLInputElement,
    email: document.getElementById("email") as HTMLInputElement,
    lowStock: document.getElementById("low-stock") as HTMLInputElement,
    currency: document.getElementById("currency") as HTMLSelectElement,
  };
  const messages = {
    shopName: document.getElementById("shop-name-error") as HTMLElement,
    email: document.getElementById("email-error") as HTMLElement,
    lowStock: document.getElementById("low-stock-error") as HTMLElement,
    currency: document.getElementById("currency-error") as HTMLElement,
  };
  const digest = document.getElementById("digest") as HTMLInputElement;
  const names = Object.keys(fields) as SettingsField[];

  const fill = (settings: Settings): void => {
    fields.shopName.value = settings.shopName;
    fields.email.value = settings.email;
    fields.lowStock.value = String(settings.lowStock);
    fields.currency.value = settings.currency;
    digest.checked = settings.digest;
  };

  const showErrors = (errors: SettingsErrors): void => {
    for (const name of names) {
      const message = errors[name] ?? "";
      messages[name].textContent = message;
      messages[name].hidden = message === "";
      fields[name].setAttribute("aria-invalid", String(message !== ""));
    }
  };

  const showProblem = (text: string): void => {
    problem.textContent = text;
    problem.hidden = text === "";
  };

  const load = (): void => {
    try {
      const result = parseSaved(localStorage.getItem(STORAGE_KEY));
      fill(result.settings);
      showProblem(result.problem ?? "");
    } catch {
      fill(DEFAULT_SETTINGS);
      showProblem(
        "This browser is blocking storage, so settings cannot be saved here.",
      );
    }
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    saved.textContent = "";
    const { settings, errors } = validateSettings({
      shopName: fields.shopName.value,
      email: fields.email.value,
      lowStock: fields.lowStock.value,
      currency: fields.currency.value,
      digest: digest.checked,
    });
    showErrors(errors);
    if (!settings) {
      fields[names.find((name) => errors[name])!].focus();
      return;
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      showProblem(
        "The settings could not be saved: this browser is blocking storage.",
      );
      return;
    }
    fill(settings);
    showProblem("");
    saved.textContent = "Saved in this browser.";
  });

  document.getElementById("reset")!.addEventListener("click", () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Nothing was saved if storage is blocked, so there is nothing to remove.
    }
    fill(DEFAULT_SETTINGS);
    showErrors({});
    showProblem("");
    saved.textContent = "Defaults restored.";
  });

  form.addEventListener("input", () => {
    saved.textContent = "";
  });

  // The script shows its own messages beside each field, so the browser's bubbles are turned off.
  form.noValidate = true;
  load();
  document.getElementById("needs-script")!.hidden = true;
  (document.getElementById("save") as HTMLButtonElement).disabled = false;
  (document.getElementById("reset") as HTMLButtonElement).disabled = false;
}

// Vitest imports this file in Node, where there is no page to mount on.
if (typeof document !== "undefined") mount();
`,
  ],

  [
    "src/components/settings-form/settings-form.test.ts",
    `import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  parseSaved,
  validateSettings,
  type SettingsInput,
} from "./settings-form.ts";

const input = (changes: Partial<SettingsInput> = {}): SettingsInput => ({
  shopName: "Corner Bookshop",
  email: "orders@example.com",
  lowStock: "8",
  currency: "USD",
  digest: false,
  ...changes,
});

/** The opening tag of the element with this id, however its attributes are ordered or wrapped. */
const tagWithId = (html: string, id: string): string =>
  new RegExp(\`<[a-z]+\\\\b[^>]*\\\\bid="\${id}"[^>]*>\`).exec(html)?.[0] ?? "";

describe("settings-form component", () => {
  const source = (): Promise<string> =>
    readFile(
      join(process.cwd(), "src/components/settings-form/settings-form.html"),
      "utf8",
    );

  it("labels every control and ties each field to its error message", async () => {
    const html = await source();
    for (const id of ["shop-name", "email", "low-stock", "currency"]) {
      expect(html).toContain(\`for="\${id}"\`);
      expect(html).toContain(\`id="\${id}"\`);
      expect(html).toContain(\`id="\${id}-error"\`);
      expect(tagWithId(html, id)).toMatch(
        new RegExp(\`aria-describedby="[^"]*\${id}-error"\`),
      );
    }
    expect(html).toContain('for="digest"');
  });

  it("has a live region for the confirmation and an alert for a problem", async () => {
    const html = await source();
    expect(tagWithId(html, "saved")).toContain('role="status"');
    expect(tagWithId(html, "problem")).toContain('role="alert"');
    expect(tagWithId(html, "problem")).toMatch(/\\bhidden\\b/);
  });

  it("says it is a demo, and keeps its buttons off until the script runs", async () => {
    const html = await source();
    expect(html).toContain("<strong>Demo.</strong>");
    expect(tagWithId(html, "save")).toContain('type="submit"');
    expect(tagWithId(html, "save")).toMatch(/\\bdisabled\\b/);
    expect(tagWithId(html, "needs-script")).not.toMatch(/\\bhidden\\b/);
    expect(html).toContain("Saving needs JavaScript");
  });
});

describe("validateSettings", () => {
  it("returns trimmed settings when every field is valid", () => {
    expect(
      validateSettings(
        input({ shopName: "  Corner Bookshop ", lowStock: " 12 " }),
      ),
    ).toEqual({
      settings: {
        shopName: "Corner Bookshop",
        email: "orders@example.com",
        lowStock: 12,
        currency: "USD",
        digest: false,
      },
      errors: {},
    });
  });

  it("misuse: an empty form gets one message per required field and no settings", () => {
    const result = validateSettings(
      input({ shopName: " ", email: "", lowStock: "" }),
    );
    expect(result.settings).toBeUndefined();
    expect(Object.keys(result.errors).sort()).toEqual([
      "email",
      "lowStock",
      "shopName",
    ]);
  });

  it.each([
    ["no at sign", "orders.example.com"],
    ["no domain", "orders@"],
    ["a space", "orders @example.com"],
    ["no dot in the domain", "orders@example"],
  ])("misuse: refuses an email with %s", (_what, email) => {
    expect(validateSettings(input({ email })).errors.email).toBeDefined();
  });

  it.each(["0", "-3", "501", "2.5", "eight", "1e999", "NaN"])(
    "misuse: refuses the threshold %s",
    (lowStock) => {
      const result = validateSettings(input({ lowStock }));
      expect(result.settings).toBeUndefined();
      expect(result.errors.lowStock).toBeDefined();
    },
  );

  it("accepts the smallest and largest thresholds", () => {
    expect(validateSettings(input({ lowStock: "1" })).settings?.lowStock).toBe(
      1,
    );
    expect(
      validateSettings(input({ lowStock: "500" })).settings?.lowStock,
    ).toBe(500);
  });

  it("misuse: refuses a name that is too long and a currency that is not in the list", () => {
    expect(
      validateSettings(input({ shopName: "x".repeat(61) })).errors.shopName,
    ).toBeDefined();
    expect(
      validateSettings(input({ currency: "DOGE" })).errors.currency,
    ).toBeDefined();
  });

  it("keeps markup in a name as text: escaping is the page's job, and the form only ever sets values", () => {
    const { settings } = validateSettings(
      input({ shopName: "<b>Tom & Ann</b>" }),
    );
    expect(settings?.shopName).toBe("<b>Tom & Ann</b>");
  });
});

describe("parseSaved", () => {
  it("gives the defaults, with no problem, when nothing was saved", () => {
    expect(parseSaved(null)).toEqual({ settings: DEFAULT_SETTINGS });
  });

  it("reads back what the form saved", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      shopName: "Second Story",
      lowStock: 3,
    };
    expect(parseSaved(JSON.stringify(settings))).toEqual({ settings });
  });

  it.each([
    ["text that is not JSON", "{not json"],
    ["an empty string", ""],
    ["JSON that is not an object", '"hello"'],
    ["null", "null"],
    ["an array", "[1, 2]"],
    ["an object with a field missing", '{"shopName":"A"}'],
    [
      "a threshold saved as text",
      JSON.stringify({ ...DEFAULT_SETTINGS, lowStock: "8" }),
    ],
    [
      "a value out of range",
      JSON.stringify({ ...DEFAULT_SETTINGS, lowStock: 9000 }),
    ],
  ])("misuse: %s gives the defaults and says why", (_what, text) => {
    const result = parseSaved(text);
    expect(result.settings).toEqual(DEFAULT_SETTINGS);
    expect(result.problem).toMatch(/could not be read/);
  });
});
`,
  ],
];
