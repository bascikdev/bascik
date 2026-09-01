# 07: CLI parsing

Read `.github/prompts/00-README.md` first.

**Scope:** `pkg/src/lib/cli.ts`, `pkg/src/index.ts`, and the argv read in
`pkg/src/lib/config.ts`.

---

## Bug 1: two independent argv parsers

`resolveCliAction` (`cli.ts#L85`) runs `filterNodeArgs` first. `config.ts#L5-L9` **re-parses
raw argv with no filtering**:

```ts
const args = process.argv.slice(2);
const isBuild = args.includes("--build") || ...
```

Any drift between them silently desyncs the CLI action from the resolved config.

**Fix:** parse once, in one place, and pass the result to config resolution.

---

## Bug 2: conflicting flags are accepted

`bascik --build --server` returns action `"server"` from `resolveCliAction`, which checks it
first (`cli.ts#L103-L107`), while `config.ts` sets **both** `isBuild: true` and
`isProdServer: true`.

The server then runs with `isBuild === true`, which changes behavior at `server.ts#L369`,
`mem.ts#L108`, and `processing.ts#L513`. No warning is emitted.

**Fix:** reject the combination with a clear error naming both flags.

---

## Bug 3: positionals are never validated

`KNOWN_SUBCOMMANDS` is defined at `cli.ts#L40` and re-exported at `#L132` but **never used**.

| Input                          | Today                                                                  |
| ------------------------------ | ---------------------------------------------------------------------- |
| `bascik build` (no dashes)     | Silently starts a **watching dev server** when the user wanted a build |
| `bascik buld`                  | Silently starts a dev server                                           |
| `bascik --check somefile.html` | Silently ignores the argument                                          |

**Fix:** use the constant. Reject an unknown positional, and suggest a near match using a simple
edit-distance check. Reject an unexpected argument to a flag that takes none.

---

## Bug 4: `--flag=value` is unsupported

`--log=./out.log` fails the `KNOWN_FLAGS.has(a)` check at `cli.ts#L88-L90` and errors as an
unknown flag. Only the space-separated form works.

**Fix:** support both forms for every value-taking flag.

Also decide and test what a duplicate flag does. `bascik --build --build` is accepted today
with no diagnostic, and because `includes()` is order-insensitive, precedence is fixed by
source order rather than user intent.

---

## Bug 5: `filterNodeArgs` is a brittle allowlist

`cli.ts#L43-L79` hardcodes a fixed set of Node flags. Any Node flag not in the list, such as
`--max-old-space-size=4096`, `--enable-source-maps`, or `--test`, leaks into `unknownFlags` and
**hard-fails the CLI** under profilers and wrappers.

**Fix:** make it resilient. Either treat everything before the script path as Node's, or keep
the allowlist but do not hard-fail on an unrecognized leading flag.

---

## Bug 6: unhandled rejections on three CLI paths

`index.ts#L96-L112`: `init`, `check`, and the server path all `await` without a `try`/`catch`.
Only dev and build are wrapped (`#L114-L127`).

The consequence is that the nicest error message in the codebase:

```text
[bascik] --serve: could not read dist/ directory.
Run `bascik --build` first to generate the production build.
```

(`serve.ts#L52-L56`, and note the flag is now `--server`) is delivered as an **unhandled
top-level rejection with a full stack trace and a Node warning banner**.

**Fix:** wrap every CLI path. One error boundary, consistent formatting.

---

## New flags

| Flag                  | Notes                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `--config <path>`     | Prompt 06 made the loader accept it; wire up the parsing                                    |
| `--port <n>`          | Overrides `http.port`                                                                       |
| `--host <name>`       | Overrides `http.hostname`                                                                   |
| `--log-level <level>` | Overrides `logging.level`. Today you cannot quiet CI output without editing the config file |
| `--site-url <url>`    | Prompt 04                                                                                   |
| `--env-file <path>`   | Prompt 04, repeatable                                                                       |

Every flag must appear in `--help` with an accurate description, and must respect the
precedence chain from `00-README.md`: a flag beats an environment variable beats the config
file.

---

## Fix the misleading help text

`cli.ts#L115-L127` overstates three things:

- `--serve  Serve the dist/ folder over HTTP/2` serves plain HTTP/1.1 unless TLS is enabled
  (`server.ts#L546-L554`). The flag is also now `--server`.
- `--check  Validate the project (pages, components, config)` never validated config. Prompt 05
  built the validation; confirm whether it is wired into `--check` yet. If not, correct the
  text now and prompt 51 will make the claim true.
- `--log [path]` is listed unconditionally but `index.ts#L73-L75` only honors it for `--build`.
  Either honor it everywhere or reject it elsewhere. Pick one and say so.

---

## TDD steps

Write each failing test first.

1. One parser: the action and the resolved config always agree. Construct a case that would
   desync under the old code.
2. `--build --server` is rejected, naming both flags.
3. `bascik build` is rejected with a suggestion. `bascik buld` too.
4. `--check somefile.html` is rejected rather than ignored.
5. `--flag=value` and `--flag value` produce the same result, for every value-taking flag.
6. A duplicate flag behaves per the documented decision.
7. An unrecognized leading Node flag does not hard-fail.
8. Each new flag parses, appears in `--help`, and overrides its config counterpart.
9. `init`, `check`, and the server path each emit a clean single-line error rather than an
   unhandled rejection. Assert no stack trace reaches stdout or stderr.
10. `--help` text matches actual behavior for all three previously misleading lines.

## Testing

**Unit:** all of the above, in `cli.test.ts`.

**E2E:** none directly, but confirm all four configs still start correctly after the rename and
the parser change, since the E2E harness invokes the CLI. If any harness script uses `--serve`,
update it.

**Verification:** run `bascik --help` and read it against the actual flag set.

## Documentation

| File                             | Change                                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `docs/content/cli.md`            | Every flag, both value forms, positional validation, conflicting-flag rejection, and the precedence note |
| `docs/content/configuration.md`  | Cross-link: a flag overrides the config file                                                             |
| `docs/src/pages/assets/SKILL.md` | The new flags and `--server`. Sync `create/assets/SKILL.md`                                              |

## Acceptance criteria

- [ ] Each of the ten tests failed before its fix and passes after.
- [ ] There is exactly one argv parser.
- [ ] Conflicting flags are rejected; unknown positionals are rejected with a suggestion.
- [ ] `--flag=value` works everywhere; duplicate-flag behavior is documented and tested.
- [ ] An unrecognized Node flag does not break the CLI.
- [ ] All six new flags exist, work, respect precedence, and appear accurately in `--help`.
- [ ] No CLI path can emit an unhandled rejection.
- [ ] `--help` contains no false claim.
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] The E2E harness still starts all four configs; the user has confirmed.

## Do not do

- Do not add a `--no-tls` flag unless you also implement it. The server skill file currently
  claims it exists; correcting that claim is enough.
- Do not add an argument-parsing dependency. The surface is small.
- Do not change server or build behavior. Flags only.
- Do not run Playwright or pre-push scripts.
