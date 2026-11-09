# Security policy

## Reporting a vulnerability

Please report security problems privately. Do not open a public issue or discussion.

1. Open the [Security tab](https://github.com/bascikdev/bascik/security) of the repository.
2. Choose **Report a vulnerability** to start a private security advisory.
3. Describe the affected package and version, the impact, and steps to reproduce.

You will get a reply from a maintainer. A confirmed issue is fixed in a patch release and
credited in the advisory unless you ask to stay anonymous.

## Supported versions

Only the latest published release of each package receives security fixes:
`@bascik/bascik`, `create-bascik`, `@bascik/adapter-cloudflare`,
`@bascik/adapter-netlify`, `@bascik/language-server`, and the VS Code extension.

## Scope

In scope: the compiler, the built-in production server, the adapters, the scaffolder, and
the language server. Out of scope: vulnerabilities in a site you built with Bascik, and
findings in dev-only dependencies that never ship in a published package.
