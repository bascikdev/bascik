/*
 * The shapes voice-call's modules share: one call, one provider's protocol,
 * and what a protocol asks of the component. Types only, so importing this
 * adds nothing to the component's script.
 */

/** Everything one call holds, so ending it is letting go of this. */
export interface Call {
  socket: WebSocket;
  playback: AudioContext;
  /** Audio that is playing or queued, to stop it when the reader cuts in. */
  sources: Set<AudioBufferSourceNode>;
  /** When the next piece of audio starts, on the playback clock. */
  nextAt: number;
  microphone?: MediaStream;
  capture?: AudioContext;
  /** Calls that wait for the reader's answer, by id. */
  waiting: Map<string, (decision: string) => void>;
  wire: Wire;
  /** What the status line says when nothing more urgent is going on. */
  base: string;
  /** The reader is speaking. */
  hearing: boolean;
  /** The reader has finished, and the model has not yet answered. */
  thinking: boolean;
  /** Tool calls and forms on their way to the server. */
  working: number;
  /** The microphone's level, 0 to 1, and whether it counts as speech. */
  level: number;
  speaking: boolean;
  /** When the level last fell quiet, while still counted as speech. */
  quietAt: number;
  /** The reader switched the microphone off: nothing they say is sent. */
  muted: boolean;
  /** Chunks of silence still to send after a mute, so the provider hears the reader stop. */
  muteTail: number;
  /** When something last happened on the call, in milliseconds (performance.now). */
  activeAt: number;
  /** Nobody has spoken for a while, and the reader is being asked if they are there. */
  idle: boolean;
  /** When the provider was last told the call is in use, on the same clock. */
  aliveAt: number;
}

/** What the status line is worked out from. */
export type CallStatus = Pick<
  Call,
  "waiting" | "working" | "thinking" | "hearing" | "base" | "idle"
>;

/** The parts of the status a change may set. */
export type StatusPatch = Partial<Pick<Call, "base" | "hearing" | "thinking">>;

/** One provider's protocol: what to send, and what its messages mean. */
export interface Wire {
  /** True when only the microphone's level tells that the reader speaks. */
  readonly byMeter: boolean;
  /** The first message, when the provider wants one from the browser. */
  begin(): void;
  /** A piece of microphone audio: 16 kHz, 16-bit, base64. */
  audio(base64: string): void;
  /** A typed message, said to the model. */
  text(text: string): void;
  /** The microphone was switched off: no more audio is coming for now. */
  pause(): void;
  /**
   * The call is in use in a way only the page can tell: an answer awaited on
   * screen, a long reply still playing, the reader saying they are there.
   */
  alive(): void;
  receive(message: any): Promise<void>;
}

/** The socket a wire writes to: only what it needs, so a test can fake it. */
export interface WireSocket {
  readonly readyState: number;
  send(data: string): void;
}

/** A tool call as a provider sends it: its id is checked before it is run. */
export interface ToolRequest {
  id: unknown;
  name: string;
  args: unknown;
}

/**
 * What a provider's messages do to the call. The component gives these;
 * each one works on the call this wire belongs to.
 */
export interface WireHooks {
  /** The provider says the call is on. */
  connected(): void;
  /** Run a tool call, and give back what the model is told. */
  answerTool(tool: ToolRequest): Promise<string>;
  mark(patch: StatusPatch): void;
  /** The reader cut in: stop the model's voice at once. */
  quiet(): void;
  /**
   * Words the reader said. `piece` names the utterance they belong to, when
   * the provider names it: `whole` then replaces that utterance's words, and
   * never another's (see reader.ts).
   */
  heard(text: string, piece?: string, whole?: boolean): void;
  /**
   * The reader spoke over a reply. When none of it had been heard yet, and
   * it shows nothing, it is taken back, and this is true: the reader's
   * turn goes on. Otherwise the reply stays, and this is false.
   */
  dropReply(): boolean;
  /** Someone spoke, or something was said: the call is in use. */
  active(): void;
  /** A piece of the model's audio: 24 kHz, 16-bit, base64. */
  play(base64: string): void;
  /** Words the model said. */
  spoke(text: string): void;
  /** The time of one spoken word, from the start of its response's audio. */
  timedWord(text: string, ms: number): void;
  /** A new response begins: its words are timed from its own audio. */
  newResponse(): void;
  /** Store the turn, and start the next with a clean slate. */
  endTurn(): void;
  /** What the model has said in this turn. */
  said(): string;
  /** Whether this turn has a reply in the thread yet. */
  hasReply(): boolean;
  /** Whether this wire's call is still the one that is on. */
  isCurrent(): boolean;
}

/** A word and its time, in seconds from the start of the turn's audio. */
export interface TimedWord {
  text: string;
  at: number;
}

/**
 * What the caption follows: the words and the audio of the turn being
 * played. It is kept apart from the turn itself, because a turn is over,
 * and stored, well before its audio has finished playing.
 */
export interface Voiced {
  text: string;
  start: number;
  seconds: number;
  open: boolean;
  /** The time of each word, when the provider says it. */
  words: TimedWord[];
}

/** What the server says about one tool call. */
export interface ToolAnswer {
  state: string;
  output?: string;
  view: boolean;
}

/** What /api/voice-session answers: where to connect, and how to talk there. */
export interface Ticket {
  protocol: string;
  url: string;
  setup: unknown;
  label?: string;
}
