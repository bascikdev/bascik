/*
 * The browser side of the voice lab: a script a test adds to the page before
 * it loads (`page.addInitScript(VOICE_LAB)`). It changes nothing a page does;
 * it stands in for the two things a test machine does not have, and watches:
 *
 * - The microphone. `getUserMedia` gives a stream the test plays recorded
 *   sound into, on cue (`say`). The page still captures it, resamples it,
 *   and sends it, exactly as it does a real microphone's.
 * - The loudspeaker. Everything a page sends to an AudioContext's output is
 *   also recorded, sample for sample (`played`), so a test can hear what the
 *   reader would have heard: which sound, when it started, when it stopped.
 * - What a call holds. Every microphone track, AudioContext and WebSocket
 *   the page opens is kept in a list, so a test can tell that none is left.
 *
 * It is a string, not a function, because this package's tests are compiled
 * without the browser's types.
 */

export const VOICE_LAB = String.raw`(() => {
  if (window.__voiceLab) return;
  const lab = (window.__voiceLab = {
    /** "lab": a stream to say things into. "denied": the reader says no. "none": no device. */
    microphone: "lab",
    /** How long the browser takes to answer the microphone question, in ms. */
    microphoneDelay: 0,
    asked: 0,
    tracks: [],
    contexts: [],
    sockets: [],
    /** True when sound was sent to an output before its recorder was ready. */
    tapLate: false,
  });

  /* ---- The microphone ---- */

  let source = null;
  let out = null;
  const micContext = () => {
    if (!source) {
      source = new RealContext({ sampleRate: 48000 });
      // A stream with nothing playing into it sends nothing at all: this
      // keeps it sending silence, as an open microphone in a quiet room does.
      const room = source.createConstantSource();
      room.offset.value = 0;
      room.start();
      lab.room = room;
    }
    void source.resume();
    return source;
  };

  if (!navigator.mediaDevices) {
    Object.defineProperty(navigator, "mediaDevices", { value: {} });
  }
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    lab.asked++;
    lab.constraints = constraints;
    if (lab.microphoneDelay) {
      await new Promise((resolve) => setTimeout(resolve, lab.microphoneDelay));
    }
    if (lab.microphone === "denied") {
      throw new DOMException("The reader said no.", "NotAllowedError");
    }
    if (lab.microphone === "none") {
      throw new DOMException("No microphone.", "NotFoundError");
    }
    const context = micContext();
    out = context.createMediaStreamDestination();
    lab.room.connect(out);
    for (const track of out.stream.getTracks()) lab.tracks.push(track);
    return out.stream;
  };

  const decode = (base64) => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at);
    const pcm = new Int16Array(bytes.buffer);
    const samples = new Float32Array(pcm.length);
    for (let at = 0; at < pcm.length; at++) samples[at] = pcm[at] / 32768;
    return samples;
  };

  /**
   * Say recorded sound into the microphone: 16-bit PCM in base64, at "rate".
   * Gives when it started (performance.now) and how long it is.
   */
  lab.say = (base64, rate) => {
    if (!out) throw new Error("No microphone is open.");
    const context = micContext();
    const samples = decode(base64);
    const buffer = context.createBuffer(1, samples.length, rate);
    buffer.getChannelData(0).set(samples);
    const voice = context.createBufferSource();
    voice.buffer = buffer;
    voice.connect(out);
    voice.start();
    lab.saying = voice;
    return { at: performance.now(), seconds: buffer.duration };
  };

  /** Stop what is being said, mid-word. */
  lab.hush = () => lab.saying?.stop();

  /** The microphone goes away, as when a headset is unplugged. */
  lab.unplug = () => {
    for (const track of lab.tracks) {
      if (track.readyState !== "live") continue;
      track.stop();
      track.dispatchEvent(new Event("ended"));
    }
  };

  /** How many microphone tracks are still open. */
  lab.liveTracks = () =>
    lab.tracks.filter((track) => track.readyState === "live").length;

  /* ---- The loudspeaker ---- */

  const TAP = URL.createObjectURL(
    new Blob(
      [
        'registerProcessor("lab-tap", class extends AudioWorkletProcessor {' +
          "process(inputs) {" +
          "const channel = inputs[0][0];" +
          "if (channel) this.port.postMessage({ frame: currentFrame, samples: channel.slice(0) });" +
          "return true; } });",
      ],
      { type: "text/javascript" },
    ),
  );

  const RealContext = window.AudioContext;
  const taps = new WeakMap();

  /** Join an output's recorder to its bus, once both exist. */
  const attach = (context) => {
    const tap = taps.get(context);
    if (!tap || tap.node || !tap.loaded || !tap.bus) return;
    tap.node = new AudioWorkletNode(context, "lab-tap");
    tap.node.port.onmessage = ({ data }) => {
      tap.blocks.push(data);
      // The earliest a block has ever arrived, for its place in the sound,
      // is the closest this page can get to when the sound started.
      const zero = performance.now() - (data.frame / context.sampleRate) * 1000;
      if (zero < tap.zeroAt) tap.zeroAt = zero;
    };
    realConnect.call(tap.bus, tap.node);
  };

  window.AudioContext = class extends RealContext {
    constructor(options) {
      super(options);
      lab.contexts.push(this);
      const tap = { blocks: [], zeroAt: Infinity, loaded: false, bus: null, node: null };
      taps.set(this, tap);
      this.audioWorklet.addModule(TAP).then(
        () => {
          tap.loaded = true;
          attach(this);
        },
        () => {},
      );
    }
  };

  const realConnect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (target, ...rest) {
    const tap = target instanceof AudioDestinationNode && taps.get(target.context);
    if (tap) {
      if (!tap.bus) {
        tap.bus = target.context.createGain();
        if (!tap.loaded) lab.tapLate = true;
        attach(target.context);
      }
      realConnect.call(this, tap.bus);
    }
    return realConnect.call(this, target, ...rest);
  };

  /** The contexts a page made that are not closed, by state. */
  lab.openContexts = () =>
    lab.contexts.filter((context) => context.state !== "closed").map((context) => context.state);

  /**
   * Everything sent to the loudspeaker so far, from the first sound of the
   * busiest output: 16-bit PCM in base64, its rate, and when its first
   * sample was played (performance.now). Quiet between sounds is kept.
   */
  lab.played = () => {
    let best = null;
    for (const context of lab.contexts) {
      const tap = taps.get(context);
      if (tap && tap.blocks.length && (!best || tap.blocks.length > best.tap.blocks.length)) {
        best = { tap, context };
      }
    }
    if (!best) return { sampleRate: 0, pcm: "", startedAt: 0, seconds: 0 };
    const { tap, context } = best;
    const first = tap.blocks[0].frame;
    const last = tap.blocks.at(-1);
    const pcm = new Int16Array(last.frame + last.samples.length - first);
    for (const block of tap.blocks) {
      for (let at = 0; at < block.samples.length; at++) {
        const sample = Math.max(-1, Math.min(1, block.samples[at]));
        pcm[block.frame - first + at] = Math.round(sample * 32767);
      }
    }
    const bytes = new Uint8Array(pcm.buffer);
    let binary = "";
    for (let at = 0; at < bytes.length; at += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    }
    return {
      sampleRate: context.sampleRate,
      pcm: btoa(binary),
      startedAt: tap.zeroAt + (first / context.sampleRate) * 1000,
      seconds: pcm.length / context.sampleRate,
      now: performance.now(),
    };
  };

  /* ---- The connection ---- */

  const RealSocket = window.WebSocket;
  window.WebSocket = class extends RealSocket {
    constructor(...args) {
      super(...args);
      lab.sockets.push(this);
    }
  };
  /** How many sockets are not closed. */
  lab.openSockets = () =>
    lab.sockets.filter((socket) => socket.readyState !== RealSocket.CLOSED).length;
})();`;
