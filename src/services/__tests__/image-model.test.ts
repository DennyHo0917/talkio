import { describe, expect, it } from "vitest";
import type { Provider } from "../../types";
import { inferImageGenerationApi } from "../image-model";

function provider(overrides: Partial<Provider> = {}): Provider {
  return {
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
    ...overrides,
  };
}

describe("inferImageGenerationApi", () => {
  it("requires image output", () => {
    expect(inferImageGenerationApi(provider({ profileId: "openai" }), ["text"])).toBeUndefined();
  });

  it("maps supported SDK provider families", () => {
    expect(inferImageGenerationApi(provider({ profileId: "openai" }), ["image"])).toBe("openai");
    expect(
      inferImageGenerationApi(provider({ type: "gemini", apiFormat: "gemini-generate-content" }), [
        "image",
      ]),
    ).toBe("google");
    expect(inferImageGenerationApi(provider(), ["image"])).toBe("openai-compatible");
    expect(inferImageGenerationApi(provider({ apiFormat: undefined }), ["image"])).toBe(
      "openai-compatible",
    );
  });

  it("does not treat chat-native OpenRouter images as an ImageModel API", () => {
    expect(
      inferImageGenerationApi(provider({ profileId: "openrouter" }), ["text", "image"]),
    ).toBeUndefined();
  });

  it("does not route Azure through the OpenAI image endpoint", () => {
    expect(
      inferImageGenerationApi(provider({ type: "azure-openai", profileId: "azure-openai" }), [
        "image",
      ]),
    ).toBeUndefined();
  });
});
