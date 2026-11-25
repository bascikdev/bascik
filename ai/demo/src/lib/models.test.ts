import { describe, expect, it } from "vitest";
import {
  OFFLINE,
  availableModels,
  endpointsFrom,
  modelCookie,
  pickModel,
  requestedModel,
} from "./models.ts";

/** A `fetch` that answers `/models` for the hosts it is given. */
const servers =
  (lists: Record<string, string[]>): typeof fetch =>
  async (input) => {
    const url = String(input);
    const host = Object.keys(lists).find((candidate) =>
      url.startsWith(candidate),
    );
    if (!host) throw new TypeError("fetch failed");
    return Response.json({ data: lists[host]!.map((id) => ({ id })) });
  };

describe("availableModels", () => {
  it("offers only the offline script when nothing is configured or running", async () => {
    expect(await availableModels({}, servers({}))).toEqual([OFFLINE]);
  });

  it("lists what Ollama and LM Studio have on this machine", async () => {
    const choices = await availableModels(
      {},
      servers({
        "http://127.0.0.1:11434/v1": ["llama3.2:3b", "qwen2.5-coder:7b"],
        "http://127.0.0.1:1234/v1": ["google/gemma-3-4b"],
      }),
    );
    expect(choices.map((choice) => choice.id)).toEqual([
      "offline:script",
      "ollama:llama3.2:3b",
      "ollama:qwen2.5-coder:7b",
      "lmstudio:google/gemma-3-4b",
    ]);
    expect(choices[1]!.group).toBe("Ollama (this machine)");
  });

  it("does not look on its own machine when told not to", async () => {
    const asked: string[] = [];
    const choices = await availableModels(
      { GENUI_LOCAL_MODELS: "0" },
      async (input) => {
        asked.push(String(input));
        return Response.json({ data: [] });
      },
    );
    expect(choices).toEqual([OFFLINE]);
    expect(asked).toEqual([]);
  });

  it("offers Claude when a key is set, and a configured server's own list", async () => {
    const choices = await availableModels(
      {
        GENUI_LOCAL_MODELS: "0",
        ANTHROPIC_API_KEY: "sk-ant-test",
        ANTHROPIC_MODELS: "claude-haiku-5-5",
        OPENAI_BASE_URL: "https://models.example/v1",
        OPENAI_MODELS: "team-model-a, team-model-b",
        OPENAI_LABEL: "Team gateway",
      },
      servers({}),
    );
    expect(choices.map((choice) => [choice.group, choice.id])).toEqual([
      ["No model", "offline:script"],
      ["Claude (Anthropic API)", "anthropic:claude-haiku-5-5"],
      ["Team gateway", "openai:team-model-a"],
      ["Team gateway", "openai:team-model-b"],
    ]);
  });
});

describe("oMLX and Azure", () => {
  it("lists what oMLX has on this machine, sending its key when one is set", async () => {
    const seen: (string | null)[] = [];
    const send: typeof fetch = async (input, init) => {
      if (!String(input).startsWith("http://127.0.0.1:8000/v1")) {
        throw new TypeError("fetch failed");
      }
      seen.push(new Headers(init?.headers).get("authorization"));
      return Response.json({ data: [{ id: "mlx-community/gemma-3" }] });
    };
    const choices = await availableModels({ OMLX_API_KEY: "local-key" }, send);
    expect(choices.map((choice) => choice.id)).toEqual([
      "offline:script",
      "omlx:mlx-community/gemma-3",
    ]);
    expect(seen).toEqual(["Bearer local-key"]);
  });

  it("offers the Azure deployments that are named, on the voice resource when no other is given", async () => {
    const env = {
      GENUI_LOCAL_MODELS: "0",
      AZURE_VOICE_LIVE_ENDPOINT: "https://my-resource.services.ai.azure.com/",
      AZURE_OPENAI_MODELS: "gpt-chat, gpt-small",
      AZURE_OPENAI_API_KEY: "azure-key",
    };
    const choices = await availableModels(env, servers({}));
    expect(choices.slice(1)).toEqual([
      {
        id: "azure:gpt-chat",
        provider: "azure",
        group: "Azure",
        name: "gpt-chat",
      },
      {
        id: "azure:gpt-small",
        provider: "azure",
        group: "Azure",
        name: "gpt-small",
      },
    ]);
    expect(endpointsFrom(env)[0]).toMatchObject({
      baseUrl: "https://my-resource.openai.azure.com/openai/v1",
      apiKey: "azure-key",
    });
    // A named endpoint wins, with or without the API path on it.
    for (const named of [
      "https://other.openai.azure.com",
      "https://other.openai.azure.com/openai/v1/",
    ]) {
      expect(
        endpointsFrom({ ...env, AZURE_OPENAI_ENDPOINT: named })[0]!.baseUrl,
      ).toBe("https://other.openai.azure.com/openai/v1");
    }
  });

  it("offers no Azure model until a deployment is named: Azure lists every model, deployed or not", () => {
    expect(
      endpointsFrom({
        GENUI_LOCAL_MODELS: "0",
        AZURE_VOICE_LIVE_ENDPOINT: "https://my-resource.services.ai.azure.com",
      }),
    ).toEqual([]);
  });

  it("signs in with the Azure CLI when there is no key, asked for only when a reply needs it", () => {
    const [azure] = endpointsFrom({
      GENUI_LOCAL_MODELS: "0",
      AZURE_OPENAI_ENDPOINT: "https://other.openai.azure.com",
      AZURE_OPENAI_MODELS: "gpt-chat",
    });
    expect(typeof azure!.apiKey).toBe("function");
  });
});

describe("endpointsFrom", () => {
  it.each([
    ["127.0.0.1:11434", "http://127.0.0.1:11434/v1"],
    ["http://gpu-box:11434/", "http://gpu-box:11434/v1"],
    ["https://ollama.example/v1", "https://ollama.example/v1"],
  ])("reads OLLAMA_HOST %s as %s", (host, baseUrl) => {
    expect(endpointsFrom({ OLLAMA_HOST: host })[0]!.baseUrl).toBe(baseUrl);
  });
});

describe("the visitor's choice", () => {
  const choices = [
    OFFLINE,
    {
      id: "ollama:llama3.2:3b",
      provider: "ollama",
      group: "Ollama",
      name: "llama3.2:3b",
    },
  ];
  const withCookie = (cookie: string) =>
    new Request("http://localhost/", { headers: { cookie } });

  it("survives the cookie round trip, colons and slashes included", () => {
    const id = "lmstudio:google/gemma-3-4b";
    const cookie = modelCookie(id).split(";")[0]!;
    expect(requestedModel(withCookie(`visitor=abc; ${cookie}`))).toBe(id);
  });

  it("is used only when the server still offers it", () => {
    expect(pickModel(choices, "ollama:llama3.2:3b").id).toBe(
      "ollama:llama3.2:3b",
    );
    expect(pickModel(choices, "ollama:gone:1b")).toBe(OFFLINE);
    expect(pickModel(choices, "openai:http://evil.example/v1")).toBe(OFFLINE);
    expect(pickModel(choices, undefined)).toBe(OFFLINE);
  });

  it("defaults to Claude when a key is set and nothing is chosen", () => {
    const claude = {
      id: "anthropic:claude-opus-5-5",
      provider: "anthropic",
      group: "Claude",
      name: "claude-opus-5-5",
    };
    expect(pickModel([...choices, claude], undefined)).toBe(claude);
  });

  it("ignores a cookie that does not decode", () => {
    expect(requestedModel(withCookie("model=%E0%A4%A"))).toBeUndefined();
    expect(requestedModel(withCookie("other=1"))).toBeUndefined();
  });
});
