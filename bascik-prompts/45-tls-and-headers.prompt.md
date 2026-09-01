# 45: TLS certificates and security headers

Read `.github/prompts/00-README.md` first.

**Scope:** `pkg/src/lib/pki.ts`, `pkg/src/lib/server.ts`, `pkg/src/lib/http2.ts`.

---

## Part 1: the generated certificate is rejected by every modern browser

`pki.ts#L94-L102`:

```ts
await execFile("openssl", [
  "req",
  "-x509",
  "-newkey",
  "rsa:2048",
  "-keyout",
  keyPath,
  "-out",
  certPath,
  "-days",
  "365",
  "-nodes",
  "-subj",
  "/CN=localhost",
]).catch(async () => {
  await exec(
    `openssl req ... -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" ...`,
  );
});
```

**The primary branch omits `-addext subjectAltName`.**

It succeeds on any normal openssl install, so **the fallback that has the SAN never runs**.

Chrome and Safari have required SubjectAltName since 2017 and reject CN-only certificates
outright with `ERR_CERT_COMMON_NAME_INVALID`, **even when the certificate is manually trusted**.
So local HTTPS development simply does not work, and the code that would have fixed it is
unreachable.

The two branches also disagree on validity, **365 versus 36500 days**, and on digest. Unify them
into one code path with SAN, one validity, and one digest.

Include both `DNS:localhost` and `IP:127.0.0.1`, and consider `DNS:*.localhost` and `IP:::1`.

---

## Part 2: other `pki.ts` problems

| Problem                             | Detail                                                                                                                                                                                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **World-readable private keys**     | Key files are written with default permissions, typically world-readable after umask. **Private keys must be `0600`**                                                                                                                                                    |
| **Certificates in `process.cwd()`** | Nothing adds them to `.gitignore` and nothing warns. A developer can commit a private key. Prompt 08 made `init` write `.gitignore` entries; add these to that list, and warn if the files are not ignored                                                               |
| **Command injection on Windows**    | `#L69-L88` uses **shell string interpolation** of `pfxPath`. A project path containing a quote character is injection. The POSIX fallback (`#L100`) interpolates `keyPath` and `certPath` into a shell string the same way. **Use argument arrays, never shell strings** |
| **Hardcoded macOS paths**           | `PATH` is augmented with `/opt/homebrew/bin` and `/usr/local/bin` (`#L43-L50`)                                                                                                                                                                                           |
| **No expiry check**                 | `#L31-L33` only tests `access`, so **an expired certificate is reused forever** and the developer sees an inscrutable TLS error                                                                                                                                          |
| **openssl may be absent**           | Decide what happens when it is not installed. A clear message beats a spawn error                                                                                                                                                                                        |

---

## Part 3: an unwanted certificate is generated when real ones are configured

`server.ts#L541-L548`:

```ts
const { createSelfSignedCert } = await import("./pki.ts");
await createSelfSignedCert(); // no args
const { startHttp2Server } = await import("./http2.ts");
return startHttp2Server();
```

`createSelfSignedCert()` (`pki.ts#L117-L119`) calls `ensureCertificates()` with **no options**,
so it checks the **default** paths.

If the user configured real certificate paths, those defaults do not exist, so this call
**generates an unwanted self-signed pair into the project root**. Only afterward does
`startHttp2Server()` call `ensureCertificates({ keyFile, certFile })` (`http2.ts#L61-L64`) with
the real config.

The pre-call is redundant at best and actively wrong with custom certificates. **Remove it.**

Also: `tls.enabled` with an unreadable key or certificate surfaces as a raw Node fs error from
`http2.ts#L63-L64`. Prompt 05 added readability validation; **confirm it produces a clear message
here** rather than the raw error.

---

## Part 4: security headers

`SECURITY_HEADERS` (`server.ts#L20-L25`) contains only `x-content-type-options`,
`x-frame-options`, `referrer-policy`, and `permissions-policy`.

### Remove the dead one

`permissions-policy: interest-cohort=()` is **dead**. FLoC was withdrawn and the header is
ignored by all current browsers. Remove it, or replace `permissions-policy` with a directive set
that actually does something.

### Add the cross-origin isolation headers

`cross-origin-opener-policy`, `cross-origin-embedder-policy`, and
`cross-origin-resource-policy`.

**Choose defaults that do not break a normal site.** `cross-origin-embedder-policy: require-corp`
in particular breaks any cross-origin image or iframe that does not opt in. **Test that a page
with a cross-origin image still works** under whatever defaults you pick, and make them
configurable if the safe default is too weak to be useful.

### Do not add a CSP

**Decision, do not re-litigate.**

Bascik inlines scripts and styles, so a meaningful default CSP would need `'unsafe-inline'`,
which is worse than nothing because it advertises protection that does not exist.

Prompt 29 emits a **hash manifest** so the deploy layer can build a strict CSP. **Document that
division clearly**: Bascik emits hashes, the host sets the header.

### `x-robots-tag`

There is no config surface, so there is no way to mark a preview deployment noindex. Either add
it under `http`, or document the `exec` recipe for adding it at the host. Pick one and say which.

---

## TDD steps

Write each failing test first.

1. **The generated certificate has a SubjectAltName** covering `localhost` and `127.0.0.1`.
2. There is one generation code path, with one validity and one digest.
3. Private key files are written with `0600`.
4. **No shell string interpolation remains.** Assert argument arrays are used on both the Windows
   and POSIX paths. Include a path containing a quote character in the test.
5. An **expired** certificate is regenerated rather than reused.
6. A missing openssl produces a clear message.
7. **No self-signed pair is generated when real certificates are configured.**
8. An unreadable configured certificate produces a clear message, not a raw fs error.
9. `permissions-policy: interest-cohort=()` is gone.
10. COOP, COEP, and CORP are present with the chosen defaults.
11. **A page with a cross-origin image still works** under those defaults.
12. **No `content-security-policy` header is set.**
13. The `x-robots-tag` decision behaves as documented.

## Testing

**Unit:** all of the above. **Do not attempt to bind a TLS port in the sandbox.** Test
certificate generation and option assembly directly.

**E2E:**

- `playwright.server-http2.config.ts`: **the primary config**, since it is the TLS path. Assert
  the security headers are present with the expected values, and that a page containing a
  cross-origin image renders. If the harness already runs against a generated certificate, that
  alone exercises the SAN fix; assert the connection succeeds.
- `playwright.server.config.ts`: assert the same headers on the cleartext path, and that **no
  CSP header** is present.
- `playwright.dev.config.ts`: assert headers are consistent with the server modes, so a developer
  does not discover a header difference only in production.
- `playwright.config.ts` (static build): no new tests. Headers come from the host, not from
  build output. State that reasoning.

## Documentation

| File                               | Change                                                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/content/server.md`           | TLS setup, the generated development certificate and how to trust it, and what to do when openssl is missing                                      |
| `docs/content/deploying.md`        | **Bascik emits CSP hashes but does not set the header, and why.** Cross-link prompt 29. The COOP, COEP, and CORP defaults and when to change them |
| `docs/content/configuration.md`    | `http.tls`, and any header option you added                                                                                                       |
| `docs/content/internals/server.md` | The full security header set with a one-line rationale each                                                                                       |
| `docs/content/faq.md`              | "Why does my browser reject the dev certificate?" Now fixed, but searchable. "Does Bascik set a Content Security Policy?"                         |
| `docs/content/compatibility.md`    | **Required by repo policy** only if a scoping capability changed. Almost certainly none; **confirm rather than assume**                           |
| `docs/src/pages/assets/SKILL.md`   | Bascik does not set a CSP; use `generate.cspHashes` and set the header at the host. Sync `create/assets/SKILL.md`                                 |

## Acceptance criteria

- [ ] All thirteen tests failed before their fixes and pass after.
- [ ] **The generated certificate has a SAN**, one validity, and one digest, from one code path.
- [ ] Private keys are `0600`, and the certificate paths are gitignored with a warning if not.
- [ ] **No shell string interpolation remains anywhere in `pki.ts`.**
- [ ] Expired certificates are regenerated; missing openssl produces a clear message.
- [ ] **No self-signed pair is generated when real certificates are configured.**
- [ ] An unreadable configured certificate produces a clear message.
- [ ] `interest-cohort` is gone; COOP, COEP, and CORP are present.
- [ ] **A cross-origin image still works** under the chosen defaults, proven by E2E.
- [ ] **No `content-security-policy` header is set by Bascik.**
- [ ] The `x-robots-tag` decision is made and documented.
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] E2E added to dev and both server configs; the user has run `yarn e2e:all`.

## Do not do

- Do not add a `content-security-policy` header.
- Do not add nonce support. Prompt 29 already ruled it out.
- Do not use `shell: true` or interpolate paths into shell strings.
- Do not pick COEP defaults without testing a cross-origin image.
- Do not attempt to bind a TLS port in the sandbox.
- Do not run Playwright or pre-push scripts.
