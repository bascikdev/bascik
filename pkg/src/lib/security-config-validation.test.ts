/**
 * Config validation for the `security` toggles, `scripts.stripAnsi`,
 * `scripts.renderLimits` and `components.expansionLimits` (Collin
 * 2026-10-29: "the code you wrote is the code that ships"). Misuse lens:
 * every wrong type, typo, out-of-range number and misplaced header gets a
 * located error that says what to write instead, and all of them report
 * together across mode layers.
 */
import { describe, it, expect, vi } from "vitest";

// userConfig is mocked so config.ts can be imported without top-level await
vi.mock("./userConfig.js", () => ({
  config: {},
  modeOverrides: {},
  buildConfig: {},
}));

import * as validation from "./config-validation.ts";
import {
  validateConfigShape,
  validateUserConfig,
  collectConfigWarnings,
} from "./config-validation.ts";
import { initBascikConfig } from "./config.ts";

const allowAllFs = {
  existsSync: () => true,
  isDirectory: () => true,
  isReadableFile: () => true,
};

const errorsFor = (config: unknown) => validateConfigShape(config);
const keysOf = (config: unknown) => errorsFor(config).map((e) => e.key);
const one = (config: unknown, key: string) => {
  const errors = errorsFor(config).filter((e) => e.key === key);
  expect(errors, `errors for ${key}`).toHaveLength(1);
  return errors[0];
};

const SECURITY_BOOLEANS = [
  "blockScriptUrls",
  "blockCodeBindings",
  "privateDynamicPages",
  "stripDirectiveScripts",
  "hideDotfiles",
] as const;

describe("security: valid values pass", () => {
  it.each([
    [{}],
    [{ blockScriptUrls: false }],
    [{ blockCodeBindings: false }],
    [{ headers: true }],
    [{ headers: false }],
    [{ headers: {} }],
    [{ headers: { "x-frame-options": "DENY" } }],
    [{ headers: { "x-frame-options": false } }],
    [{ headers: { "X-Frame-Options": "DENY" } }],
    [{ headers: { "x-content-type-options": false } }],
    [{ headers: { "referrer-policy": "no-referrer" } }],
    [{ headers: { "cross-origin-opener-policy": "same-origin" } }],
    [{ headers: { "cross-origin-resource-policy": "same-site" } }],
    [{ hsts: true }],
    [{ hsts: false }],
    [{ hsts: {} }],
    [{ hsts: { maxAge: 0 } }],
    [{ hsts: { maxAge: 63072000, includeSubDomains: true, preload: true } }],
    [{ privateDynamicPages: false }],
    [{ stripDirectiveScripts: false }],
    [{ hideDotfiles: false }],
    [
      {
        blockScriptUrls: true,
        blockCodeBindings: true,
        headers: true,
        hsts: true,
        privateDynamicPages: true,
        stripDirectiveScripts: true,
        hideDotfiles: true,
      },
    ],
  ])("accepts security %j", (security) => {
    expect(errorsFor({ security })).toEqual([]);
  });

  it("accepts scripts.stripAnsi and both limit objects", () => {
    expect(
      errorsFor({
        scripts: {
          stripAnsi: false,
          renderLimits: {
            maxInstances: 5000,
            maxOutputLength: 8 * 1024 * 1024,
            maxNestedScripts: 128,
            maxDepth: 8,
            rescanFactor: 32,
            rescanBase: 64 * 1024 * 1024,
          },
        },
        components: {
          expansionLimits: { maxInstances: 20000, maxPageLength: 100_000_000 },
        },
      }),
    ).toEqual([]);
  });

  it("accepts partial limit objects", () => {
    expect(
      errorsFor({
        scripts: { renderLimits: { maxDepth: 8 } },
        components: { expansionLimits: { maxInstances: 1 } },
      }),
    ).toEqual([]);
  });
});

describe("security: wrong types", () => {
  it.each([true, false, "on", 1, null, ["blockScriptUrls"]])(
    "security: %j is an error that names every protection to turn off by name (no master switch)",
    (security) => {
      const error = one({ security }, "security");
      expect(error.message).toContain("expected an object");
      for (const key of [
        "blockScriptUrls",
        "blockCodeBindings",
        "headers",
        "hsts",
        "privateDynamicPages",
        "stripDirectiveScripts",
        "hideDotfiles",
      ])
        expect(error.message).toContain(key);
    },
  );

  it.each(SECURITY_BOOLEANS)("security.%s must be true or false", (key) => {
    for (const value of ["false", 0, 1, null, {}, "off"]) {
      const error = one({ security: { [key]: value } }, `security.${key}`);
      expect(error.message, String(value)).toContain("expected true or false");
    }
  });

  it.each(["yes", 1, null, ["x-frame-options"]])(
    "security.headers: %j is not a boolean or an object",
    (headers) => {
      const error = one({ security: { headers } }, "security.headers");
      expect(error.message).toContain(
        "expected true, false, or an object of header names",
      );
    },
  );

  it.each(["1y", 1, null, ["max-age=1"]])(
    "security.hsts: %j is not a boolean or an object",
    (hsts) => {
      const error = one({ security: { hsts } }, "security.hsts");
      expect(error.message).toContain(
        "expected true, false, or an object { maxAge?, includeSubDomains?, preload? }",
      );
    },
  );

  it.each([-1, 1.5, "1y", "31536000", NaN, Infinity, null])(
    "security.hsts.maxAge: %j is not a whole number of seconds",
    (maxAge) => {
      const error = one(
        { security: { hsts: { maxAge } } },
        "security.hsts.maxAge",
      );
      expect(error.message).toContain(
        "expected a whole number of seconds, 0 or more (31536000 is one year)",
      );
    },
  );

  it.each(["includeSubDomains", "preload"])(
    "security.hsts.%s must be true or false",
    (key) => {
      const error = one(
        { security: { hsts: { [key]: "yes" } } },
        `security.hsts.${key}`,
      );
      expect(error.message).toContain("expected true or false");
    },
  );
});

describe("security.headers: names and values", () => {
  it("a misspelled header name gets a did-you-mean with the full path", () => {
    const error = one(
      { security: { headers: { "X-Frame-Option": "DENY" } } },
      "security.headers.X-Frame-Option",
    );
    expect(error.message).toContain(
      'did you mean "security.headers.x-frame-options"?',
    );
  });

  it("strict-transport-security under headers points to security.hsts", () => {
    const error = one(
      { security: { headers: { "Strict-Transport-Security": "max-age=1" } } },
      "security.headers.Strict-Transport-Security",
    );
    expect(error.message).toContain("set it with security.hsts");
  });

  it("content-security-policy under headers points to contentSecurityPolicy", () => {
    const error = one(
      {
        security: {
          headers: { "content-security-policy": "default-src 'self'" },
        },
      },
      "security.headers.content-security-policy",
    );
    expect(error.message).toContain("set it with contentSecurityPolicy");
  });

  it("a header Bascik does not send says security.headers only changes its own and lists them", () => {
    const error = one(
      { security: { headers: { "permissions-policy": "camera=()" } } },
      "security.headers.permissions-policy",
    );
    expect(error.message).toContain(
      "security.headers changes only the headers Bascik sends by default",
    );
    for (const name of [
      "x-content-type-options",
      "x-frame-options",
      "referrer-policy",
      "cross-origin-opener-policy",
      "cross-origin-resource-policy",
    ])
      expect(error.message).toContain(name);
    expect(error.message).toContain(
      "send other headers from your host or an API route",
    );
  });

  it.each([1, true, null, ["DENY"], {}])(
    "a header value %j that is not a string or false is an error",
    (value) => {
      const error = one(
        { security: { headers: { "x-frame-options": value } } },
        "security.headers.x-frame-options",
      );
      expect(error.message).toContain(
        "expected a header value string, or false to remove the header",
      );
    },
  );

  it("an empty header value says to use false to remove the header", () => {
    const error = one(
      { security: { headers: { "x-frame-options": "" } } },
      "security.headers.x-frame-options",
    );
    expect(error.message).toContain("use false to remove the header");
  });

  it.each([
    "DENY\r\nSet-Cookie: a=1",
    "DENY\nX-Evil: 1",
    "DENY\r",
    "DE\u0000NY",
    "DE\u0007NY",
  ])("a header value with a control character (%j) is an error", (value) => {
    const error = one(
      { security: { headers: { "x-frame-options": value } } },
      "security.headers.x-frame-options",
    );
    expect(error.message).toContain(
      "header values cannot contain line breaks or control characters",
    );
  });
});

describe("security.headers: values every host can send", () => {
  // Node's setHeader and the Worker's Headers both refuse anything outside
  // tab, 0x20-0x7E and 0x80-0xFF, on every response; a dash or curly quote
  // pasted from a document must fail at startup, not on each request.
  it.each([
    "SAMEORIGIN \u2014 strict",
    "\u201cDENY\u201d",
    "same-origin\u2026",
  ])(
    "a value with a character no host can send (%j) is a located error",
    (value) => {
      const error = one(
        { security: { headers: { "referrer-policy": value } } },
        "security.headers.referrer-policy",
      );
      expect(error.message).toContain(
        "header values can hold only printable ASCII and Latin-1 characters",
      );
      expect(error.message).toMatch(/U\+20(14|1C|26)/);
    },
  );

  it.each(["DENY", "no-referrer\tstrict-origin", "caf\u00e9"])(
    "a value inside the byte range (%j) passes",
    (value) => {
      expect(
        keysOf({ security: { headers: { "referrer-policy": value } } }),
      ).toEqual([]);
    },
  );

  it("the same header named twice in different letter case is an error", () => {
    const errors = errorsFor({
      security: {
        headers: { "X-Frame-Options": "DENY", "x-frame-options": false },
      },
    });
    expect(errors.map((e) => e.key)).toEqual([
      "security.headers.x-frame-options",
    ]);
    expect(errors[0].message).toContain(
      'names the same header as "X-Frame-Options"; keep one',
    );
  });
});

// The top-level typo, spelled without the literal so the spelling check
// does not flag a deliberate misspelling.
const SECURITY_TYPO = "security".replace("ri", "r");

describe("typos get did-you-mean", () => {
  it.each([
    [{ [SECURITY_TYPO]: {} }, SECURITY_TYPO, 'did you mean "security"?'],
    [
      { security: { blockScriptUrl: false } },
      "security.blockScriptUrl",
      'did you mean "security.blockScriptUrls"?',
    ],
    [
      { security: { blockCodeBinding: false } },
      "security.blockCodeBinding",
      'did you mean "security.blockCodeBindings"?',
    ],
    [
      { security: { hideDotFiles: false } },
      "security.hideDotFiles",
      'did you mean "security.hideDotfiles"?',
    ],
    [
      { security: { hsts: { maxage: 1 } } },
      "security.hsts.maxage",
      'did you mean "security.hsts.maxAge"?',
    ],
    [
      { security: { hsts: { includeSubdomains: true } } },
      "security.hsts.includeSubdomains",
      'did you mean "security.hsts.includeSubDomains"?',
    ],
    [
      { scripts: { stripAnsii: false } },
      "scripts.stripAnsii",
      'did you mean "scripts.stripAnsi"?',
    ],
    [
      { scripts: { renderLimits: { maxInstance: 10 } } },
      "scripts.renderLimits.maxInstance",
      'did you mean "scripts.renderLimits.maxInstances"?',
    ],
    [
      { scripts: { renderLimit: {} } },
      "scripts.renderLimit",
      'did you mean "scripts.renderLimits"?',
    ],
    [
      { components: { expansionLimits: { maxPageLenght: 10 } } },
      "components.expansionLimits.maxPageLenght",
      'did you mean "components.expansionLimits.maxPageLength"?',
    ],
  ])("%j", (config, key, suggestion) => {
    const error = one(config, key);
    expect(error.unknownKey).toBe(true);
    expect(error.message).toContain(suggestion);
  });
});

describe("limits: positive whole numbers", () => {
  const RENDER_KEYS = [
    "maxInstances",
    "maxOutputLength",
    "maxNestedScripts",
    "maxDepth",
    "rescanFactor",
    "rescanBase",
  ];
  const EXPANSION_KEYS = ["maxInstances", "maxPageLength"];
  const BAD = [0, -1, 1.5, "1000", NaN, Infinity, null, true];

  it.each(RENDER_KEYS)(
    "scripts.renderLimits.%s rejects 0, negatives, fractions, strings, NaN and Infinity",
    (key) => {
      for (const value of BAD) {
        const error = one(
          { scripts: { renderLimits: { [key]: value } } },
          `scripts.renderLimits.${key}`,
        );
        expect(error.message, String(value)).toContain(
          "expected a positive whole number",
        );
      }
    },
  );

  it.each(EXPANSION_KEYS)(
    "components.expansionLimits.%s rejects 0, negatives, fractions, strings, NaN and Infinity",
    (key) => {
      for (const value of BAD) {
        const error = one(
          { components: { expansionLimits: { [key]: value } } },
          `components.expansionLimits.${key}`,
        );
        expect(error.message, String(value)).toContain(
          "expected a positive whole number",
        );
      }
    },
  );

  it("a number past Number.MAX_SAFE_INTEGER is rejected", () => {
    one(
      { scripts: { renderLimits: { maxInstances: 2 ** 60 } } },
      "scripts.renderLimits.maxInstances",
    );
  });

  it.each([true, 1000, "1000", null, [1000]])(
    "scripts.renderLimits: %j is not an object",
    (renderLimits) => {
      const error = one({ scripts: { renderLimits } }, "scripts.renderLimits");
      expect(error.message).toContain("expected an object {");
      expect(error.message).toContain("maxInstances");
    },
  );

  it.each([true, 10000, null])(
    "components.expansionLimits: %j is not an object",
    (expansionLimits) => {
      const error = one(
        { components: { expansionLimits } },
        "components.expansionLimits",
      );
      expect(error.message).toContain("expected an object {");
      expect(error.message).toContain("maxPageLength");
    },
  );

  it.each(["false", 0, null, {}])(
    "scripts.stripAnsi: %j must be true or false",
    (stripAnsi) => {
      const error = one({ scripts: { stripAnsi } }, "scripts.stripAnsi");
      expect(error.message).toContain("expected true or false");
    },
  );
});

describe("every error reports together, in every mode layer", () => {
  it("one config with five mistakes reports five located errors", () => {
    expect(
      keysOf({
        security: {
          blockScriptUrls: "no",
          hsts: { maxAge: -1 },
          headers: { "x-frame-options": "" },
        },
        scripts: { renderLimits: { maxDepth: 0 }, stripAnsi: 1 },
      }).sort(),
    ).toEqual(
      [
        "security.blockScriptUrls",
        "security.headers.x-frame-options",
        "security.hsts.maxAge",
        "scripts.renderLimits.maxDepth",
        "scripts.stripAnsi",
      ].sort(),
    );
  });

  it("mistakes in the server and build exports are reported with the default export's", () => {
    const errors = validateUserConfig(
      { security: { hideDotfiles: "no" } },
      {
        server: { security: { hsts: { preload: "yes" } } },
        build: { components: { expansionLimits: { maxInstances: 0 } } },
      },
      { fs: allowAllFs },
    );
    expect(errors.map((e) => e.key).sort()).toEqual(
      [
        "components.expansionLimits.maxInstances",
        "security.hideDotfiles",
        "security.hsts.preload",
      ].sort(),
    );
  });

  it("initBascikConfig refuses to start and prints every security error", () => {
    expect(() =>
      initBascikConfig(
        {
          security: false as never,
          scripts: { renderLimits: { maxDepth: -2 } },
        } as never,
        {},
        {},
        { fs: allowAllFs },
      ),
    ).toThrow(/security[\s\S]*scripts\.renderLimits\.maxDepth/);
  });
});

describe("warnings", () => {
  it("hsts.preload without includeSubDomains warns that the preload list needs it", () => {
    const warnings = collectConfigWarnings(
      { security: { hsts: { preload: true } } },
      { fs: allowAllFs },
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].key).toBe("security.hsts.preload");
    expect(warnings[0].message).toContain(
      "the browser preload list requires includeSubDomains and a max-age of at least one year",
    );
  });

  it("hsts.preload with a max-age under a year warns", () => {
    const warnings = collectConfigWarnings(
      {
        security: {
          hsts: { preload: true, includeSubDomains: true, maxAge: 86400 },
        },
      },
      { fs: allowAllFs },
    );
    expect(warnings.map((w) => w.key)).toEqual(["security.hsts.preload"]);
  });

  it("a correct preload setting does not warn", () => {
    expect(
      collectConfigWarnings(
        { security: { hsts: { preload: true, includeSubDomains: true } } },
        { fs: allowAllFs },
      ),
    ).toEqual([]);
  });

  it("hsts maxAge 0 with includeSubDomains warns that includeSubDomains has no effect", () => {
    const warnings = collectConfigWarnings(
      { security: { hsts: { maxAge: 0, includeSubDomains: true } } },
      { fs: allowAllFs },
    );
    expect(warnings.map((w) => w.key)).toEqual([
      "security.hsts.includeSubDomains",
    ]);
    expect(warnings[0].message).toContain(
      "maxAge 0 clears the policy, so includeSubDomains has no effect",
    );
  });

  it("hsts maxAge 0 alone (the reset) does not warn", () => {
    expect(
      collectConfigWarnings(
        { security: { hsts: { maxAge: 0 } } },
        { fs: allowAllFs },
      ),
    ).toEqual([]);
  });

  it("turning a protection off is not itself a warning", () => {
    expect(
      collectConfigWarnings(
        {
          security: {
            blockScriptUrls: false,
            blockCodeBindings: false,
            headers: false,
            hsts: false,
            privateDynamicPages: false,
            stripDirectiveScripts: false,
            hideDotfiles: false,
          },
          scripts: { stripAnsi: false },
        },
        { fs: allowAllFs },
      ),
    ).toEqual([]);
  });
});

describe("collectModeOverrideWarnings: build-time settings in the server export", () => {
  const collect = (
    validation as unknown as {
      collectModeOverrideWarnings?: (
        overrides: unknown,
        userConfig?: unknown,
      ) => { key: string; message: string }[];
    }
  ).collectModeOverrideWarnings;

  it("is exported", () => {
    expect(typeof collect).toBe("function");
  });

  it.each([
    [{ security: { blockScriptUrls: false } }, "security.blockScriptUrls"],
    [{ security: { blockCodeBindings: false } }, "security.blockCodeBindings"],
    [
      { security: { stripDirectiveScripts: false } },
      "security.stripDirectiveScripts",
    ],
    [
      { components: { expansionLimits: { maxInstances: 5 } } },
      "components.expansionLimits",
    ],
  ])("server export %j warns about %s", (server, key) => {
    const warnings = collect!({ server });
    expect(warnings.map((w) => w.key)).toEqual([key]);
    expect(warnings[0].message).toContain(
      "has no effect in the server export: it applies when pages and components are built; set it in the default or build export",
    );
  });

  // hideDotfiles has a build half (are dotfiles published?) and a response
  // half (does the server answer them?). Set differently for the build and
  // the server, one half undoes the other.
  it.each([
    [{}, { server: { security: { hideDotfiles: false } } }],
    [{}, { build: { security: { hideDotfiles: false } } }],
    [
      { security: { hideDotfiles: false } },
      { server: { security: { hideDotfiles: true } } },
    ],
  ])(
    "default %j with overrides %j warns that the build and server disagree on hideDotfiles",
    (config, overrides) => {
      const warnings = collect!(overrides, config);
      expect(warnings.map((w) => w.key)).toEqual(["security.hideDotfiles"]);
      expect(warnings[0].message).toContain(
        "the build and the server must agree: the build decides whether dotfiles are published and the server whether it answers them",
      );
    },
  );

  it.each([
    [{ security: { hideDotfiles: false } }, {}],
    [
      {},
      {
        build: { security: { hideDotfiles: false } },
        server: { security: { hideDotfiles: false } },
      },
    ],
    [
      { security: { hideDotfiles: false } },
      { server: { security: { hideDotfiles: false } } },
    ],
  ])(
    "default %j with overrides %j agrees and does not warn",
    (config, overrides) => {
      expect(collect!(overrides, config)).toEqual([]);
    },
  );

  it.each([
    { security: { headers: false, hsts: false } },
    { security: { privateDynamicPages: false } },
    { scripts: { stripAnsi: false, renderLimits: { maxDepth: 8 } } },
  ])(
    "server export %j does not warn (it takes effect on the server)",
    (server) => {
      expect(collect!({ server })).toEqual([]);
    },
  );

  it("the same keys in the build export do not warn", () => {
    expect(
      collect!({
        build: {
          security: { blockScriptUrls: false, stripDirectiveScripts: false },
          components: { expansionLimits: { maxInstances: 5 } },
        },
      }),
    ).toEqual([]);
  });

  it("initBascikConfig prints the warning without refusing to start", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() =>
        initBascikConfig(
          {},
          { server: { security: { blockCodeBindings: false } } },
          { isProdServer: true },
          { fs: allowAllFs },
        ),
      ).not.toThrow();
      expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(
        /security\.blockCodeBindings[\s\S]*has no effect in the server export/,
      );
    } finally {
      warn.mockRestore();
    }
  });
});
