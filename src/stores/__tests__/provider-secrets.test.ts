import { describe, it, expect, beforeEach, vi } from "vitest";

// Node has no localStorage — install a memory stub before any module loads.
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

// Node environment resolves isDesktop=false, so secrets must remain in process
// memory and legacy plaintext localStorage entries must be removed.

function resetStorage() {
  localStorage.clear();
  vi.resetModules();
}

async function loadStore() {
  const { useProviderStore } = await import("../provider-store");
  return useProviderStore;
}

describe("provider secret persistence", () => {
  beforeEach(() => {
    resetStorage();
  });

  it("never persists apiKey in the providers blob", async () => {
    const store = await loadStore();
    await store.getState().addProvider({
      id: "p1",
      name: "OpenAI",
      type: "openai",
      apiFormat: "chat-completions",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-secret-123",
      customHeaders: [],
      enabled: true,
      status: "connected",
      createdAt: new Date().toISOString(),
    });

    const stored = JSON.parse(localStorage.getItem("talkio:providers") ?? "[]");
    expect(Array.isArray(stored)).toBe(true);
    expect(stored[0].apiKey).toBeUndefined();
    expect(stored[0].id).toBe("p1");
  });

  it("does not persist the secret in browser storage", async () => {
    const store = await loadStore();
    await store.getState().addProvider({
      id: "p1",
      name: "OpenAI",
      type: "openai",
      apiFormat: "chat-completions",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-secret-123",
      customHeaders: [],
      enabled: true,
      status: "connected",
      createdAt: new Date().toISOString(),
    });

    expect(localStorage.getItem("talkio:secret:p1")).toBeNull();
    expect(store.getState().getProviderById("p1")?.apiKey).toBe("sk-secret-123");
  });

  it("removes legacy browser secrets instead of hydrating them", async () => {
    localStorage.setItem(
      "talkio:providers",
      JSON.stringify([
        {
          id: "p1",
          name: "OpenAI",
          type: "openai",
          baseUrl: "https://api.openai.com/v1",
          customHeaders: [],
          enabled: true,
          status: "connected",
          createdAt: new Date().toISOString(),
        },
      ]),
    );
    localStorage.setItem("talkio:secret:p1", "sk-legacy");

    const store = await loadStore();
    await vi.waitFor(() => expect(localStorage.getItem("talkio:secret:p1")).toBeNull());
    expect(store.getState().getProviderById("p1")?.apiKey).toBe("");
  });

  it("migrates legacy blob keys into memory and strips the blob", async () => {
    localStorage.setItem(
      "talkio:providers",
      JSON.stringify([
        {
          id: "p1",
          name: "OpenAI",
          type: "openai",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-legacy",
          customHeaders: [],
          enabled: true,
          status: "connected",
          createdAt: new Date().toISOString(),
        },
      ]),
    );

    const store = await loadStore();
    await vi.waitFor(() => {
      expect(store.getState().getProviderById("p1")?.apiKey).toBe("sk-legacy");
    });
    const blob = JSON.parse(localStorage.getItem("talkio:providers") ?? "[]");
    expect(blob[0].apiKey).toBeUndefined();
    expect(localStorage.getItem("talkio:secret:p1")).toBeNull();
  });

  it("migrates the legacy global image configuration into a provider model", async () => {
    localStorage.setItem(
      "talkio:settings",
      JSON.stringify({
        imageBaseUrl: "https://images.example.com/v1",
        imageApiKey: "legacy-image-key",
        imageModel: "flux-image",
      }),
    );
    const store = await loadStore();
    store.getState().loadFromStorage();

    await vi.waitFor(() => expect(store.getState().providers).toHaveLength(1));
    const migratedProvider = store.getState().providers[0];
    const migratedModel = store.getState().models[0];
    expect(migratedProvider.baseUrl).toBe("https://images.example.com/v1");
    expect(migratedProvider.apiKey).toBe("legacy-image-key");
    expect(migratedModel).toMatchObject({
      providerId: migratedProvider.id,
      modelId: "flux-image",
      outputModalities: ["image"],
      imageGenerationApi: "openai-compatible",
      enabled: true,
    });

    const storedProvider = JSON.parse(localStorage.getItem("talkio:providers") ?? "[]")[0];
    const storedSettings = JSON.parse(localStorage.getItem("talkio:settings") ?? "{}");
    expect(storedProvider.apiKey).toBeUndefined();
    expect(storedSettings.imageApiKey).toBe("");
    expect(storedSettings.defaultImageModelId).toBe(migratedModel.id);
  });

  it("deletes the secret when the provider is removed", async () => {
    const store = await loadStore();
    await store.getState().addProvider({
      id: "p1",
      name: "OpenAI",
      type: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-secret-123",
      customHeaders: [],
      enabled: true,
      status: "connected",
      createdAt: new Date().toISOString(),
    });
    expect(store.getState().getProviderById("p1")?.apiKey).toBe("sk-secret-123");

    await store.getState().deleteProvider("p1");
    expect(store.getState().getProviderById("p1")).toBeUndefined();
  });

  it("clears the secret when updateProvider receives an empty apiKey", async () => {
    const store = await loadStore();
    await store.getState().addProvider({
      id: "p1",
      name: "OpenAI",
      type: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-secret-123",
      customHeaders: [],
      enabled: true,
      status: "connected",
      createdAt: new Date().toISOString(),
    });
    await store.getState().updateProvider("p1", { apiKey: "" });
    expect(localStorage.getItem("talkio:secret:p1")).toBeNull();
  });

  it("does not add a provider when secret persistence fails", async () => {
    const store = await loadStore();
    const { secretStore } = await import("../../services/secret-store");
    vi.spyOn(secretStore, "set").mockRejectedValueOnce(new Error("Keychain unavailable"));

    await expect(
      store.getState().addProvider({
        id: "p-fail",
        name: "OpenAI",
        type: "openai",
        apiFormat: "chat-completions",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-secret",
        customHeaders: [],
        enabled: true,
        status: "pending",
        createdAt: new Date().toISOString(),
      }),
    ).rejects.toThrow("Keychain unavailable");

    expect(store.getState().getProviderById("p-fail")).toBeUndefined();
    expect(JSON.parse(localStorage.getItem("talkio:providers") ?? "[]")).toEqual([]);
  });

  it("keeps existing provider data when secret update fails", async () => {
    const store = await loadStore();
    await store.getState().addProvider({
      id: "p1",
      name: "OpenAI",
      type: "openai",
      apiFormat: "chat-completions",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "old-secret",
      customHeaders: [],
      enabled: true,
      status: "connected",
      createdAt: new Date().toISOString(),
    });
    const { secretStore } = await import("../../services/secret-store");
    vi.spyOn(secretStore, "set").mockRejectedValueOnce(new Error("Keychain unavailable"));

    await expect(
      store.getState().updateProvider("p1", { name: "Changed", apiKey: "new-secret" }),
    ).rejects.toThrow("Keychain unavailable");
    expect(store.getState().getProviderById("p1")?.name).toBe("OpenAI");
  });
});
