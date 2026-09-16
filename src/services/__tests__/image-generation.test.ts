import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Model, Provider } from "../../types";

const { appFetch } = vi.hoisted(() => ({ appFetch: vi.fn() }));
vi.mock("../../lib/http", () => ({ appFetch }));

const provider: Provider = {
  id: "provider-1",
  name: "Gateway",
  type: "openai",
  apiFormat: "chat-completions",
  baseUrl: "https://gateway.test/v1",
  apiKey: "test-key",
  customHeaders: [],
  enabled: true,
  status: "connected",
  createdAt: "2026-01-01T00:00:00.000Z",
};
const model: Model = {
  id: "image-model-1",
  providerId: provider.id,
  modelId: "gpt-image-1",
  displayName: "GPT Image 1",
  avatar: null,
  capabilities: { vision: false, toolCall: false, reasoning: false, streaming: false },
  inputModalities: ["text"],
  outputModalities: ["image"],
  imageGenerationApi: "openai-compatible",
  capabilitiesVerified: true,
  maxContextLength: 0,
  enabled: true,
};
const providerState = { providers: [provider], models: [model] };
vi.mock("../../stores/provider-store", () => ({
  useProviderStore: { getState: () => providerState },
}));

const settings = { defaultImageModelId: model.id };
vi.mock("../../stores/settings-store", () => ({
  useSettingsStore: { getState: () => ({ settings }) },
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("image generation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providerState.providers.splice(0, providerState.providers.length, provider);
    providerState.models.splice(0, providerState.models.length, model);
    provider.profileId = undefined;
    provider.enabled = true;
    model.enabled = true;
    model.outputModalities = ["image"];
    model.imageGenerationApi = "openai-compatible";
    settings.defaultImageModelId = model.id;
  });

  it("uses the AI SDK image model and returns a data URL", async () => {
    appFetch.mockResolvedValue(jsonResponse({ data: [{ b64_json: "QUJD" }] }));
    const { generateImages } = await import("../image-generation");

    expect(await generateImages({ prompt: "a red cube", size: "1024x1024" })).toEqual([
      "data:image/png;base64,QUJD",
    ]);
    const [url, init] = appFetch.mock.calls[0];
    expect(url).toBe("https://gateway.test/v1/images/generations");
    expect(JSON.parse(init.body)).toMatchObject({
      model: "gpt-image-1",
      prompt: "a red cube",
      n: 1,
      size: "1024x1024",
    });
  });

  it("selects a requested provider/model key", async () => {
    appFetch.mockResolvedValue(jsonResponse({ data: [{ b64_json: "QUJD" }] }));
    const { generateImages } = await import("../image-generation");

    await generateImages({ prompt: "a red cube", model: "Gateway/gpt-image-1" });
    expect(appFetch).toHaveBeenCalledOnce();
  });

  it("routes requests between multiple configured image models", async () => {
    const secondModel: Model = {
      ...model,
      id: "image-model-2",
      modelId: "dall-e-3",
      displayName: "DALL-E 3",
    };
    providerState.models.push(secondModel);
    appFetch.mockResolvedValue(jsonResponse({ data: [{ b64_json: "QUJD" }] }));
    const { generateImages } = await import("../image-generation");

    await generateImages({ prompt: "a blue cube", model: "Gateway/dall-e-3" });

    expect(JSON.parse(appFetch.mock.calls[0][1].body)).toMatchObject({ model: "dall-e-3" });
  });

  it("falls back when the configured default model is unavailable", async () => {
    settings.defaultImageModelId = "missing-model";
    const { getDefaultImageModel } = await import("../image-generation");

    expect(getDefaultImageModel()?.id).toBe(model.id);
  });

  it("downloads hosted image responses through the SDK provider", async () => {
    appFetch
      .mockResolvedValueOnce(jsonResponse({ data: [{ url: "https://cdn.test/a.webp" }] }))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([65, 66, 67]), {
          status: 200,
          headers: { "Content-Type": "image/webp" },
        }),
      );
    const { generateImages } = await import("../image-generation");

    expect(await generateImages({ prompt: "a red cube" })).toEqual(["data:image/webp;base64,QUJD"]);
  });

  it("surfaces endpoint errors", async () => {
    appFetch.mockResolvedValue(
      jsonResponse(
        {
          error: {
            message: "bad key",
            type: "invalid_request_error",
            param: null,
            code: "invalid_api_key",
          },
        },
        401,
      ),
    );
    const { generateImages } = await import("../image-generation");

    await expect(generateImages({ prompt: "a red cube" })).rejects.toThrow(/401|bad key/i);
  });

  it("rejects invalid dimensions before sending a request", async () => {
    const { generateImages } = await import("../image-generation");

    await expect(generateImages({ prompt: "a red cube", size: "large" })).rejects.toThrow(
      "Invalid image size",
    );
    expect(appFetch).not.toHaveBeenCalled();
  });

  it("is unconfigured without an enabled image-output model", async () => {
    const { isImageGenerationConfigured } = await import("../image-generation");
    expect(isImageGenerationConfigured()).toBe(true);
    model.outputModalities = ["text"];
    model.imageGenerationApi = undefined;
    expect(isImageGenerationConfigured()).toBe(false);
  });
});

describe("generate_image tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providerState.providers.splice(0, providerState.providers.length, provider);
    providerState.models.splice(0, providerState.models.length, model);
    provider.profileId = undefined;
    provider.enabled = true;
    model.enabled = true;
    model.outputModalities = ["image"];
    model.imageGenerationApi = "openai-compatible";
  });

  it("returns images out of band, never inside the tool result text", async () => {
    appFetch.mockResolvedValue(jsonResponse({ data: [{ b64_json: "QUJD" }] }));
    const { executeBuiltInTool } = await import("../built-in-tools");

    const result = await executeBuiltInTool("generate_image", { prompt: "a red cube" });
    expect(result?.success).toBe(true);
    expect(result?.images).toEqual(["data:image/png;base64,QUJD"]);
    expect(result?.content).not.toContain("QUJD");
  });

  it("reports failures instead of pretending an image was drawn", async () => {
    appFetch.mockResolvedValue(
      jsonResponse(
        {
          error: {
            message: "bad key",
            type: "invalid_request_error",
            param: null,
            code: "invalid_api_key",
          },
        },
        401,
      ),
    );
    const { executeBuiltInTool } = await import("../built-in-tools");

    const result = await executeBuiltInTool("generate_image", { prompt: "a red cube" });
    expect(result?.success).toBe(false);
    expect(result?.error).toMatch(/401|bad key/i);
  });

  it("aborts an in-flight image request when the conversation stops", async () => {
    appFetch.mockImplementation((_input, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("The operation was aborted", "AbortError")),
          { once: true },
        );
      });
    });
    const controller = new AbortController();
    const { executeBuiltInTool } = await import("../built-in-tools");

    const pending = executeBuiltInTool(
      "generate_image",
      { prompt: "a red cube" },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(appFetch).toHaveBeenCalledOnce());
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(appFetch.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it("offers configured image models in the tool schema", async () => {
    const { getBuiltInToolDefs } = await import("../built-in-tools");
    const generateImage = getBuiltInToolDefs().find(
      (definition) => definition.function.name === "generate_image",
    );
    expect(generateImage).toBeDefined();
    const modelProperty = (generateImage!.function.parameters.properties as Record<string, any>)
      .model;

    expect(modelProperty.enum).toEqual(["Gateway/gpt-image-1"]);
    model.outputModalities = ["text"];
    model.imageGenerationApi = undefined;
    expect(
      getBuiltInToolDefs().some((definition) => definition.function.name === "generate_image"),
    ).toBe(false);
  });

  it("does not expose chat-native OpenRouter image output as an image model", async () => {
    const { getAvailableImageModels } = await import("../image-generation");
    provider.profileId = "openrouter";
    model.outputModalities = ["text", "image"];
    model.imageGenerationApi = undefined;

    expect(getAvailableImageModels()).toEqual([]);
    expect(model.outputModalities).toContain("image");

    provider.profileId = undefined;
  });
});
