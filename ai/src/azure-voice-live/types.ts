/**
 * The options an Azure Voice Live provider takes (resource, credential,
 * model, voice, relay address, ticket store, time limits) and the provider
 * it returns, which also starts and stops its relay.
 */
import type { Shared } from "../shared.ts";
import type { VoiceProvider } from "../voice.ts";

export interface AzureVoiceLiveOptions {
  /** The resource, as `https://<name>.services.ai.azure.com`. Defaults to AZURE_VOICE_LIVE_ENDPOINT. */
  endpoint?: string;
  /** The resource's key. Defaults to AZURE_VOICE_LIVE_API_KEY. */
  apiKey?: string;
  /**
   * A Microsoft Entra token for `https://ai.azure.com/.default`, or a
   * function that returns a fresh one, used when there is no key. Defaults
   * to AZURE_VOICE_LIVE_TOKEN.
   */
  token?: string | (() => string | Promise<string>);
  /** A model Voice Live offers in the resource's region. */
  model?: string;
  /**
   * A voice name. An Azure voice (`en-US-AvaMultilingualNeural`) sends the
   * time of each word, which captions follow exactly; an OpenAI voice
   * (`marin`) does not.
   */
  voice?: string;
  apiVersion?: string;
  /** Where the relay listens. Port 0, the default, takes any free port. */
  relay?: {
    port?: number;
    /** The interface to listen on (default 127.0.0.1). */
    host?: string;
    /**
     * The address a browser reaches the relay at, for example
     * `wss://example.com/voice`, when it is behind a proxy. Left out, it is
     * `ws://<host>:<port>`.
     */
    publicUrl?: string;
    /** The most calls open on this relay at once (default 100). One past it is closed as it connects. */
    maxCalls?: number;
    /**
     * The most calls one owner (`VoiceSessionConfig.owner`, the reader in
     * the chat kit) has open on this relay at once (default 3).
     */
    maxCallsPerOwner?: number;
    /**
     * How long a browser may send nothing, not even the answer to a ping,
     * before its call ends, in milliseconds (default 45 000).
     */
    idleMs?: number;
    /**
     * How much may wait to be sent to a browser before its call ends, in
     * bytes (default 8 000 000): a browser that has stopped reading.
     */
    maxUnsentBytes?: number;
    /**
     * How long a browser has to hang up after its call is closed, or after
     * `close()`, before its socket is destroyed, in milliseconds (default 1000).
     */
    closeGraceMs?: number;
  };
  /**
   * Where one-use tickets are kept. Default: this process's memory, which is
   * right for one server. With several, pass the store they share, so a
   * ticket made on one server is honored once on another. A ticket holds the
   * session's instructions: keep the store private.
   */
  shared?: Pick<Shared, "set" | "take" | "delete">;
  /** How long a ticket may be used to start a session, in seconds (default 60). */
  startWithinSeconds?: number;
  /** How long a session may last, in seconds (default 900). */
  sessionSeconds?: number;
  /**
   * How long the provider has to set a session up once the relay connects
   * to it, in milliseconds (default 15 000). After that the reader is told
   * it did not answer.
   */
  connectTimeoutMs?: number;
  /** The provider's WebSocket root. Replace it for a test server. */
  wsBase?: string;
}

export interface AzureVoiceLiveProvider extends VoiceProvider {
  /**
   * Start the relay now, without making a ticket. With tickets in a shared
   * store, every server calls this when it starts: a ticket made on one
   * server may be used on another, which has to be listening already.
   */
  listen(): Promise<void>;
  /** Stop the relay and end every call on it. */
  close(): Promise<void>;
}
