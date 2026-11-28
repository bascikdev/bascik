# Bascik AI on Cloudflare Workers

The bookshop chat from the `@bascik/ai` demo, running on Cloudflare Workers with Durable Objects. It is a public example, so it is built to be cheap and hard to abuse: replies come from the demo's scripted model (there is no model provider and no API key anywhere), every visitor's data is deleted 24 hours after their last message, and every send is counted per address.

This file is the owner's runbook. Nothing in this workspace deploys by itself: there is no route, no hostname, and no CI deploy job.

## What it shows

- **Typed chat with generative UI.** A message gets a reply streamed as HTML: prose, `<book-card>` tags in a `<card-grid>`, charts, forms, and buttons, rendered by the Worker with the components' scoped CSS. No client framework; the page works without JavaScript, and `chat-enhance` streams replies into the open page when it has it.
- **Tool approval.** "Hold a copy of ..." asks the reader before `place_hold` runs.
- **Memory with approval.** "Remember that I prefer short books" asks first (`memoryApproval: true`), shows what was saved with an Undo button, and a new conversation uses it. `/memory` lists everything with Forget buttons.
- **Conversation search.** The sidebar's search box, and the model's `search_conversations` tool.
- **Attachments.** Two files of 1 MB a message (PNG, JPEG, WebP, PDF, plain text, Markdown), stored in the reader's Durable Object. The scripted model names what it received.
- **Stop, a reload, and a second tab.** A reply belongs to the conversation, not to the request that started it: a reload mid-reply rejoins it from its first piece, a second tab follows it live, and Stop from either tab ends it and keeps what was written.

Left out on purpose: voice, the model picker and real models, and the demo's data, docs and review apps (they need `node:sqlite`, the file system, or a Node server).

## How it is built

```text
ai/examples/cloudflare/
  worker.ts                the Worker that deploys: a per-address request cap, then the Worker Bascik generates; exports the DO classes
  wrangler.wrapper.jsonc   the config that deploys (main = worker.ts)
  wrangler.jsonc           what `bascik --build --target cloudflare` reads for its generated config
  do/reader-data.ts        ReaderData: one SQLite object per reader (conversations, memories, files)
  do/conversation-live.ts  ConversationLive: one object per conversation, the chat's `Shared` store
  do/budget.ts             Budget: counters (new readers per day, sends per address per 10 minutes)
  src/lib/chat.ts          createChat over those objects; followLocally: false; waitUntil from the platform
  src/lib/cf-stores.ts     ConversationStore, MemoryStore, FileStore and Shared over the objects
  src/lib/shared-keys.ts   which ConversationLive object a shared key belongs to
  src/lib/guards.ts        411, 413, 405 and 429 answers, and the address key (an IPv6 address by its /64)
  src/lib/limits.ts        the per-address counters every chat route checks before the chat reads the request
  src/api/*.ts             the chat's routes; src/pages and src/components the page
  scripts/gen-catalog.ts   writes the catalog at build time (a Worker has no component folder to read)
```

The bookshop itself (`booksApp`, its tools and its scripted model) is imported from `ai/demo/src/lib/books-app.ts`, and the components from `ai/components` and `ai/demo/src/genui`. Nothing imports the demo's Node-only modules (`apps.ts`, `chat.ts`, `models.ts`); `tests/config.node.test.ts` checks the built Worker for them.

The page is the package's `<chat-app>` with two parts replaced. Its `sidebar` slot holds this example's `site-menu` (the package's `chat-sidebar` with the example's own links and note around the data parts `chat-find` and `chat-conversations`), and its `composer` slot holds a `chat-composer` whose `chat-attach` carries the same limits as `FILE_LIMITS` in `src/lib/chat.ts`. `/memory` is not a chat, so it uses the parts directly: `site-menu` beside a column that holds `chat-memories`. The data parts read the chat from the default export of `src/lib/chat.ts`, which here is a function of the request and its context, because the chat is made from the platform's bindings.

Two settings make the kit fit Workers (see "Hosts without shared memory" on the Bascik AI scaling page):

- `followLocally: false`. On Workers a request must never wait on another request's stream or promise, so every page that did not start a reply reads it from the conversation's ConversationLive object, and Stop goes through it too.
- `waitUntil`. Every route and stream script passes `context.platform.waitUntil` to the chat, so a reply keeps being written and is stored after the reader closes the tab. The turn is capped at 25 seconds and 4 model rounds to fit the time Cloudflare gives that work.

## Run it locally

From the repository root, after `yarn install`, `yarn pkg:build` and `yarn adapter:cf:build`:

```sh
yarn ai:cf:dev        # build, then wrangler dev in local workerd on http://127.0.0.1:9879
```

That runs `bascik --build --target cloudflare`, then `wrangler dev --config wrangler.wrapper.jsonc --local` with development-only secrets passed as `--var`. The Durable Objects' data is kept in `ai/examples/cloudflare/.wrangler-state/`, so it survives a restart; delete the folder to start over. `PORT`, `PERSIST_DIR` and `DEMO_MODEL_DELAY_MS` (the scripted model's pace; 150 makes a reply take about 20 seconds, long enough to try Stop and a second tab) change the defaults.

The other scripts:

```sh
yarn ai:cf:build      # write the catalog, then bascik --build --target cloudflare
yarn ai:cf:typecheck  # tsc over the Worker, the objects, the scripts and the tests
yarn ai:cf:unit       # build, then Vitest: plain Node tests and the objects in local workerd
yarn ai:cf:e2e        # Playwright against wrangler dev on port 9879 (stop `ai:cf:dev` first), with a fresh data folder
```

`yarn ai:cf:unit` runs the `@bascik/ai` contract suites (conversation, memory and file stores, and `Shared`) against the Durable Objects with `@cloudflare/vitest-plugin`. One `Shared` case is left out, and the test file says why. It also runs the chat's routes through the generated Worker (every spelling of a path Bascik routes to send is counted the same, and a reply a page starts is handed to `waitUntil`), the wrapper Worker's rate limit against a stand-in for the generated Worker, and checks the built bundle and the configs.

CI runs `ai:cf:build`, `ai:cf:unit` and `ai:cf:e2e` in the stage 4 job `ai-cf` whenever `ai/`, `adapters/cloudflare/` or a shared build file changes. The job only uses local workerd; it deploys nothing.

## Deploying (owner only)

An agent never runs these. They need a Cloudflare account and change what is live.

1. **Choose the plan.** The example is meant to fit the Workers Free plan: SQLite-backed Durable Objects are available there, the scripted model needs little CPU, and the config sets no `limits.cpu_ms`. If the dashboard shows requests ending for CPU time, move to Workers Paid and add `"limits": { "cpu_ms": 30000 }` to `wrangler.wrapper.jsonc`.
2. **Build** from the repository root: `yarn ai:cf:build`.
3. **Set the secrets**, from `ai/examples/cloudflare/`. Use long random values, and different ones:

   ```sh
   npx wrangler secret put IP_SALT --config wrangler.wrapper.jsonc
   npx wrangler secret put SESSION_SECRET --config wrangler.wrapper.jsonc
   ```

   Without `IP_SALT` every send is refused with 503. Without `SESSION_SECRET` the visitor cookie is not signed.

4. **Deploy**, from `ai/examples/cloudflare/`:

   ```sh
   npx wrangler deploy --config wrangler.wrapper.jsonc
   ```

   The first deploy creates the three Durable Object classes (migration `v1`). The Worker is then on `bascik-ai-example.<subdomain>.workers.dev`.

5. **Add a hostname**, if you want one, as `routes` in `wrangler.wrapper.jsonc` (for example `{ "pattern": "try.ai.bascik.dev", "custom_domain": true }`), then deploy again. `tests/config.node.test.ts` checks that no route is committed, so change that test in the same commit.
6. **Add a WAF rate-limiting rule** on the zone, for `POST /api/send`, of about 20 requests a minute per IP, if the zone has one to spare. The Worker's own caps (below) are a second line: the request cap is checked by the Workers Rate Limiting binding, which is counted per Cloudflare location, and the exact counters cost a Durable Object request to refuse.
7. **Watch it** in the dashboard: Workers Logs are on with a 10% sample (`observability`), and the Durable Objects page shows storage per class.

To change a limit, edit `vars` in both `wrangler.jsonc` and `wrangler.wrapper.jsonc` (the config test checks they match), rebuild, and deploy. To take the example down, delete the Worker in the dashboard; its Durable Objects go with it.

## Abuse limits

| What                            | Limit                                                                                                               | Where                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Requests per address            | 120 a minute to anything the Worker serves, then 429                                                                | `ratelimits` (`REQUESTS`) in the config           |
| Messages per address            | 30 per 10 minutes, then 429 with `Retry-After`; Approve, Deny and a tool's result count too, as each starts a reply | `GENUI_IP_SENDS`, Budget `ip:<hash>:<window>`     |
| Messages with files per address | 10 per 10 minutes                                                                                                   | `GENUI_IP_UPLOADS`                                |
| New readers per address         | 5 per UTC day (a send with no visitor cookie is a new reader), then 429                                             | `GENUI_IP_READERS`, Budget `ip:<hash>:day:<date>` |
| New readers who keep data       | 2000 per UTC day, then "The demo is full for today" (503)                                                           | `GENUI_DAILY_READERS`, Budget `day:<date>`        |
| Request body on `/api/*`        | 2.3 MB (413); a POST without `Content-Length` gets 411                                                              | `src/lib/guards.ts`                               |
| Methods on `/api/*`             | GET, HEAD and POST; anything else gets 405                                                                          | `src/lib/guards.ts`                               |
| Files                           | 2 a message, 1 MB each, 2 MB together; 3 MB kept per reader                                                         | `FILE_LIMITS` in `src/lib/chat.ts`, ReaderData    |
| Conversations                   | 20 per reader, 256 KB each (the oldest is deleted for a new one)                                                    | `src/lib/chat.ts`                                 |
| Memories                        | 50 per reader (the oldest goes)                                                                                     | ReaderData                                        |
| One reply                       | 25 seconds and 4 model rounds                                                                                       | `src/lib/chat.ts`                                 |

The counters run in the chat's routes (`src/lib/limits.ts`), on the route Bascik matched, so `/api/send/`, `/api/%73end` and `//api//send` are counted as `/api/send` is. `/api/file` and `/api/stop` answer 404 before any Durable Object is asked when the request has no visitor cookie. A client is its IPv4 address, or its IPv6 /64, since one IPv6 client usually holds a whole /64. An address is never stored: counters are named by a salted SHA-256 hash of it (`IP_SALT`), and each Budget object deletes itself once its window is over. The worst case for storage is about 2000 readers a day times their caps (roughly 8 MB each), for one day; real use is far less.

## Retention: 24 hours

Every write to a reader's ReaderData object moves its alarm to 24 hours later, and the alarm deletes everything the object holds: conversations, memories and files. A visitor who only looks writes nothing and keeps nothing. The visitor cookie lasts 24 hours too (`cookieSessions({ maxAgeSeconds: 86400 })`), so a visitor who comes back the next day starts as a new reader. The page says so under the welcome and in the sidebar.

ConversationLive objects hold a reply only while it is being written and for two minutes after, and delete themselves once nothing in them is current.

## What local runs do not prove

- How long Cloudflare keeps a reply going with `waitUntil` after the reader leaves. Local workerd does not report a closed tab, so the browser test of a closed tab passes with or without `waitUntil`; `tests/routes.workers.test.ts` checks that the reply is handed to it. The 25-second cap is set from Cloudflare's documented 30 seconds; check it on a deployment by closing a tab mid-reply and reloading.
- Production's 2 MB limit per SQLite value. Files are stored in 512 KB pieces and conversations are capped at 256 KB, so nothing comes near it.
- CPU time per request on the Free plan, which only the dashboard shows.
- A ConversationLive object that restarts mid-reply loses the reply's pieces in memory. A page that joins after that, before or after the writer's next piece, shows a note that the start is missing, and the whole reply once it is stored; `tests/shared.workers.test.ts` checks both orders.
