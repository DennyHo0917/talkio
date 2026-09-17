import { describe, it, expect, beforeEach, vi } from "vitest";

// kvStore reads localStorage at module load — install a memory stub first.
vi.hoisted(() => {
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => void map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  };
  (globalThis as unknown as { localStorage: typeof storage }).localStorage = storage;
});
import {
  resolveModelDescriptor,
  getAllModelDescriptors,
  setModelOverride,
  resetModelOverrides,
} from "../model-catalog";
import { getSupportedReasoningEfforts, type Model } from "../../../types";

describe("model catalog", () => {
  beforeEach(() => {
    resetModelOverrides();
  });

  it("resolves known models from the built-in catalog", () => {
    const gpt4o = resolveModelDescriptor("gpt-4o");
    expect(gpt4o?.displayName).toBe("GPT-4o");
    expect(gpt4o?.contextWindow).toBe(128000);
    expect(gpt4o?.capabilities?.tools).toBe(true);
    expect(gpt4o?.metadataSource).toBe("models.dev");
    expect(gpt4o?.metadataProviderId).toBe("openai");
  });

  it("maps profile aliases to the models.dev provider", () => {
    const gemini = resolveModelDescriptor("gemini", "gemini-2.5-pro");
    expect(gemini?.metadataProviderId).toBe("google");
    expect(gemini?.contextWindow).toBe(1048576);
    expect(gemini?.inputModalities).toContain("image");
  });

  it("normalizes a dated gateway suffix only when the model family identifies a source", () => {
    const deepseek = resolveModelDescriptor("custom", "deepseek-v4-flash:0731");
    expect(deepseek?.metadataMatch).toBe("normalized");
    expect(deepseek?.metadataProviderId).toBe("deepseek");
    expect(deepseek?.capabilities?.reasoning).toBe(true);
    expect(deepseek?.reasoningOptions).toContainEqual({
      type: "effort",
      values: ["low", "high", "max"],
    });
  });

  it("normalizes known gateway option suffixes without fuzzy name matching", () => {
    const gemini = resolveModelDescriptor("custom", "gemini-3.6-flash-high");
    expect(gemini?.metadataProviderId).toBe("google");
    expect(gemini?.metadataMatch).toBe("normalized");
    expect(resolveModelDescriptor("custom", "totally-unknown-high")).toBeUndefined();
  });

  it("returns undefined for unknown models without overrides", () => {
    expect(resolveModelDescriptor("no-such-model")).toBeUndefined();
  });

  it("user override wins over the built-in entry", () => {
    setModelOverride("openai", "gpt-4o", {
      contextWindow: 999999,
      displayName: "Custom GPT-4o",
    });
    const resolved = resolveModelDescriptor("openai", "gpt-4o")!;
    expect(resolved.contextWindow).toBe(999999);
    expect(resolved.displayName).toBe("Custom GPT-4o");
    // Non-overridden fields still come from the catalog.
    expect(resolved.capabilities?.tools).toBe(true);
  });

  it("an override alone creates a descriptor for an unknown model", () => {
    setModelOverride("custom", "custom-model", { contextWindow: 8192, displayName: "Custom" });
    const resolved = resolveModelDescriptor("custom", "custom-model")!;
    expect(resolved.displayName).toBe("Custom");
    expect(resolved.contextWindow).toBe(8192);
    expect(resolved.modelId).toBe("custom-model");
  });

  it("an empty patch removes the override", () => {
    setModelOverride("openai", "gpt-4o", { contextWindow: 1 });
    setModelOverride("openai", "gpt-4o", {});
    expect(resolveModelDescriptor("openai", "gpt-4o")?.contextWindow).toBe(128000);
  });

  it("getAllModelDescriptors applies overrides to the full catalog", () => {
    const builtInCount = getAllModelDescriptors("openai").length;
    setModelOverride("openai", "gpt-4o", { contextWindow: 1234 });
    setModelOverride("openai", "custom-model", { displayName: "Custom" });
    const all = getAllModelDescriptors("openai");
    expect(all.find((m) => m.modelId === "gpt-4o")?.contextWindow).toBe(1234);
    expect(all.find((m) => m.modelId === "custom-model")?.displayName).toBe("Custom");
    expect(all.length).toBe(builtInCount + 1);
  });

  it("isolates overrides for the same model id across providers", () => {
    setModelOverride("openai", "shared-model", { displayName: "OpenAI Shared" });
    setModelOverride("openrouter", "shared-model", { displayName: "OpenRouter Shared" });

    expect(resolveModelDescriptor("openai", "shared-model")?.displayName).toBe("OpenAI Shared");
    expect(resolveModelDescriptor("openrouter", "shared-model")?.displayName).toBe(
      "OpenRouter Shared",
    );
  });

  it("only exposes reasoning efforts declared by model metadata", () => {
    const model = {
      capabilities: { reasoning: true },
      reasoningOptions: [{ type: "effort", values: ["low", "high", "max"] }],
    } as Model;
    expect(getSupportedReasoningEfforts(model)).toEqual([undefined, "low", "high", "max"]);
  });

  it("does not invent effort levels for toggle or budget reasoning", () => {
    const model = {
      capabilities: { reasoning: true },
      reasoningOptions: [{ type: "budget_tokens", min: 128, max: 32768 }],
    } as Model;
    expect(getSupportedReasoningEfforts(model)).toEqual([undefined]);
  });
});
