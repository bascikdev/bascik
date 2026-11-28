# Troubleshooting

This page lists errors and messages that `@bascik/ai` may show or log, grouped by the area of the app they affect.

## Setup and configuration

### No Azure Voice Live key or token is set.

Where: `ai/src/azure-voice-live/provider.ts`
What it means: The Azure Voice Live provider cannot start because neither an API key nor a token was provided in the options or environment.
What to do: Set `AZURE_VOICE_LIVE_TOKEN` or pass a token source in the provider options.

### No Azure Voice Live endpoint is set.

Where: `ai/src/azure-voice-live/provider.ts`
What it means: The provider cannot build a connection URL because no WebSocket base or endpoint was configured.
What to do: Set the `wsBase` option or provide an HTTP endpoint that can be converted to a WebSocket URL.

### pauseMs must be a number of milliseconds.

Where: `ai/src/voice/pause.ts`
What it means: `geminiLiveVoice` or `azureVoiceLiveVoice` was given a `pauseMs` that is not a finite number, such as the result of parsing an empty environment variable. The provider throws when it is made.
What to do: Pass a number of milliseconds, or leave `pauseMs` out for the default of 800. A number outside 200 to 3000 is not an error; it is brought into that range.

### No Gemini API key is set.

Where: `ai/src/gemini-live.ts`
What it means: The Gemini Live provider cannot start because no API key was found in the options or environment.
What to do: Set `GEMINI_API_KEY` or pass an `apiKey` in the provider options.

### "name" is not an element a renderer can pass through.

Where: `ai/src/render/renderer.ts`
What it means: A component or element name listed in the renderer options is not in the safe element allowlist.
What to do: Remove the name from the `elements` option or add it to the safe elements list if appropriate.

## Models and providers

### The model server answered <status> for "<model>"

Where: `ai/src/openai.ts`, `ai/src/openai-responses.ts`
What it means: The HTTP request to the model provider failed with a non-OK status code. The error message may include a short detail from the provider's response body.
What to do: Check the model name, API key, and provider status. The detail in the message may indicate a quota, authentication, or input error.

### The model server failed for "<model>": <reason>

Where: `ai/src/openai-responses.ts`
What it means: The model provider sent an error event or a failed response during streaming. The reason is taken from the event's error message.
What to do: Check the provider's status and the model's availability. The reason may indicate a temporary failure or an invalid request.

### The voice provider answered <status>: <message>

Where: `ai/src/gemini-live.ts`
What it means: The request to create a Gemini Live session failed with a non-OK status. The message is a short excerpt from the provider's error response.
What to do: Verify the API key and model name. The message may indicate a quota or configuration issue.

### The voice provider refused the connection. Its key or token may have expired.

Where: `ai/src/azure-voice-live/provider.ts`
What it means: The WebSocket connection to Azure Voice Live was refused before it could be established. This often happens when credentials are invalid or expired.
What to do: Check that the Azure Voice Live key or token is valid and not expired.

### The voice provider refused the call's settings.

Where: `ai/src/azure-voice-live/provider.ts`
What it means: Azure Voice Live answered the session's setup with an error, so the relay ended the call as it started. The usual cause is a `turnDetection` setting the model does not take. The server's log has this line followed by "It said:" and Azure's own message, which names the setting.
What to do: Read the log, then remove or change that setting. Which settings a model takes is the provider's to say: see [Providers](/ai/providers#voice-how-long-a-pause-ends-a-turn).

### The voice provider hung up.

Where: `ai/src/azure-voice-live/provider.ts`
What it means: The WebSocket connection to Azure Voice Live was closed by the provider after it was established.
What to do: This may be a temporary provider issue. Try the call again.

### The voice provider did not answer in time.

Where: `ai/src/gemini-live.ts`, `ai/src/azure-voice-live/provider.ts`
What it means: With Gemini Live, the request for a token was not answered within `timeoutMs` (15 seconds by default), and `createSession` throws this. With Azure Voice Live, the relay connected but Azure did not set the session up within `connectTimeoutMs` (15 seconds by default); the call ends with this line and it is logged.
What to do: Check the provider's status and the network path from the server. Raise the option only when the provider is known to be slow.

### The voice provider did not answer.

Where: `ai/src/app/voice-handlers.ts`
What it means: The server could not create a voice session with the configured provider. The underlying error is logged via `onError`.
What to do: Check the server logs for the specific error. Ensure the voice provider is configured and reachable.

### The voice call could not be started.

Where: `ai/src/app/voice-handlers.ts`
What it means: The voice session handler answered 502 because the shared store did not answer, or because the turn an earlier call left behind could not be stored. The underlying error is logged via `onError` as "the shared store did not answer" or "the last voice call's turn was not stored".
What to do: Check the server logs, then the shared store and the conversation store.

### This server has no voice provider.

Where: `ai/src/app/voice-state.ts`, `ai/src/app/voice-handlers.ts`
What it means: A voice call was requested, but the server was not configured with a voice provider.
What to do: Configure a voice provider in the app options.

### Something went wrong while writing this reply.

Where: `ai/src/app/write-turn.ts`
What it means: The model failed while generating a reply. The specific error is logged via `onError`.
What to do: Check the server logs for the underlying error. This may be a transient model failure.

## Sending messages and forms

### This request came from another site.

Where: `ai/src/app/forms.ts`
What it means: A handler answered 403 because the POST was sent by another site's page: its `Sec-Fetch-Site` header was `cross-site`, or it had no such header and its `Origin` was not this host. Every handler that reads a form checks this, and so do `stop` and `voiceSession`.
What to do: Post from a page on the same site. Behind a proxy that changes `Host`, have it send `X-Forwarded-Host` with the host the browser used.

### Not a form.

Where: `ai/src/app/handlers.ts`
What it means: A request expected a form body but did not receive one.
What to do: Ensure the request sends a valid form with the correct content type.

### Not a tool call.

Where: `ai/src/app/voice-handlers.ts`
What it means: A request expected a tool call payload but the data was missing, too large, or had an invalid decision value.
What to do: Ensure the request includes a valid tool call ID and input within size limits.

### Not a voice turn.

Where: `ai/src/app/voice-handlers.ts`
What it means: A voice turn request was missing required fields such as the reader ID or model name.
What to do: Ensure the request includes all required fields for a voice turn.

### No tool call is waiting for that answer.

Where: `ai/src/app/handlers.ts`
What it means: An approval request was sent for a tool call that is not in the `approval-requested` state, or the call ID does not match any pending call.
What to do: Ensure the approval is sent for a tool call that is currently waiting for approval.

### No tool call is waiting for that result.

Where: `ai/src/app/handlers.ts`
What it means: A tool result was submitted for a call that is not in the `client-requested` state, or the call ID does not match.
What to do: Ensure the result is submitted for a client tool call that is currently waiting for a result.

### No memory to forget.

Where: `ai/src/app/handlers.ts`
What it means: A request to forget a memory was missing the memory ID or the memory store was not configured.
What to do: Ensure the request includes a valid memory ID and that memory storage is enabled.

### No such file.

Where: `ai/src/app/handlers.ts`
What it means: A requested file ID was not found in the file store for the current reader.
What to do: Ensure the file ID is correct and that the file belongs to the current reader.

### The files could not be saved. Nothing was sent; try again.

Where: `ai/src/app/uploads.ts`
What it means: An error occurred while storing attached files. The message and files were not sent.
What to do: Try sending the message again. Check server logs for storage errors.

### Not sent

Where: `ai/src/files/responses.ts`
What it means: The server refused an upload and returned a page with the reason. The reader's typed text is preserved on the page.
What to do: Read the reason shown on the page. Adjust the file or message and try again.

### refused

Where: `ai/components/chat/chat-enhance.html`
What it means: The client runtime saw the server refuse an attachment. The reason is written on `chat-attach`'s notice line, above the message box, and the composer keeps the text and the files. In a chat with no notice (a composer without `chat-attach`), the form is sent again the ordinary way and the server's page gives the reason.
What to do: Read the notice for the specific reason.

### not a page

Where: `ai/components/chat/chat-enhance.html`
What it means: The server response to a message send was not a valid HTML page or had no body.
What to do: This is a client-side error. Check the server logs for the underlying issue.

### no thread in the answer

Where: `ai/components/chat/chat-enhance.html`
What it means: The page the server answered with held no element marked `data-chat-part="thread"`. The form's route redirected to a page that is not the chat.
What to do: If the form is meant to load another page, mark it `data-genui="native"`. Otherwise check the `page` option of `createChat`, which is where the handlers send the reader back, and the server's log.

### no thread

Where: `ai/components/chat/chat-enhance.html`
What it means: The client runtime found no thread for the form that was sent: its `data-chat` element holds no element marked `data-chat-part="thread"`. The form is then sent the ordinary way.
What to do: Put the form and `chat-thread` inside the same `data-chat` element.

## Chat parts

### @bascik/ai: the chat parts read this project's chat from src/lib/chat.ts, and it could not be loaded: <reason>

Where: `ai/src/app/page-parts.ts`, in the server's log
What it means: A data part (`chat-turns`, `chat-conversations`, `chat-find`, `chat-models` or `chat-memories`, and so `chat-app`) imported `@/lib/chat.ts` and the import failed. The file is missing, or it threw while loading; the reason follows the colon. The log goes on: "Create src/lib/chat.ts with a default export that holds your chat", with an example.
What to do: Create `src/lib/chat.ts` whose default export is `{ chat }` with the chat `createChat` made, as in the [Quick Start](/ai/quick-start#the-project-module). If your chat lives in another file, change the `import("@/lib/chat.ts")` line in your copy of each data part.

### @bascik/ai: the default export of src/lib/chat.ts is not a chat project

Where: `ai/src/app/page-parts.ts`, in the server's log
What it means: The module loaded, and its default export is not an object with a `chat` made by `createChat`, nor a function of the request that returns one. The usual causes are a default export that is the chat itself, `export default chat`, and a function that returns something else. A module with only a named `chat` export is not one of them: it loads, with every default.
What to do: Make the default export an object that holds the chat, `export default { chat };`. A named `chat` export can stay beside it for your route files.

### This chat is not set up yet. The server's log says what is missing.

Where: `ai/src/app/page-parts.ts`, shown in the thread (`data-testid="chat-setup-failed"`)
What it means: `chat-turns` could not load the project module, so the thread shows this line in place of the conversation. It is for the developer: no reader of a working project sees it. A page that also holds a data part in the sidebar may answer 500 instead, because that part's server script failed first.
What to do: Read the server's log for one of the two messages above.

### A part rendered nothing

Where: a page that uses a data part
What it means: Some data parts print nothing on purpose. `chat-models` prints nothing until the project module lists `models`. `conversation-list` is hidden beside search results. `chat-conversations` leaves out a conversation with no message yet, so a new project shows an empty list. `chat-voice` and `voice-call` show nothing with scripts off.
What to do: Check the part's condition in [Components](/ai/components#data-parts). If the whole page is empty or shows "This chat is not set up yet", see the entries above.

### A part placed in a named slot does not show there

Where: a page that fills a slot of `chat-app`, `chat-composer`, `chat-sidebar` or another part
What it means: The slot name was written on the component's own tag, as in `<chat-attach data-bascik-slot="start" />` or `<chat-sidebar data-bascik-slot="sidebar">`. On this version of Bascik that does not fill the slot, and nothing is reported: the part lands in the default slot or is dropped, and the slot keeps its default content.
What to do: Wrap the part in an element that carries the name: `<span data-bascik-slot="start"><chat-attach /></span>`, or `<template data-bascik-slot="sidebar">…</template>`.

### A form in the chat that should load a page is fetched instead

Where: a form of your own inside the `data-chat` element, with `chat-enhance` on the page
What it means: The client runtime takes every `method="post"` form inside the `data-chat` element. It sent the form with `fetch` and read the answer as a reply. When the answer is the chat page, its thread is put into the open page and the address does not change. When the answer has no thread, the runtime gives up and sends the form again the ordinary way, so the route is posted to twice. With `chat-app` the sidebar is inside the `data-chat` element, so this applies to forms there too.
What to do: Add `data-genui="native"` to the form. See [Which forms it takes](/ai/client-runtime#which-forms-it-takes).

### The Stop button does not show

Where: `chat-composer`
What it means: Stop takes Send's place while the composer's `data-chat` element has `data-genui="streaming"`, which the client runtime writes. Three things keep that from happening. The page has no `chat-enhance`: a reply then streams as a page load, and the browser's own stop button ends it. The composer is outside the `data-chat` element while the page has one, so the state is written where the composer's rule does not look. Or the composer is your own markup, which has no Stop rule.
What to do: Put `chat-enhance`, the composer and the thread inside one `data-chat` element. In a composer of your own, mark the button `data-chat-part="stop"` so the runtime takes its click, give it a `formaction` for the stop route, and show it with a rule on `[data-chat][data-genui="streaming"]`.

### A part's styles do not apply to its content

Where: a component of your own that styles slotted or streamed content
What it means: Bascik renames the classes a component's stylesheet declares, in that component's own markup only. Content that a page slots in, that a stream or server script prints, or that another part's script builds in the browser keeps its class names as written, so a rule such as `.thread .reply` no longer matches it.
What to do: Start the rule at the component's own class and select the content by attribute, or by element inside `:is()`: `.thread [data-reply]`. See [Style a part of your own](/ai/chat-parts#style-a-part-of-your-own).

### Attribute binding conflict … prop wins

Where: the build output, once for each use of the part; or the dev server's log on a page request, marked "in server-script output"
What it means: A prop replaced a default attribute that the part's template carries, such as a `route` prop over `action="/api/send"`. That is how the route, placeholder and label props work, so the line is expected and the prop's value is used. The dev server's line comes from a value in the project module (`words.searchPlaceholder`, `words.conversations`, `words.searchClear` or a `routes` entry) replacing a default in what a data part prints.
What to do: Nothing. The parts whose props print it are listed under [Routes are props](/ai/chat-parts#routes-are-props).

### A build fails on an import of chat-root/parts.ts

Where: a project that added one chat part with `bascik add @bascik/ai/<part>`
What it means: `chat-enhance`, `chat-attach`, `chat-voice` and `voice-call` import a module they share, `chat/chat-root/parts.ts`. On this version of Bascik, adding a single part may copy the part and its own folder and leave that shared module out.
What to do: Run `npx bascik add @bascik/ai` to copy the whole package, and delete the parts you do not use. If the build names esbuild instead, install it: `npm install --save-dev esbuild`.

### The sidebar's search results are hidden on a phone

Where: a `chat-sidebar` written in a page or a template, holding `chat-find`
What it means: At 720px and under the sidebar loads closed, and a search is a page load, so the results are behind the Menu control.
What to do: Add `data-show-found="true"` to the `chat-sidebar` tag. A sidebar printed by a script can set `data-bascik-prop-open="open"` on a search page in its place. See [Narrow screens](/ai/chat-parts#narrow-screens).

## Tools and approval

### There is no tool named <name>.

Where: `ai/src/turn.ts`, `ai/src/voice/tool-calls.ts`
What it means: The model requested a tool call for a tool name that is not in the list of available tools.
What to do: Ensure the tool is defined and passed to the model. The model may have hallucinated a tool name.

### Error: the tool could not be run.

Where: `ai/components/chat/voice-call/tools.ts`
What it means: A tool call in a voice session failed to execute in the browser.
What to do: Check the browser console for the underlying error.

### Error: there is no form on the screen to fill in.

Where: `ai/components/chat/voice-call/forms.ts`
What it means: The voice assistant tried to fill a form, but no form element was found on the page.
What to do: Ensure a form is present and visible when the assistant attempts to fill it.

### Error: no button or option says "<press>". <contents>

Where: `ai/components/chat/voice-call/forms.ts`
What it means: The voice assistant tried to click a button or select an option, but no matching element was found in the form. The message includes the form's contents.
What to do: Ensure the form contains the expected buttons or options. The assistant may have misheard the reader.

### Error: the form could not be sent.

Where: `ai/components/chat/voice-call/forms.ts`
What it means: The voice assistant tried to submit a form, but the submission failed.
What to do: Check the browser console for the underlying error.

### Error: a form is filled in by the reader's browser.

Where: `ai/src/voice/tool-calls.ts`
What it means: The server attempted to handle a form fill tool call, but this tool must be executed by the client.
What to do: Ensure the client is handling `fill_form` tool calls.

### Error: markup is required.

Where: `ai/src/voice/tool-calls.ts`
What it means: A voice tool call for generative UI was missing the required markup string.
What to do: Ensure the model provides valid markup for the UI component.

### Error: nothing is waiting.

Where: `ai/src/voice/tool-calls.ts`
What it means: A voice approval request was sent, but no tool call is currently waiting for approval.
What to do: Ensure the approval is sent for a tool call that is actually pending.

### Error: already called.

Where: `ai/src/voice/tool-calls.ts`
What it means: A voice tool call arrived with an id that was already used in this call, in this turn or in one of the turns stored before it. The first call stands and the second is not run.
What to do: Ensure each tool call has an id of its own. A provider that sends a call again after a reconnect gets this answer by design.

### Error: The tool took too long to answer.

Where: `ai/src/voice/tool-calls.ts`
What it means: A voice tool did not answer within `VOICE_TOOL_TIMEOUT_MS` (60 seconds). It is recorded as failed, the `signal` it was given is aborted, and the model is told.
What to do: Make the tool faster, have it stop on its `signal`, or pass `{ timeoutMs }` as the last argument of `runVoiceTool` or `finishVoiceTool`.

### (The result was too long. This is the start of it.)

Where: `ai/src/voice/tool-calls.ts`
What it means: A voice tool's result was longer than `MAX_VOICE_TOOL_OUTPUT` (100,000 characters). The model is told the start of it, ending with this line.
What to do: Return a shorter result, such as a summary or the first matches.

### Error: <error>

Where: `ai/src/voice/tool-calls.ts`
What it means: A tool execution failed during a voice turn. The error message is from the tool's execution.
What to do: Check the server logs for the specific tool error.

## Attachments

### That reader id cannot be stored.

Where: `ai/src/store/conversation.ts`, `ai/src/files/stores.ts`, `ai/src/memory/stores.ts`
What it means: The reader ID provided is not in a safe format for storage keys.
What to do: Ensure the reader ID is a valid, safe key generated by the library.

### That file id cannot be stored.

Where: `ai/src/files/stores.ts`
What it means: The file ID provided is not in a safe format for storage keys.
What to do: Ensure the file ID is a valid, safe key generated by the library.

### That conversation id cannot be stored.

Where: `ai/src/store/conversation.ts`
What it means: The conversation ID provided is not in a safe format for storage keys.
What to do: Ensure the conversation ID is a valid, safe key generated by the library.

### That memory id cannot be stored.

Where: `ai/src/memory/stores.ts`
What it means: The memory ID provided is not in a safe format for storage keys.
What to do: Ensure the memory ID is a valid, safe key generated by the library.

### refusals.empty(name)

Where: `ai/src/files/uploads.ts`
What it means: An uploaded file was empty (zero bytes). The message includes the file name.
What to do: Upload a file with content.

### refusals.markup(name)

Where: `ai/src/files/uploads.ts`
What it means: An uploaded file contains markup (HTML, etc.) which is not allowed. The message includes the file name.
What to do: Upload a plain text or binary file that is not markup.

### "<name>" does not look like the <type> file it says it is, so it was not attached.

Where: `ai/src/files/uploads.ts`
What it means: The file's content does not match its claimed type or extension. The message includes the file name and the claimed type.
What to do: Upload a file that matches its extension or type.

### These files are too large together (<size>). One message can carry up to <max>.

Where: `ai/src/files/uploads.ts`
What it means: The total size of uploaded files exceeds the configured limit. The message includes the declared size and the maximum allowed.
What to do: Reduce the total size of the files being uploaded.

## Memory and search

### Give a query of at least <MIN_QUERY> characters.

Where: `ai/src/history.ts`
What it means: A history search query was too short.
What to do: Enter a longer search query.

### There is nothing to remember: the text is empty.

Where: `ai/src/memory/changes.ts`
What it means: A request to save a memory was made with empty or whitespace-only text.
What to do: Provide non-empty text for the memory.

### That is <length> characters; a memory is at most <MAX_MEMORY_LENGTH>. Say it in one short sentence.

Where: `ai/src/memory/changes.ts`
What it means: The text for a new memory exceeds the maximum allowed length.
What to do: Shorten the memory text to fit within the limit.

### The reader already has <MAX_MEMORIES> memories, the most there can be. Forget one that is out of date first.

Where: `ai/src/memory/changes.ts`
What it means: The reader has reached the maximum number of stored memories.
What to do: Forget an existing memory before adding a new one.

### There is no saved memory with that id.

Where: `ai/src/memory/tools.ts`
What it means: A request to forget a memory used an ID that does not exist.
What to do: Ensure the memory ID is correct.

## Voice calls

### No microphone: type to talk.

Where: `ai/components/chat/voice-call.html`
What it means: The reader declined the microphone, the browser could not start capturing, or the microphone went away during the call (unplugged, or permission taken back). The call is still on.
What to do: Type in the composer to talk to the model. To speak, allow the microphone for the site and start a new call.

### Muted. The model cannot hear you.

Where: `ai/components/chat/voice-call.html`
What it means: The reader pressed the mute button. The microphone is switched off and no audio is sent; the call is still on, and the model's voice still plays.
What to do: Press the button again to speak, or type in the composer.

### Still there? The call is about to end.

Where: `ai/components/chat/voice-call.html`
What it means: Nothing has happened on the call for `idle-seconds` (120 by default). The call ends after `idle-warning-seconds` more (30 by default).
What to do: Press "Stay on the call", speak, or type. To change the times, set the two props on `voice-call`; `idle-seconds` of 0 never asks.

### The call ended because nobody spoke.

Where: `ai/components/chat/voice-call.html`, `ai/src/azure-voice-live/provider.ts`
What it means: The call was ended because it was not in use. The component ends it when its question, "Still there?", goes unanswered. The Azure relay ends it when nobody has spoken for `callIdleSeconds` (300 by default), whatever the page does. Sound in the microphone does not count as speaking.
What to do: Start a new call. If calls end while readers are still on them, raise `idle-seconds` on the component or `callIdleSeconds` on the provider: see [A call nobody is speaking on](/ai/voice#a-call-nobody-is-speaking-on).

### The model answers before I finish speaking

Where: `ai/src/voice/pause.ts`
What it means: The provider took a pause for the end of the reader's turn. A reply the reader speaks over before they heard it is taken back, and their words stay one turn, but the model has still been interrupted.
What to do: Raise `pauseMs` on the voice provider (800 by default, up to 3000). With Azure Voice Live, also try end-of-utterance detection through `turnDetection`, which judges by what was said and not by silence alone. See [Providers](/ai/providers#voice-how-long-a-pause-ends-a-turn).

### The voice service did not answer.

Where: `ai/components/chat/voice-call.html`
What it means: The call connected but was not on 20 seconds later, so the component ended it.
What to do: Try the call again. If it repeats, check the provider's status and, with Azure Voice Live, the relay's log.

### The voice relay is full. Try again later.

Where: `ai/src/azure-voice-live/provider.ts`
What it means: The relay already had `relay.maxCalls` calls open (100 by default), so it closed this one as it connected, with WebSocket code 1008.
What to do: Try again later. Raise `relay.maxCalls` when the server and the Azure resource have room for more.

### Too many voice calls are open.

Where: `ai/src/azure-voice-live/provider.ts`
What it means: One reader already had `relay.maxCallsPerOwner` calls open on this relay (3 by default), so this one was closed as it connected, with WebSocket code 1008.
What to do: End a call in another tab or window. Raise `relay.maxCallsPerOwner` if readers need more.

### The voice call's state is busy.

Where: `ai/src/app/voice-state.ts`
What it means: The server could not acquire a lock for the voice call state after multiple attempts.
What to do: Try the voice call again. This may be a temporary contention issue.

### Unauthorized

Where: `ai/src/ws.ts`
What it means: A WebSocket upgrade request was refused with a 401 status, typically because a ticket was missing or invalid.
What to do: Ensure a valid voice ticket is provided in the WebSocket connection request.

### Bad Request

Where: `ai/src/ws.ts`
What it means: A WebSocket upgrade request was refused with a 400 status because it was not a valid handshake.
What to do: Ensure the request is a proper WebSocket upgrade request.

### [azure-voice-live] the ticket store failed: <error>

Where: `ai/src/azure-voice-live/provider.ts`
What it means: The server failed to read or write the voice ticket in the shared store.
What to do: Check the shared store configuration and connectivity.

### [azure-voice-live] <reason> It said: <provider's reason>

Where: `ai/src/azure-voice-live/provider.ts`
What it means: Azure's side of a call ended. The first part is the line the reader was shown; what follows "It said:" is Azure's own close reason, which is logged and never sent to the browser because it can name the resource.
What to do: Read the provider's reason. It usually names a quota, a model the region does not offer, or a credential problem.

### a voice tool's result was not recorded

Where: `ai/src/app/voice-handlers.ts`
What it means: A voice tool ran, but its result could not be written to the call's turn in the shared store. The model is still told the result; the view is not shown, and the stored message can record the call as failed. Logged via `onError`.
What to do: Check the shared store configuration and connectivity.

### Idle

Where: `ai/src/ws.ts`
What it means: The relay closed a call with WebSocket code 1001 because the browser sent nothing, not even the answer to a ping, for `relay.idleMs` (45 seconds by default).
What to do: Nothing, when the reader's device went away. Raise `relay.idleMs` if a proxy in front of the relay holds frames back.

### Invalid UTF-8

Where: `ai/src/ws.ts`
What it means: The relay closed a call with WebSocket code 1007 because a text message, or a close reason, was not valid UTF-8.
What to do: Send text frames as UTF-8. The `voice-call` component does.

### [azure-voice-live] <detail>

Where: `ai/src/azure-voice-live/provider.ts`
What it means: A WebSocket error occurred with Azure Voice Live. The detail is logged for debugging.
What to do: Check the server logs for the specific error detail.

## Running on several servers

### other servers cannot follow this reply

Where: `ai/src/app/write-turn.ts`
What it means: The server failed to notify other servers that a reply is being written.
What to do: Check the shared store configuration and connectivity.

### the shared store did not answer

Where: `ai/src/app/follow-turn.ts`, `ai/src/app/write-turn.ts`, `ai/src/app/voice-handlers.ts`
What it means: The server could not read from or write to the shared store.
What to do: Check the shared store configuration and connectivity.

### the reply could not be stored

Where: `ai/src/app/write-turn.ts`
What it means: The server failed to save a completed reply to the conversation store.
What to do: Check the conversation store configuration and connectivity.

### Stop did not reach the server writing this reply

Where: `ai/src/app/follow-turn.ts`
What it means: The server failed to signal a stop request to the server currently writing a reply.
What to do: Check the shared store configuration and connectivity.

### this reply could not be followed

Where: `ai/src/app/follow-turn.ts`
What it means: The server failed to relay a reply from another server.
What to do: Check the shared store configuration and connectivity.

### no reply could be started

Where: `ai/src/app/live-turns.ts`
What it means: The server failed to acquire a lease to start a new reply.
What to do: Check the shared store configuration and connectivity.

### Stop did not reach the shared store

Where: `ai/src/app/live-turns.ts`
What it means: The server failed to write a stop signal to the shared store.
What to do: Check the shared store configuration and connectivity.
