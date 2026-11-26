/*
 * The shapes chat-voice's modules share: the reader's choices, and the
 * browser's speech recognizer as far as chat-voice uses it. Types only, so
 * importing this adds nothing to the component's script.
 */

/** What the reader chose, kept for their next visit. */
export interface Settings {
  captions: boolean;
  aloud: boolean;
  talk: boolean;
  /** The reading pace, as the speed menu's value: "0.75" to "2". */
  speed: string;
}

/** The part of the Web Speech API's recognizer chat-voice uses. */
export interface Recognizer {
  lang: string;
  interimResults: boolean;
  onresult:
    | ((event: {
        results: ArrayLike<
          ArrayLike<{ transcript: string }> & { isFinal: boolean }
        >;
      }) => void)
    | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  abort(): void;
}
