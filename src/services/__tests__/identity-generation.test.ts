import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "../../types";

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  getLanguageModel: vi.fn(() => ({ specificationVersion: "v4" })),
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    generateText: mocks.generateText,
    wrapLanguageModel: ({ model }: { model: unknown }) => model,
  };
});
vi.mock("../runtime/ai-sdk/ai-sdk-runtime", () => ({
  getLanguageModel: mocks.getLanguageModel,
}));

import { generateIdentityDraft } from "../identity-generation";

const provider: Provider = {
  id: "provider-1",
  name: "Azure",
  type: "azure-openai",
  profileId: "azure-openai",
  apiFormat: "chat-completions",
  baseUrl: "https://resource.openai.azure.com/openai",
  apiVersion: "2024-10-21",
  apiKey: "secret",
  customHeaders: [],
  enabled: true,
  status: "connected",
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("generateIdentityDraft", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses structured output through the shared model resolver", async () => {
    const draft = { name: "Code Reviewer", icon: "code" as const, systemPrompt: "Review code." };
    mocks.generateText.mockResolvedValue({ output: draft });

    await expect(generateIdentityDraft(provider, "deployment one", "Review code")).resolves.toEqual(
      draft,
    );
    expect(mocks.getLanguageModel).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl:
          "https://resource.openai.azure.com/openai/deployments/deployment%20one?api-version=2024-10-21",
        headers: expect.objectContaining({ "api-key": "secret" }),
        modelId: "deployment one",
      }),
    );
    expect(mocks.generateText).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Review code", temperature: 0.7 }),
    );
  });
});
