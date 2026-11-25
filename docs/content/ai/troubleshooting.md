# Troubleshooting

This page lists errors and messages that `@bascik/ai` may show or log, grouped by the area of the app they affect.

## Setup and configuration

### No Azure Voice Live key or token is set.

Where: `ai/src/azure-voice-live.ts`
What it means: The Azure Voice Live provider cannot start because neither an API key nor a token was provided in the options or environment.
What to do: Set `AZURE_VOICE_LIVE_TOKEN` or pass a token source in the provider options.

### No Azure Voice Live endpoint is set.

Where: `ai/src/azure-voice-live.ts`
What it means: The provider cannot build a connection URL because no WebSocket base or endpoint was configured.
What to do: Set the `wsBase` option or provide an HTTP endpoint that can be converted to a WebSocket URL.

### No Gemini API key is set.

Where: `ai/src/gemini-live.ts`
What it means: The Gemini Live provider cannot start because no API key was found in the options or environment.
What to do: Set `GEMINI_API_KEY` or pass an `apiKey` in the provider options.

### "name" is not an element a renderer can pass through.

Where: `ai/src/render.ts`
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

Where: `ai/src/azure-voice-live.ts`
What it means: The WebSocket connection to Azure Voice Live was refused before it could be established. This often happens when credentials are invalid or expired.
What to do: Check that the Azure Voice Live key or token is valid and not expired.

### The voice provider hung up.

Where: `ai/src/azure-voice-live.ts`
What it means: The WebSocket connection to Azure Voice Live was closed by the provider after it was established.
What to do: This may be a temporary provider issue. Try the call again.

### The voice provider did not answer.

Where: `ai/src/app.ts`
What it means: The server could not create a voice session with the configured provider. The underlying error is logged via `onError`.
What to do: Check the server logs for the specific error. Ensure the voice provider is configured and reachable.

### This server has no voice provider.

Where: `ai/src/app.ts`
What it means: A voice call was requested, but the server was not configured with a voice provider.
What to do: Configure a voice provider in the app options.

### Something went wrong while writing this reply.

Where: `ai/src/app.ts`
What it means: The model failed while generating a reply. The specific error is logged via `onError`.
What to do: Check the server logs for the underlying error. This may be a transient model failure.

## Sending messages and forms

### Not a form.

Where: `ai/src/app.ts`
What it means: A request expected a form body but did not receive one.
What to do: Ensure the request sends a valid form with the correct content type.

### Not a tool call.

Where: `ai/src/app.ts`
What it means: A request expected a tool call payload but the data was missing, too large, or had an invalid decision value.
What to do: Ensure the request includes a valid tool call ID and input within size limits.

### Not a voice turn.

Where: `ai/src/app.ts`
What it means: A voice turn request was missing required fields such as the reader ID or model name.
What to do: Ensure the request includes all required fields for a voice turn.

### No tool call is waiting for that answer.

Where: `ai/src/app.ts`
What it means: An approval request was sent for a tool call that is not in the `approval-requested` state, or the call ID does not match any pending call.
What to do: Ensure the approval is sent for a tool call that is currently waiting for approval.

### No tool call is waiting for that result.

Where: `ai/src/app.ts`
What it means: A tool result was submitted for a call that is not in the `client-requested` state, or the call ID does not match.
What to do: Ensure the result is submitted for a client tool call that is currently waiting for a result.

### No memory to forget.

Where: `ai/src/app.ts`
What it means: A request to forget a memory was missing the memory ID or the memory store was not configured.
What to do: Ensure the request includes a valid memory ID and that memory storage is enabled.

### No such file.

Where: `ai/src/app.ts`
What it means: A requested file ID was not found in the file store for the current reader.
What to do: Ensure the file ID is correct and that the file belongs to the current reader.

### The files could not be saved. Nothing was sent; try again.

Where: `ai/src/app.ts`
What it means: An error occurred while storing attached files. The message and files were not sent.
What to do: Try sending the message again. Check server logs for storage errors.

### Not sent

Where: `ai/src/files.ts`
What it means: The server refused an upload and returned a page with the reason. The reader's typed text is preserved on the page.
What to do: Read the reason shown on the page. Adjust the file or message and try again.

### refused

Where: `ai/components/chat/chat-enhance.html`
What it means: The client detected that the server refused an attachment. The reason is shown in the composer notice.
What to do: Read the notice in the chat composer for the specific reason.

### not a page

Where: `ai/components/chat/chat-enhance.html`
What it means: The server response to a message send was not a valid HTML page or had no body.
What to do: This is a client-side error. Check the server logs for the underlying issue.

### no thread in the answer

Where: `ai/components/chat/chat-enhance.html`
What it means: The HTML response from the server did not contain a chat thread element.
What to do: This is a client-side error. Check the server logs for the underlying issue.

### no thread

Where: `ai/components/chat/chat-enhance.html`
What it means: The client could not find the chat thread element in the DOM before sending.
What to do: This is a client-side error. Ensure the chat component is correctly mounted.

## Tools and approval

### There is no tool named <name>.

Where: `ai/src/turn.ts`, `ai/src/voice.ts`
What it means: The model requested a tool call for a tool name that is not in the list of available tools.
What to do: Ensure the tool is defined and passed to the model. The model may have hallucinated a tool name.

### Error: the tool could not be run.

Where: `ai/components/chat/voice-call.html`
What it means: A tool call in a voice session failed to execute in the browser.
What to do: Check the browser console for the underlying error.

### Error: there is no form on the screen to fill in.

Where: `ai/components/chat/voice-call.html`
What it means: The voice assistant tried to fill a form, but no form element was found on the page.
What to do: Ensure a form is present and visible when the assistant attempts to fill it.

### Error: no button or option says "<press>". <contents>

Where: `ai/components/chat/voice-call.html`
What it means: The voice assistant tried to click a button or select an option, but no matching element was found in the form. The message includes the form's contents.
What to do: Ensure the form contains the expected buttons or options. The assistant may have misheard the reader.

### Error: the form could not be sent.

Where: `ai/components/chat/voice-call.html`
What it means: The voice assistant tried to submit a form, but the submission failed.
What to do: Check the browser console for the underlying error.

### Error: a form is filled in by the reader's browser.

Where: `ai/src/voice.ts`
What it means: The server attempted to handle a form fill tool call, but this tool must be executed by the client.
What to do: Ensure the client is handling `fill_form` tool calls.

### Error: markup is required.

Where: `ai/src/voice.ts`
What it means: A voice tool call for generative UI was missing the required markup string.
What to do: Ensure the model provides valid markup for the UI component.

### Error: nothing is waiting.

Where: `ai/src/voice.ts`
What it means: A voice approval request was sent, but no tool call is currently waiting for approval.
What to do: Ensure the approval is sent for a tool call that is actually pending.

### Error: already called.

Where: `ai/src/voice.ts`
What it means: A voice tool call was attempted for a tool that has already been called in this turn.
What to do: Ensure each tool call is unique and not repeated.

### Error: <error>

Where: `ai/src/voice.ts`
What it means: A tool execution failed during a voice turn. The error message is from the tool's execution.
What to do: Check the server logs for the specific tool error.

## Attachments

### That reader id cannot be stored.

Where: `ai/src/files.ts`, `ai/src/memory.ts`, `ai/src/store.ts`
What it means: The reader ID provided is not in a safe format for storage keys.
What to do: Ensure the reader ID is a valid, safe key generated by the library.

### That file id cannot be stored.

Where: `ai/src/files.ts`
What it means: The file ID provided is not in a safe format for storage keys.
What to do: Ensure the file ID is a valid, safe key generated by the library.

### That conversation id cannot be stored.

Where: `ai/src/store.ts`
What it means: The conversation ID provided is not in a safe format for storage keys.
What to do: Ensure the conversation ID is a valid, safe key generated by the library.

### That memory id cannot be stored.

Where: `ai/src/memory.ts`
What it means: The memory ID provided is not in a safe format for storage keys.
What to do: Ensure the memory ID is a valid, safe key generated by the library.

### refusals.empty(name)

Where: `ai/src/files.ts`
What it means: An uploaded file was empty (zero bytes). The message includes the file name.
What to do: Upload a file with content.

### refusals.markup(name)

Where: `ai/src/files.ts`
What it means: An uploaded file contains markup (HTML, etc.) which is not allowed. The message includes the file name.
What to do: Upload a plain text or binary file that is not markup.

### "<name>" does not look like the <type> file it says it is, so it was not attached.

Where: `ai/src/files.ts`
What it means: The file's content does not match its claimed type or extension. The message includes the file name and the claimed type.
What to do: Upload a file that matches its extension or type.

### These files are too large together (<size>). One message can carry up to <max>.

Where: `ai/src/app.ts`
What it means: The total size of uploaded files exceeds the configured limit. The message includes the declared size and the maximum allowed.
What to do: Reduce the total size of the files being uploaded.

## Memory and search

### Give a query of at least <MIN_QUERY> characters.

Where: `ai/src/history.ts`
What it means: A history search query was too short.
What to do: Enter a longer search query.

### There is nothing to remember: the text is empty.

Where: `ai/src/memory.ts`
What it means: A request to save a memory was made with empty or whitespace-only text.
What to do: Provide non-empty text for the memory.

### That is <length> characters; a memory is at most <MAX_MEMORY_LENGTH>. Say it in one short sentence.

Where: `ai/src/memory.ts`
What it means: The text for a new memory exceeds the maximum allowed length.
What to do: Shorten the memory text to fit within the limit.

### The reader already has <MAX_MEMORIES> memories, the most there can be. Forget one that is out of date first.

Where: `ai/src/memory.ts`
What it means: The reader has reached the maximum number of stored memories.
What to do: Forget an existing memory before adding a new one.

### There is no saved memory with that id.

Where: `ai/src/memory.ts`
What it means: A request to forget a memory used an ID that does not exist.
What to do: Ensure the memory ID is correct.

## Voice calls

### The voice call's state is busy.

Where: `ai/src/app.ts`
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

Where: `ai/src/azure-voice-live.ts`
What it means: The server failed to read or write the voice ticket in the shared store.
What to do: Check the shared store configuration and connectivity.

### [azure-voice-live] <detail>

Where: `ai/src/azure-voice-live.ts`
What it means: A WebSocket error occurred with Azure Voice Live. The detail is logged for debugging.
What to do: Check the server logs for the specific error detail.

## Running on several servers

### other servers cannot follow this reply

Where: `ai/src/app.ts`
What it means: The server failed to notify other servers that a reply is being written.
What to do: Check the shared store configuration and connectivity.

### the shared store did not answer

Where: `ai/src/app.ts`
What it means: The server could not read from or write to the shared store.
What to do: Check the shared store configuration and connectivity.

### the reply could not be stored

Where: `ai/src/app.ts`
What it means: The server failed to save a completed reply to the conversation store.
What to do: Check the conversation store configuration and connectivity.

### Stop did not reach the server writing this reply

Where: `ai/src/app.ts`
What it means: The server failed to signal a stop request to the server currently writing a reply.
What to do: Check the shared store configuration and connectivity.

### this reply could not be followed

Where: `ai/src/app.ts`
What it means: The server failed to relay a reply from another server.
What to do: Check the shared store configuration and connectivity.

### no reply could be started

Where: `ai/src/app.ts`
What it means: The server failed to acquire a lease to start a new reply.
What to do: Check the shared store configuration and connectivity.

### Stop did not reach the shared store

Where: `ai/src/app.ts`
What it means: The server failed to write a stop signal to the shared store.
What to do: Check the shared store configuration and connectivity.
