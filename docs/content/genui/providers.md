# Providers

`@bascik/genui` talks to model providers through small adapters. A text adapter returns a `Model` function. A voice adapter returns a `VoiceProvider` that makes a browser ticket.

## Claude

The Claude adapter streams replies from the Claude API through the official SDK. It sends each round's text and tool calls, then yields the calls for the turn to run.

```ts
import { anthropicModel } from "@bascik/genui/anthropic";

const model = anthropicModel({
  model: "claude-opus-5-5",
  effort: "low",
  maxTokens: 64_000,
});
```

| Option      | Default                                                   | What it does                                                        |
| :---------- | :-------------------------------------------------------- | :------------------------------------------------------------------ |
| `client`    | A client that reads its credentials from the environment. | Uses an existing Anthropic client.                                  |
| `model`     | `claude-opus-5-5`                                         | Names the Claude model.                                             |
| `effort`    | `low`                                                     | Sets how much the model thinks before it answers. `low` suits chat. |
| `maxTokens` | `64_000`                                                  | Sets the reply length limit.                                        |

The adapter keeps the last 500 tool-call rounds by the first call's id. If a round is not remembered, it rebuilds that round from the stored parts. A paused turn is continued inside the adapter and is one round to the caller. If a safety classifier declines the request, the API retries it on a fallback model inside the same call.

## OpenAI-compatible servers

This adapter works with Ollama, LM Studio, and any server that speaks the OpenAI chat completions API. It uses `fetch` and reads the event stream itself, so there is no SDK.

```ts
import { openAiCompatibleModel } from "@bascik/genui/openai";

const model = openAiCompatibleModel({
  baseUrl: "http://127.0.0.1:11434/v1",
  model: "model-name",
});
```

| Option    | Default             | What it does                                                                                               |
| :-------- | :------------------ | :--------------------------------------------------------------------------------------------------------- |
| `baseUrl` | None.               | Sets the API root, for example `http://127.0.0.1:11434/v1`.                                                |
| `model`   | None.               | Names the model on that server.                                                                            |
| `apiKey`  | None.               | Sends a bearer token when set. Local servers need none.                                                    |
| `fetch`   | The global `fetch`. | Replaces `fetch`, for a test or a proxy.                                                                   |
| `body`    | None.               | Adds extra fields to the request body, for a server that needs one, such as `{ reasoning_effort: "low" }`. |

A tool call arrives in pieces: its name first, then its input. If the reply is cut off at the length limit, the adapter says so and does not run a truncated tool call. Input that is not JSON is passed on as it is, and the turn refuses it and tells the model.

## OpenAI Responses API

This adapter works with servers that speak the OpenAI Responses API: OpenAI itself and Azure OpenAI. It is needed when a newer model takes tools only on this API and not on chat completions.

```ts
import { openAiResponsesModel } from "@bascik/genui/openai-responses";

const model = openAiResponsesModel({
  baseUrl: "https://api.openai.com/v1",
  model: "model-name",
});
```

| Option    | Default             | What it does                                                                       |
| :-------- | :------------------ | :--------------------------------------------------------------------------------- |
| `baseUrl` | None.               | Sets the API root, for example `https://api.openai.com/v1`.                        |
| `model`   | None.               | Names the model, or on Azure the deployment's.                                     |
| `apiKey`  | None.               | Sends a bearer token when set.                                                     |
| `body`    | None.               | Adds extra fields to the request body, such as `{ reasoning: { effort: "low" } }`. |
| `fetch`   | The global `fetch`. | Replaces `fetch`, for a test or a proxy.                                           |

Nothing is kept on the server between rounds: each round sends the whole conversation. If the reply is cut off at the length limit, the adapter says so and does not run a truncated tool call. If the server reports a failed response, the adapter throws with the provider's message.

## Voice: Gemini Live

The Gemini Live adapter makes a one-use token for a speech-to-speech session. The browser connects to Google with that token, so it never sees the API key and cannot change what the session may do.

```ts
import { geminiLiveVoice } from "@bascik/genui/gemini-live";

const provider = geminiLiveVoice({
  model: "models/gemini-3.8-live",
  startWithinSeconds: 60,
  sessionSeconds: 900,
});
```

| Option               | Default                                     | What it does                                                                              |
| :------------------- | :------------------------------------------ | :---------------------------------------------------------------------------------------- |
| `apiKey`             | `GEMINI_API_KEY` from the environment.      | Sets the Gemini Developer API key.                                                        |
| `model`              | `models/gemini-3.8-live`                    | Names a model that supports live sessions.                                                |
| `voice`              | None.                                       | Sets one of the provider's voice names. Left out, the provider picks.                     |
| `startWithinSeconds` | `60`                                        | Sets how long a ticket may be used to start a session, in seconds.                        |
| `sessionSeconds`     | `900`                                       | Sets how long a session may last, in seconds. This is the provider's own limit for audio. |
| `httpBase`           | `https://generativelanguage.googleapis.com` | Sets the provider's HTTP root. Replace it for a test server or a proxy.                   |
| `wsBase`             | `wss://generativelanguage.googleapis.com`   | Sets the provider's WebSocket root. Replace it for a test server or a proxy.              |
| `fetch`              | The global `fetch`.                         | Replaces `fetch`, for a test.                                                             |

The token locks in the model, the system prompt, and the tools. The browser sends only the model name after it connects.

> **The API key never leaves the server.** The browser gets a one-use token.

## Voice: Azure Voice Live

The Azure Voice Live adapter runs a small relay because Azure has no one-use token a browser could connect with. A WebSocket to Voice Live is opened with the resource's key or a Microsoft Entra token, and either would let a browser use the whole resource.

```ts
import { azureVoiceLiveVoice } from "@bascik/genui/azure-voice-live";

const provider = azureVoiceLiveVoice({
  model: "gpt-realtime-2",
  voice: "en-US-AvaMultilingualNeural",
  relay: { port: 0, host: "127.0.0.1" },
});
```

| Option               | Default                                           | What it does                                                                                                                               |
| :------------------- | :------------------------------------------------ | :----------------------------------------------------------------------------------------------------------------------------------------- |
| `endpoint`           | `AZURE_VOICE_LIVE_ENDPOINT` from the environment. | Sets the resource, as `https://<name>.services.ai.azure.com`.                                                                              |
| `apiKey`             | `AZURE_VOICE_LIVE_API_KEY` from the environment.  | Sets the resource's key.                                                                                                                   |
| `token`              | `AZURE_VOICE_LIVE_TOKEN` from the environment.    | Sets a Microsoft Entra token for `https://ai.azure.com/.default`, or a function that returns a fresh one. It is used when there is no key. |
| `model`              | `gpt-realtime-2`                                  | Names a model Voice Live offers in the resource's region.                                                                                  |
| `voice`              | `en-US-AvaMultilingualNeural`                     | Sets the voice name. An Azure voice sends the time of each word, which captions follow exactly. An OpenAI voice does not.                  |
| `apiVersion`         | `2026-04-10`                                      | Sets the API version.                                                                                                                      |
| `relay.port`         | `0`                                               | Sets the port the relay listens on. Port 0 takes any free port.                                                                            |
| `relay.host`         | `127.0.0.1`                                       | Sets the interface the relay listens on.                                                                                                   |
| `relay.publicUrl`    | `ws://<host>:<port>`                              | Sets the address a browser reaches the relay at, for example `wss://example.com/voice`, when it is behind a proxy.                         |
| `startWithinSeconds` | `60`                                              | Sets how long a ticket may be used to start a session, in seconds.                                                                         |
| `sessionSeconds`     | `900`                                             | Sets how long a session may last, in seconds.                                                                                              |
| `wsBase`             | None.                                             | Sets the provider's WebSocket root. Replace it for a test server.                                                                          |

The browser connects to the relay with a one-use ticket. The relay connects to Azure with the credential, sends the session's setup itself, and passes on only the messages a call needs. It allows microphone audio, a typed message, a tool's result, and asking for or stopping a reply. It refuses anything else, including a new session setup.

The cost is that the audio passes through this server, which Gemini Live avoids. The relay needs Node, because it listens on a port, so it does not run on an edge runtime. `provider.close()` stops the relay and ends every call on it.

> **The browser never sees a credential.** The relay holds the key or token.

## Writing your own

A typed chat model is a function that reads a request and yields text slices and tool calls. It never runs a tool itself.

```ts
import type { Model, ModelEvent, ModelRequest } from "@bascik/genui";

export function myModel(): Model {
  return async function* ({
    system,
    messages,
    tools = [],
    signal,
  }: ModelRequest): AsyncIterable<ModelEvent> {
    yield "Hello";
  };
}
```

A tool call is an event with `type: "tool-call"`, an optional `id`, a `name`, and `input`. A model that needs no tools can simply yield text.

A voice provider turns a session's config into a ticket. The ticket holds no API key.

```ts
import type {
  VoiceProvider,
  VoiceSessionConfig,
  VoiceTicket,
} from "@bascik/genui/voice";

export function myVoiceProvider(): VoiceProvider {
  return {
    protocol: "my-voice",
    async createSession(config: VoiceSessionConfig): Promise<VoiceTicket> {
      return {
        protocol: "my-voice",
        url: "wss://example.com/voice",
        setup: null,
      };
    },
  };
}
```

The config has `system` and `tools`. The ticket has `protocol`, `url`, `setup`, and an optional `label`.

> **A voice provider has a browser side too.** The `voice-call` component speaks the wire protocol the ticket names, and it knows two: `gemini-live` and `azure-voice-live`. A provider with a protocol of its own also needs that protocol added to the component, which `bascik add` copies into your project for you to edit.
