# Cassettes

Recorded voice sessions that `e2e/voice-cassette.spec.ts` plays back: one `.jsonl` file a session, here or in `live/`, where the live lane (`yarn workspace @bascik/ai e2e:live`) saves its calls. See `voice-lab/README.md` for how to record one and what a cassette keeps.

A cassette holds the model's voice and words and none of the reader's sound. Read it before you commit it: what the reader typed, and what the model said back, are in it as text.
