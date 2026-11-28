import { defineConfig } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  silence,
  speechLike,
  toWav,
  join as joinSound,
} from "./voice-lab/signal.ts";

/**
 * A recording for Chromium to use as the microphone itself: the browser's
 * own capture, with its own processing, hears this file in place of a device
 * (the real-microphone project below). A second of quiet, then a sentence;
 * Chromium plays it over and over. It is made from a formula each run, so
 * no recording is kept in the repository. voice-capture.spec.ts makes the
 * same sentence to compare with.
 */
const MICROPHONE_FILE = join(tmpdir(), "bascik-ai-voice-lab", "microphone.wav");
mkdirSync(join(MICROPHONE_FILE, ".."), { recursive: true });
writeFileSync(
  MICROPHONE_FILE,
  toWav(
    joinSound(
      silence(1, 48_000),
      speechLike(3, 48_000, { pitch: 120, rate: 4.2 }),
      silence(1, 48_000),
    ),
    48_000,
  ),
);

const PORT = 4477;
const STARTER_PORT = 4478;
const MODEL_PORT = 4479;
const VOICE_PORT = 4480;
const AZURE_VOICE_PORT = 4481;

export default defineConfig({
  testDir: "./e2e",
  reporter: "line",
  // One conversation store on disk: keep the specs in one worker.
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    launchOptions: process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH }
      : {},
  },
  // Every spec runs twice. The chat must work with no client JavaScript at
  // all, and it must work the same with the client runtime (chat-enhance)
  // sending forms with fetch and streaming the answer into the open page.
  projects: [
    {
      name: "no-js",
      testIgnore: /voice-capture\.spec\.ts/,
      use: { javaScriptEnabled: false },
    },
    {
      name: "js",
      testIgnore: /voice-capture\.spec\.ts/,
      use: { javaScriptEnabled: true },
    },
    {
      // The browser's real getUserMedia, with a file where the device would
      // be. Every other voice spec hands the page a stream; this one checks
      // that what the browser's own capture gives is what reaches a provider.
      name: "real-microphone",
      testMatch: /voice-capture\.spec\.ts/,
      use: {
        javaScriptEnabled: true,
        permissions: ["microphone"],
        launchOptions: {
          ...(process.env.CHROMIUM_PATH
            ? { executablePath: process.env.CHROMIUM_PATH }
            : {}),
          args: [
            "--use-fake-device-for-media-stream",
            "--use-fake-ui-for-media-stream",
            `--use-file-for-fake-audio-capture=${MICROPHONE_FILE}`,
          ],
        },
      },
    },
  ],
  webServer: [
    {
      // The starter: a page that is the all-in-one and nothing else, with its
      // scripted model. e2e/chat-app.spec.ts names this port.
      command: `cd examples/starter && bascik --build && bascik --server --port ${STARTER_PORT}`,
      url: `http://127.0.0.1:${STARTER_PORT}/`,
      reuseExistingServer: false,
    },
    {
      // A stand-in for a speech-to-speech provider, so a voice call has one to reach.
      command: `node e2e/fake-live-server.ts ${VOICE_PORT}`,
      port: VOICE_PORT,
      reuseExistingServer: false,
    },
    {
      // And one for Azure Voice Live, which the server's relay connects to.
      command: `node e2e/fake-azure-server.ts ${AZURE_VOICE_PORT}`,
      port: AZURE_VOICE_PORT,
      reuseExistingServer: false,
    },
    {
      // A stand-in for a local model server, so the selector has one to list.
      command: `node e2e/fake-model-server.ts ${MODEL_PORT}`,
      url: `http://127.0.0.1:${MODEL_PORT}/v1/models`,
      reuseExistingServer: false,
    },
    {
      command: `yarn build && cd demo && bascik --build && bascik --server --port ${PORT}`,
      url: `http://127.0.0.1:${PORT}/`,
      reuseExistingServer: false,
      env: {
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
        // Only the stand-in: never whatever runs on the developer's machine.
        GENUI_LOCAL_MODELS: "0",
        OPENAI_BASE_URL: `http://127.0.0.1:${MODEL_PORT}/v1`,
        OPENAI_LABEL: "Test server",
        // Voice goes to the stand-in, with a key that is not one.
        GEMINI_API_KEY: "not-a-key",
        GEMINI_LIVE_HTTP: `http://127.0.0.1:${VOICE_PORT}`,
        GEMINI_LIVE_WS: `ws://127.0.0.1:${VOICE_PORT}`,
        AZURE_VOICE_LIVE_WS: `ws://127.0.0.1:${AZURE_VOICE_PORT}`,
        AZURE_VOICE_LIVE_API_KEY: "not-a-key",
      },
    },
  ],
});
