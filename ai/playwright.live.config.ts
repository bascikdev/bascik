/**
 * The live lane: the voice specs in live/ against REAL speech-to-speech
 * providers, with real speech said into the page's microphone. Not part of
 * `yarn e2e` or CI: it needs your keys and spends API credits (a few short
 * calls a run).
 *
 *   GEMINI_API_KEY=... yarn workspace @bascik/ai e2e:live
 *   AZURE_VOICE_LIVE_ENDPOINT=https://<resource>.services.ai.azure.com yarn workspace @bascik/ai e2e:live
 *
 * Azure uses AZURE_VOICE_LIVE_API_KEY when it is set, and your `az login`
 * when it is not. With both providers set, both are tested.
 *
 * Every call goes through a recorder (voice-lab/record.ts), and each spec
 * saves its call as a cassette in e2e/cassettes/live/, so one live run
 * gives the recordings that `yarn e2e` then plays back for nothing.
 */
import { defineConfig } from "@playwright/test";

const PORT = 4478;
const RECORDERS: Record<string, number> = {
  "gemini-live": 4490,
  "azure-voice-live": 4491,
};
const set = {
  "gemini-live": Boolean(process.env.GEMINI_API_KEY),
  "azure-voice-live": Boolean(process.env.AZURE_VOICE_LIVE_ENDPOINT),
};
const providers = Object.entries(set)
  .filter(([, has]) => has)
  .map(([name]) => name);
if (!providers.length) {
  throw new Error(
    "The live lane needs a provider: set GEMINI_API_KEY, or AZURE_VOICE_LIVE_ENDPOINT (with AZURE_VOICE_LIVE_API_KEY or an `az login`).",
  );
}
// The specs read which providers to call, and where their recorders are.
process.env.VOICE_LIVE_PROVIDERS = providers.join(",");
/** Stand-in addresses, when the lane itself is being tested (VOICE_LIVE_UPSTREAM_<n>). */
const upstream = (provider: string): string[] => {
  const given =
    process.env[
      `VOICE_LIVE_UPSTREAM_${provider.replace(/-/g, "_").toUpperCase()}`
    ];
  return given ? ["--upstream", given] : [];
};

export default defineConfig({
  testDir: "./live",
  reporter: "line",
  workers: 1,
  // A real model takes its time, and a turn is several seconds of speech.
  timeout: 120_000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    launchOptions: process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH }
      : {},
  },
  webServer: [
    ...providers.map((provider) => ({
      command: [
        "node voice-lab/record.ts",
        provider,
        "--no-demo",
        `--port ${RECORDERS[provider]}`,
        "--dir e2e/cassettes/live",
        ...upstream(provider),
      ].join(" "),
      port: RECORDERS[provider]!,
      reuseExistingServer: false,
    })),
    {
      command: `yarn build && cd demo && bascik --build && bascik --server --port ${PORT}`,
      url: `http://127.0.0.1:${PORT}/`,
      reuseExistingServer: false,
      env: {
        GENUI_LOCAL_MODELS: "0",
        // Each provider is reached through its recorder.
        ...(set["gemini-live"]
          ? { GEMINI_LIVE_WS: `ws://127.0.0.1:${RECORDERS["gemini-live"]}` }
          : {}),
        ...(set["azure-voice-live"]
          ? {
              AZURE_VOICE_LIVE_WS: `ws://127.0.0.1:${RECORDERS["azure-voice-live"]}`,
            }
          : {}),
      },
    },
  ],
});
