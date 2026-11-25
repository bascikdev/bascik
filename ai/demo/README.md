# Bascik AI example

This is the example app for `@bascik/ai`. It shows a chat interface, generative UI, and voice calls for Bascik, a build tool for HTML components.

## What is in it

It serves four apps:

- Bookshop at `/`: A shop assistant that answers with cards, charts, and forms.
- Ask the docs at `/docs`: Answers from the documentation, with links to the pages they came from.
- Sales analyst at `/data`: Questions become SQL, and the results come back as tables and charts.
- Knowledge review at `/review`: Facts, open rules, code changes, and gaps, each shown in the form that fits it. Your answers are recorded.

Visitors can try:

- Typed chat: Visitors can ask questions and get streamed answers as HTML components.
- Tool approval: Some tools ask for approval before they run.
- Memory: Each app keeps what a reader told it, apart from conversations.
- Attachments: The Bookshop app accepts file attachments.
- Voice calls: When a voice provider is configured, visitors can start spoken calls.
- Reading aids: The docs app can show step lists, note boxes, and links to source pages.

## Run it

From the repository root:

```
yarn install
yarn pkg:build
yarn workspace @bascik/ai demo
```

For a production server:

```
yarn workspace @bascik/ai demo:build
yarn workspace @bascik/ai demo:server
```

## Choosing a model

With none set, it answers from a fixed offline script.

| Name                        | What it does                                                   | Default                                                    |
| --------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------- |
| `DEMO_MODEL_DELAY_MS`       | Delay in milliseconds between offline script chunks.           | `14`                                                       |
| `ANTHROPIC_API_KEY`         | Enables Claude.                                                | None                                                       |
| `ANTHROPIC_AUTH_TOKEN`      | Enables Claude.                                                | None                                                       |
| `ANTHROPIC_MODELS`          | Names Claude models to offer.                                  | `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` |
| `GENUI_LOCAL_MODELS`        | When `0`, local model servers are not offered.                 | Unset                                                      |
| `OLLAMA_HOST`               | Host for Ollama.                                               | `127.0.0.1:11434`                                          |
| `LMSTUDIO_HOST`             | Host for LM Studio.                                            | `127.0.0.1:1234`                                           |
| `OMLX_HOST`                 | Host for oMLX.                                                 | `127.0.0.1:8000`                                           |
| `OMLX_API_KEY`              | Key for oMLX.                                                  | None                                                       |
| `AZURE_OPENAI_MODELS`       | Names Azure deployments to offer.                              | None                                                       |
| `AZURE_OPENAI_ENDPOINT`     | Azure OpenAI endpoint.                                         | None; may use `AZURE_VOICE_LIVE_ENDPOINT`                  |
| `AZURE_VOICE_LIVE_ENDPOINT` | Azure voice endpoint. It can supply the Azure OpenAI resource. | None                                                       |
| `AZURE_OPENAI_API_KEY`      | Azure OpenAI key.                                              | None; may use Azure CLI sign-in                            |
| `AZURE_OPENAI_API`          | When `chat`, uses chat completions.                            | `responses`                                                |
| `OPENAI_BASE_URL`           | Base URL for an OpenAI-compatible server.                      | None                                                       |
| `OPENAI_API_KEY`            | Key for an OpenAI-compatible server.                           | None                                                       |
| `OPENAI_MODELS`             | Names models to offer.                                         | None; asks the server                                      |
| `OPENAI_LABEL`              | Label for an OpenAI-compatible server.                         | `OpenAI-compatible`                                        |

## Voice

With none set, no voice provider is offered.

| Name                          | What it does                                          | Default |
| ----------------------------- | ----------------------------------------------------- | ------- |
| `AZURE_VOICE_LIVE_ENDPOINT`   | Enables Azure voice live.                             | None    |
| `AZURE_VOICE_LIVE_WS`         | Enables Azure voice live. It can point at a stand-in. | None    |
| `AZURE_VOICE_LIVE_MODEL`      | Model for Azure voice live.                           | None    |
| `AZURE_VOICE_LIVE_VOICE`      | Voice for Azure voice live.                           | None    |
| `AZURE_VOICE_LIVE_API_KEY`    | Key for Azure voice live.                             | None    |
| `AZURE_VOICE_LIVE_TOKEN`      | Token for Azure voice live.                           | None    |
| `AZURE_VOICE_LIVE_RELAY_PORT` | Port for the Azure voice relay.                       | `0`     |
| `GEMINI_API_KEY`              | Enables Gemini Live.                                  | None    |
| `GEMINI_LIVE_MODEL`           | Model for Gemini Live.                                | None    |
| `GEMINI_LIVE_HTTP`            | HTTP base for Gemini Live tests.                      | None    |
| `GEMINI_LIVE_WS`              | WebSocket base for Gemini Live tests.                 | None    |

If Azure is enabled and neither key nor token is set, the server uses Azure CLI sign-in.

## Where data is kept

The demo writes to disk under `.data` in the current working directory.

- Conversations: `.data/<app>/<visitor>/<id>.json`.
- Memories: `.data/memory/<app>`.
- Attachments: `.data/books-files` for the Bookshop app.

## Hosting it

It needs a long-running Node server. Live replies and the Azure voice relay are held by the server process. The Azure voice relay has to outlive a request. A static host or an edge runtime will not do. A container on any Node host works. Never put a provider key in the browser. Set `GENUI_LOCAL_MODELS=0` on a deployed server so it does not look for Ollama or LM Studio on its own machine.
