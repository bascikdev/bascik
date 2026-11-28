# Bascik AI starter

The smallest `@bascik/ai` project that runs: one page that is `<chat-app />`, answered by a scripted model, so it needs no key.

## What is in it

- `src/pages/index.html`: the page. Its body is one tag, `<chat-app />`, and its head holds the theme stylesheet and the `rel="expect"` link that keeps the first paint whole.
- `src/pages/style.css`: the theme tokens the chat parts read.
- `src/lib/chat.ts`: the project's chat, made with `createChat`. Its default export is what the parts on the page read.
- `src/api/`: one file per route the parts post to (`send`, `stop`, `open`, `file`), each one line.

## Run it

From the repository root:

```
yarn install
yarn pkg:build
yarn workspace @bascik/ai starter
```

It prints the address it serves at. `yarn workspace @bascik/ai starter:build` then `starter:server` runs the production server.

## In a project of your own

This example reads the chat parts and the model's catalog from the package's folder beside it (`../../components`). A project outside this repository gets them by copy:

```
npm i @bascik/bascik @bascik/ai
npm i -D esbuild
npx bascik add @bascik/ai
```

esbuild is needed because some chat parts (`chat-enhance`, `chat-attach`) import TypeScript modules from the folders beside them, which Bascik bundles with it.

Then copy `src/` from this folder, and change two lines: remove the `directory` entry in `bascik.config.ts`, and set `CATALOG_DIR` in `src/lib/chat.ts` to `join(process.cwd(), "src", "components", "catalog")`.

## Where to go from here

- A real model: replace `scriptedModel` in `src/lib/chat.ts`.
- Other words on an empty chat: `welcome` in `src/lib/chat.ts`.
- A part with other props, or more parts: fill a slot of `chat-app` (`sidebar`, `composer`), as its reference comment shows.
- Another layout: copy the template of `chat-app.html` into the page and change it. It is nothing but the parts.
