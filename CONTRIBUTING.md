# Contributing

Thanks for helping with Bascik. Bug reports, docs fixes, and focused pull requests are all
welcome.

## Before you start

- Search the [issues](https://github.com/bascikdev/bascik/issues) first.
- For a larger change, open an issue so we can agree on the approach before you write code.
- Report security problems privately. See [SECURITY.md](SECURITY.md).
- Everyone is expected to follow the [code of conduct](CODE_OF_CONDUCT.md).

## Set up

You need Node 24.21 or newer and Yarn (the repository pins it through Corepack).

```sh
corepack enable
yarn install
yarn pkg:build
```

The [README](README.md) lists the workspaces and the test commands. The
[internals docs](https://bascik.dev/internals) explain the compiler, the server, and the
test lanes.

## Making a change

1. Write a failing test first, then the smallest change that makes it pass.
2. Fix bugs in `pkg/src/`, not with a workaround in `docs/content/`.
3. Run `yarn check:format` and `yarn check:spelling`, plus the tests for the package you
   touched.
4. Add a bullet under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for any change a
   user would notice, naming the package.
5. Open a pull request against `main` and fill in the template.

Use American English, and write plain sentences without em-dashes.

## Releases

Maintainers publish releases. See [RELEASING.md](RELEASING.md).
