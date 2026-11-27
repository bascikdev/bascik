# Providers

`@bascik/ai` talks to model providers through small adapters. A text adapter returns a `Model` function. A voice adapter returns a `VoiceProvider` that makes a browser ticket.

## Claude

The Claude adapter streams replies from the Claude API through the official SDK. It sends each round's text and tool calls, then yields the calls for the turn to run.

```ts
import { anthropicModel } from "@bascik/ai/anthropic";

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
import { openAiCompatibleModel } from "@bascik/ai/openai";

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
import { openAiResponsesModel } from "@bascik/ai/openai-responses";

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
import { geminiLiveVoice } from "@bascik/ai/gemini-live";

const provider = geminiLiveVoice({
  model: "models/gemini-3.8-live",
  startWithinSeconds: 60,
  sessionSeconds: 900,
});
```

| Option               | Default                                     | What it does                                                                                      |
| :------------------- | :------------------------------------------ | :------------------------------------------------------------------------------------------------ |
| `apiKey`             | `GEMINI_API_KEY` from the environment.      | Sets the Gemini Developer API key.                                                                |
| `model`              | `models/gemini-3.8-live`                    | Names a model that supports live sessions.                                                        |
| `voice`              | None.                                       | Sets one of the provider's voice names. Left out, the provider picks.                             |
| `startWithinSeconds` | `60`                                        | Sets how long a ticket may be used to start a session, in seconds.                                |
| `sessionSeconds`     | `900`                                       | Sets how long a session may last, in seconds. This is the provider's own limit for audio.         |
| `httpBase`           | `https://generativelanguage.googleapis.com` | Sets the provider's HTTP root. Replace it for a test server or a proxy.                           |
| `wsBase`             | `wss://generativelanguage.googleapis.com`   | Sets the provider's WebSocket root. Replace it for a test server or a proxy.                      |
| `fetch`              | The global `fetch`.                         | Replaces `fetch`, for a test.                                                                     |
| `timeoutMs`          | `15000`                                     | Sets how long the provider has to answer the request for a token, body included, in milliseconds. |

The token locks in the model, the system prompt, and the tools. The browser sends only the model name after it connects.

A provider that has not answered after `timeoutMs` makes `createSession` throw "The voice provider did not answer in time.", so the reader is not left waiting on a call that cannot start. At most 64,000 bytes of the provider's answer are read.

> **The API key never leaves the server.** The browser gets a one-use token.

## Voice: Azure Voice Live

The Azure Voice Live adapter runs a small relay because Azure has no one-use token a browser could connect with. A WebSocket to Voice Live is opened with the resource's key or a Microsoft Entra token, and either would let a browser use the whole resource.

```ts
import { azureVoiceLiveVoice } from "@bascik/ai/azure-voice-live";

const provider = azureVoiceLiveVoice({
  model: "gpt-realtime-2",
  voice: "en-US-AvaMultilingualNeural",
  relay: { port: 0, host: "127.0.0.1" },
});
```

| Option                   | Default                                           | What it does                                                                                                                                                           |
| :----------------------- | :------------------------------------------------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `endpoint`               | `AZURE_VOICE_LIVE_ENDPOINT` from the environment. | Sets the resource, as `https://<name>.services.ai.azure.com`.                                                                                                          |
| `apiKey`                 | `AZURE_VOICE_LIVE_API_KEY` from the environment.  | Sets the resource's key.                                                                                                                                               |
| `token`                  | `AZURE_VOICE_LIVE_TOKEN` from the environment.    | Sets a Microsoft Entra token for `https://ai.azure.com/.default`, or a function that returns a fresh one. It is used when there is no key.                             |
| `model`                  | `gpt-realtime-2`                                  | Names a model Voice Live offers in the resource's region.                                                                                                              |
| `voice`                  | `en-US-AvaMultilingualNeural`                     | Sets the voice name. An Azure voice sends the time of each word, which captions follow exactly. An OpenAI voice does not.                                              |
| `apiVersion`             | `2026-04-10`                                      | Sets the API version.                                                                                                                                                  |
| `relay.port`             | `0`                                               | Sets the port the relay listens on. Port 0 takes any free port.                                                                                                        |
| `relay.host`             | `127.0.0.1`                                       | Sets the interface the relay listens on.                                                                                                                               |
| `relay.publicUrl`        | `ws://<host>:<port>`                              | Sets the address a browser reaches the relay at, for example `wss://example.com/voice`, when it is behind a proxy.                                                     |
| `relay.maxCalls`         | `100`                                             | Sets the most calls open on this relay at once. One past it is closed as it connects.                                                                                  |
| `relay.maxCallsPerOwner` | `3`                                               | Sets the most calls one owner has open on this relay at once. The owner is the session config's `owner`, which the server kit sets to the reader.                      |
| `relay.idleMs`           | `45000`                                           | Sets how long a browser may send nothing, not even the answer to a ping, before its call ends, in milliseconds.                                                        |
| `relay.maxUnsentBytes`   | `8000000`                                         | Sets how much may wait to be sent to a browser before its call ends, in bytes. Past it, the browser has stopped reading.                                               |
| `relay.closeGraceMs`     | `1000`                                            | Sets how long a browser has to hang up after its call is closed, or after `close()`, before its socket is destroyed, in milliseconds.                                  |
| `startWithinSeconds`     | `60`                                              | Sets how long a ticket may be used to start a session, in seconds.                                                                                                     |
| `sessionSeconds`         | `900`                                             | Sets how long a session may last, in seconds.                                                                                                                          |
| `connectTimeoutMs`       | `15000`                                           | Sets how long Azure has to set a session up once the relay connects to it, in milliseconds. After that the call ends with "The voice provider did not answer in time." |
| `wsBase`                 | None.                                             | Sets the provider's WebSocket root. Replace it for a test server.                                                                                                      |

The browser connects to the relay with a one-use ticket. The relay connects to Azure with the credential, sends the session's setup itself, and passes on only the messages a call needs. It allows microphone audio, a typed message, a tool's result, and asking for or stopping a reply. It refuses anything else, including a new session setup.

Each call holds a connection to Azure, so the relay limits how many are open. A call past `relay.maxCalls`, or past `relay.maxCallsPerOwner` for one reader, is closed as it connects with WebSocket code 1008 and a reason the reader is shown: "The voice relay is full. Try again later." or "Too many voice calls are open." The relay pings each browser, and ends the call of one that has sent nothing for `relay.idleMs` or has stopped reading.

When Azure's side of a call ends, the reader is told one of three fixed lines: that the provider refused the connection, did not answer in time, or hung up. Azure's own close reason can name the resource, so it goes to the server's log only, after "It said:".

The cost is that the audio passes through this server, which Gemini Live avoids. The relay needs Node, because it listens on a port, so it does not run on an edge runtime. `provider.close()` stops the relay and ends every call on it.

> **The browser never sees a credential.** The relay holds the key or token.

## Writing your own

A typed chat model is a function that reads a request and yields text slices and tool calls. It never runs a tool itself.

```ts
import type { Model, ModelEvent, ModelRequest } from "@bascik/ai";

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
} from "@bascik/ai/voice";

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

The config has `system`, `tools`, and an optional `owner`: whose session it is, which the server kit sets to the reader. A provider with a relay can use it to limit how many calls one reader has open. The ticket has `protocol`, `url`, `setup`, and an optional `label`.

> **A voice provider has a browser side too.** The `voice-call` component speaks the wire protocol the ticket names, and it knows two: `gemini-live` and `azure-voice-live`. Each protocol is one module beside the component, `voice-call/gemini-live.ts` and `voice-call/azure-voice-live.ts`, which `bascik add` copies into your project for you to edit. A provider with a protocol of its own needs a module like them, chosen by the ticket's `protocol` in the component's script.
