/**
 * A `VoiceProvider` for Azure Voice Live (Microsoft Foundry).
 *
 * Azure has no one-use token a browser could connect with: a WebSocket to
 * Voice Live is opened with the resource's key or a Microsoft Entra token,
 * and either would let a browser use the whole resource. So this provider
 * runs a small relay. The browser connects to the relay with a one-use
 * ticket; the relay connects to Azure with the credential, sends the
 * session's setup itself (instructions, tools, voice), and passes on only
 * the messages a call needs. The browser cannot change what the session may
 * do, and never sees a credential.
 *
 * The cost is that the audio passes through this server, which Gemini Live
 * avoids. The relay needs Node (it listens on a port), so it does not run on
 * an edge runtime.
 *
 * With several servers, the audio connection is one process's: it stays on
 * the server the browser reached. Only the ticket has to be known to all of
 * them, so give the provider a `shared` store (`@bascik/ai/shared`) and
 * start the relay on every server (`listen()`).
 *
 * The parts live in `azure-voice-live/`: `provider.ts` is the provider and
 * its relay, `protocol.ts` the session setup and the browser message filter,
 * and `types.ts` the options and provider types.
 */
export {
  azureVoiceLiveSession,
  relayedClientEvent,
} from "./azure-voice-live/protocol.ts";
export { azureVoiceLiveVoice } from "./azure-voice-live/provider.ts";
export type {
  AzureVoiceLiveOptions,
  AzureVoiceLiveProvider,
} from "./azure-voice-live/types.ts";
