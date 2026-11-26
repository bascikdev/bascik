/**
 * A voice call's state, kept in the shared store so a call's tool calls may
 * land on different servers: whether a call may use a conversation, and the
 * turn being recorded, changed under a lock.
 */
import type { Lease } from "../shared.ts";
import { newVoiceTurn, type VoiceTurn } from "../voice.ts";
import type { ChatBase, ChatVoiceState } from "./context.ts";
import { NO_STORE, VOICE_MS } from "./limits.ts";
import { sleep } from "./wait.ts";

/** The chat's voice call state. */
export function chatVoiceState(base: ChatBase): ChatVoiceState {
  const { options, shared, keys } = base;

  /* Voice: the turn being recorded for each conversation. It is in the
     shared store, so a call's tool calls may land on different servers. */

  /**
   * Whether a voice call may use this conversation. A fixed provider serves
   * every request. A picker serves only the conversations it opened a voice
   * session for (within `VOICE_MS` of the last use): a picker that offers no
   * provider leaves the voice handlers answering 404, like no `voice` at all.
   */
  const pickedVoice = typeof options.voice === "function";
  const voiceOpenKey = keys.voiceOpen;
  const voiceOpen = async (conversationId: string): Promise<boolean> => {
    if (options.voice == null) return false;
    if (!pickedVoice) return true;
    const key = voiceOpenKey(conversationId);
    if ((await shared.get(key)) === undefined) return false;
    // Kept while the call goes on, as the turn is.
    await shared.set(key, "1", VOICE_MS);
    return true;
  };
  const noVoice = (): Response =>
    new Response("This server has no voice provider.", {
      status: 404,
      headers: NO_STORE,
    });
  const voiceKey = keys.voice;
  /** `call` is a `voiceCallId`, so it is short and safe in a key. */
  const viewKey = keys.view;
  const readVoice = async (conversationId: string): Promise<VoiceTurn> => {
    const raw = await shared.get(voiceKey(conversationId));
    return raw === undefined ? newVoiceTurn() : (JSON.parse(raw) as VoiceTurn);
  };
  /**
   * Change a conversation's recorded turn with no one else changing it. Held
   * only for the read, the change and the write, never while a tool runs.
   */
  async function updateVoice<T>(
    conversationId: string,
    change: (turn: VoiceTurn) => T | Promise<T>,
  ): Promise<T> {
    let lock: Lease | null = null;
    for (let tries = 0; !lock; tries++) {
      lock = await shared.claim(keys.voiceLock(conversationId), 5000);
      if (!lock) {
        if (tries >= 200) throw new Error("The voice call's state is busy.");
        await sleep(25);
      }
    }
    try {
      const turn = await readVoice(conversationId);
      const result = await change(turn);
      await shared.set(
        voiceKey(conversationId),
        JSON.stringify(turn),
        VOICE_MS,
      );
      return result;
    } finally {
      await lock.release();
    }
  }

  return {
    pickedVoice,
    voiceOpenKey,
    voiceOpen,
    noVoice,
    viewKey,
    updateVoice,
  };
}
