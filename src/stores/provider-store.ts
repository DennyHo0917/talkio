/**
 * Provider Store — manages AI providers and models.
 * Uses localStorage for persistence (replaces react-native-mmkv).
 */
import { create } from "zustand";
import type {
  Provider,
  Model,
  ModelCapabilities,
  ModelMetadataMatch,
  ModelMetadataSource,
  ReasoningOption,
  ModelInputModality,
  ModelOutputModality,
  ImageGenerationApi,
} from "../types";
import { kvStore } from "../storage/kv-store";
import { secretStore } from "../services/secret-store";
import { generateId } from "../lib/id";
import {
  createModelFromProviderPayload,
  fetchProviderModels,
  probeProviderModelCapabilities,
  testProviderConnection,
  checkModelHealth,
} from "../services/provider-service";
import {
  resolveModelDescriptor,
  setModelOverride,
} from "../services/provider-profiles/model-catalog";
import { useSettingsStore } from "./settings-store";
import { inferImageGenerationApi } from "../services/image-model";
import { z } from "zod";

const PROVIDERS_KEY = "providers";
const MODELS_KEY = "models";

const persistedProviderSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    type: z.enum(["openai", "anthropic", "gemini", "azure-openai"]),
    apiFormat: z
      .enum(["chat-completions", "responses", "anthropic-messages", "gemini-generate-content"])
      .optional(),
    profileId: z.string().optional(),
    baseUrl: z.string().min(1),
    apiKey: z.string().optional().default(""),
    apiVersion: z.string().optional(),
    customHeaders: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
    enabled: z.boolean().default(true),
    status: z.enum(["connected", "disconnected", "error", "pending"]).default("pending"),
    createdAt: z.string(),
  })
  .passthrough();

const persistedModelSchema = z
  .object({
    id: z.string().min(1),
    providerId: z.string().min(1),
    modelId: z.string().min(1),
  })
  .passthrough();

function readPersistedProviders(): Provider[] {
  const raw = kvStore.getObject<unknown>(PROVIDERS_KEY);
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value) => {
    const result = persistedProviderSchema.safeParse(value);
    return result.success ? [result.data as Provider] : [];
  });
}

function readPersistedModels(): unknown[] {
  const raw = kvStore.getObject<unknown>(MODELS_KEY);
  if (!Array.isArray(raw)) return [];
  return raw.filter((value) => persistedModelSchema.safeParse(value).success);
}

interface ProviderState {
  providers: Provider[];
  models: Model[];

  // Lookups
  getProviderById: (id: string) => Provider | undefined;
  getModelById: (id: string) => Model | undefined;
  getModelsByProvider: (providerId: string) => Model[];
  getEnabledModels: () => Model[];
  getEnabledConversationModels: () => Model[];

  // Actions
  addProvider: (provider: Provider) => Promise<void>;
  updateProvider: (id: string, updates: Partial<Provider>) => Promise<void>;
  deleteProvider: (id: string) => Promise<void>;
  addModel: (model: Model) => void;
  addModelById: (providerId: string, modelId: string) => Model;
  updateModel: (id: string, updates: Partial<Model>) => void;
  toggleModel: (id: string) => void;
  setProviderModelsEnabled: (providerId: string, enabled: boolean) => void;
  updateModelCapabilities: (id: string, caps: Partial<ModelCapabilities>) => void;
  deleteModel: (id: string) => void;
  setModels: (models: Model[]) => void;
  loadFromStorage: () => void;
  fetchModels: (providerId: string) => Promise<Model[]>;
  testConnection: (providerId: string) => Promise<boolean>;
  probeModelCapabilities: (modelId: string) => Promise<{ warnings: string[] }>;
  checkModelHealth: (modelId: string) => Promise<{ ok: boolean; error?: string }>;
}

/**
 * Strip API keys before persisting — keys live in the OS credential store
 * (desktop) or the secret KV namespace (fallback), never in the providers blob.
 */
function stripSecrets(providers: Provider[]): Provider[] {
  return providers.map(({ apiKey: _apiKey, ...rest }) => rest as Provider);
}

function persistProviders(providers: Provider[]) {
  kvStore.setObject(PROVIDERS_KEY, stripSecrets(providers));
}

function persistModels(models: Model[]) {
  kvStore.setObject(MODELS_KEY, models);
}

async function migrateLegacyImageConfig(
  providers: Provider[],
  models: Model[],
): Promise<{ providers: Provider[]; models: Model[]; defaultImageModelId?: string }> {
  const settings = useSettingsStore.getState().settings;
  const baseUrl = settings.imageBaseUrl?.trim();
  const apiKey = settings.imageApiKey?.trim();
  const legacyModelId = settings.imageModel?.trim();
  if (!baseUrl || !apiKey || !legacyModelId) return { providers, models };

  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  let provider = providers.find(
    (item) => item.enabled !== false && item.baseUrl.replace(/\/+$/, "") === normalizedBaseUrl,
  );
  if (provider) {
    const existingKey = provider.apiKey || (await secretStore.get(provider.id));
    if (existingKey && existingKey !== apiKey) provider = undefined;
  }

  let nextProviders = providers;
  if (!provider) {
    const host = (() => {
      try {
        return new URL(normalizedBaseUrl).hostname;
      } catch {
        return normalizedBaseUrl;
      }
    })();
    const officialOpenAI = normalizedBaseUrl === "https://api.openai.com/v1";
    provider = {
      id: generateId(),
      name: `Image · ${host}`,
      type: "openai",
      apiFormat: officialOpenAI ? "responses" : "chat-completions",
      profileId: officialOpenAI ? "openai" : undefined,
      baseUrl: normalizedBaseUrl,
      apiKey,
      customHeaders: [],
      enabled: true,
      status: "connected",
      createdAt: new Date().toISOString(),
    };
    nextProviders = [...providers, provider];
  } else {
    provider = { ...provider, apiKey };
    nextProviders = providers.map((item) => (item.id === provider!.id ? provider! : item));
  }
  await secretStore.set(provider.id, apiKey);

  const existingModel = models.find(
    (model) => model.providerId === provider.id && model.modelId === legacyModelId,
  );
  const imageModel: Model = existingModel
    ? {
        ...existingModel,
        outputModalities: [...new Set([...existingModel.outputModalities, "image" as const])],
        imageGenerationApi:
          inferImageGenerationApi(provider, [
            ...new Set([...existingModel.outputModalities, "image" as const]),
          ]) ?? "openai-compatible",
        enabled: true,
      }
    : {
        id: generateId(),
        providerId: provider.id,
        modelId: legacyModelId,
        displayName: legacyModelId,
        avatar: null,
        capabilities: { vision: false, toolCall: false, reasoning: false, streaming: false },
        inputModalities: ["text"],
        outputModalities: ["image"],
        imageGenerationApi: inferImageGenerationApi(provider, ["image"]) ?? "openai-compatible",
        capabilitiesVerified: true,
        maxContextLength: 0,
        metadataSource: "manual",
        enabled: true,
      };
  const nextModels = existingModel
    ? models.map((model) => (model.id === existingModel.id ? imageModel : model))
    : [...models, imageModel];
  setModelOverride(provider.profileId ?? provider.id, legacyModelId, {
    inputModalities: imageModel.inputModalities,
    outputModalities: imageModel.outputModalities,
  });

  return { providers: nextProviders, models: nextModels, defaultImageModelId: imageModel.id };
}

function normalizeModel(m: any): Model {
  const legacyCaps = m.capabilities ?? {};
  const caps: ModelCapabilities = {
    vision: !!legacyCaps.vision,
    toolCall: !!(legacyCaps.toolCall ?? legacyCaps.toolUse),
    reasoning: !!legacyCaps.reasoning,
    streaming: legacyCaps.streaming !== false,
  };
  const inputModalities = Array.isArray(m.inputModalities)
    ? m.inputModalities.filter(isInputModality)
    : ["text", ...(caps.vision ? (["image"] as const) : [])];
  const outputModalities = Array.isArray(m.outputModalities)
    ? m.outputModalities.filter(isOutputModality)
    : ["text"];
  return {
    id: String(m.id),
    providerId: String(m.providerId),
    modelId: String(m.modelId),
    displayName: String(m.displayName ?? m.modelId),
    avatar: m.avatar ?? null,
    capabilities: caps,
    probedCapabilities: normalizeProbedCapabilities(m.probedCapabilities),
    inputModalities,
    outputModalities,
    imageGenerationApi: isImageGenerationApi(m.imageGenerationApi)
      ? m.imageGenerationApi
      : undefined,
    capabilitiesVerified: !!m.capabilitiesVerified,
    maxContextLength: typeof m.maxContextLength === "number" ? m.maxContextLength : 128000,
    maxOutputTokens: typeof m.maxOutputTokens === "number" ? m.maxOutputTokens : undefined,
    reasoningOptions: Array.isArray(m.reasoningOptions)
      ? (m.reasoningOptions as ReasoningOption[])
      : undefined,
    metadataSource: isMetadataSource(m.metadataSource) ? m.metadataSource : undefined,
    metadataMatch: isMetadataMatch(m.metadataMatch) ? m.metadataMatch : undefined,
    metadataProviderId: typeof m.metadataProviderId === "string" ? m.metadataProviderId : undefined,
    enabled: m.enabled !== false,
  } as Model;
}

function normalizeProbedCapabilities(value: unknown): Partial<ModelCapabilities> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: Partial<ModelCapabilities> = {};
  for (const key of ["vision", "toolCall", "reasoning", "streaming"] as const) {
    const field = (value as Record<string, unknown>)[key];
    if (typeof field === "boolean") result[key] = field;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function isInputModality(value: unknown): value is ModelInputModality {
  return (
    value === "text" ||
    value === "image" ||
    value === "audio" ||
    value === "video" ||
    value === "file"
  );
}

function isOutputModality(value: unknown): value is ModelOutputModality {
  return value === "text" || value === "image" || value === "audio";
}

function isImageGenerationApi(value: unknown): value is ImageGenerationApi {
  return value === "openai" || value === "openai-compatible" || value === "google";
}

function isMetadataSource(value: unknown): value is ModelMetadataSource {
  return (
    value === "manual" ||
    value === "models.dev" ||
    value === "provider" ||
    value === "probe" ||
    value === "default"
  );
}

function isMetadataMatch(value: unknown): value is ModelMetadataMatch {
  return value === "exact" || value === "normalized";
}

function applyCatalogMetadata(
  model: Model,
  provider: Provider,
  providerContextLength?: number,
): Model {
  const descriptor = resolveModelDescriptor(provider.profileId ?? provider.id, model.modelId);
  if (!descriptor) {
    const next = providerContextLength
      ? { ...model, maxContextLength: providerContextLength, metadataSource: "provider" as const }
      : model;
    return {
      ...next,
      imageGenerationApi: inferImageGenerationApi(provider, next.outputModalities),
    };
  }

  const manual = descriptor.metadataSource === "manual";

  return {
    ...model,
    displayName: descriptor.displayName || model.displayName,
    maxContextLength: manual
      ? (descriptor.contextWindow ?? providerContextLength ?? model.maxContextLength)
      : (providerContextLength ?? descriptor.contextWindow ?? model.maxContextLength),
    maxOutputTokens: descriptor.maxOutputTokens ?? model.maxOutputTokens,
    reasoningOptions: descriptor.reasoningOptions ?? model.reasoningOptions,
    inputModalities: descriptor.inputModalities,
    outputModalities: descriptor.outputModalities,
    imageGenerationApi: inferImageGenerationApi(provider, descriptor.outputModalities),
    capabilities: {
      ...(descriptor.capabilities
        ? {
            vision: descriptor.inputModalities.includes("image"),
            toolCall: descriptor.capabilities.tools === true,
            reasoning: descriptor.capabilities.reasoning === true,
            streaming: descriptor.capabilities.streaming ?? model.capabilities.streaming,
          }
        : model.capabilities),
      ...model.probedCapabilities,
    },
    capabilitiesVerified: descriptor.capabilities ? true : model.capabilitiesVerified,
    metadataSource: descriptor.metadataSource,
    metadataMatch: descriptor.metadataMatch,
    metadataProviderId: descriptor.metadataProviderId,
  };
}

/**
 * Load secrets into the in-memory Provider objects.
 * Also migrates legacy plaintext keys (pre-P0 builds stored apiKey in the
 * providers blob): they are moved into the secret store and the blob is
 * rewritten without them.
 */
async function hydrateProviderSecrets(providers: Provider[]): Promise<Provider[]> {
  let migrated = false;
  for (const p of providers) {
    if (p.apiKey) {
      await secretStore.set(p.id, p.apiKey);
      migrated = true;
    }
  }
  if (migrated) persistProviders(providers);

  // Only read the OS credential store for enabled providers — disabled ones
  // aren't usable, so warming their keys just triggers extra keychain prompts
  // (especially painful on unsigned dev builds). Re-enabling warms on demand
  // (see updateProvider).
  return Promise.all(
    providers.map(async (p) => ({
      ...p,
      apiKey: p.enabled === false ? "" : ((await secretStore.get(p.id)) ?? ""),
    })),
  );
}

function loadInitial() {
  const providers = readPersistedProviders();
  const rawModels = readPersistedModels();
  const models: Model[] = rawModels.map(normalizeModel).map((model) => {
    const provider = providers.find((item) => item.id === model.providerId);
    return provider ? applyCatalogMetadata(model, provider) : model;
  });
  return { providers, models };
}

export const useProviderStore = create<ProviderState>((set, get) => {
  const initial = loadInitial();

  // Hydrate API keys from the secret store asynchronously after creation.
  queueMicrotask(() => {
    void hydrateProviderSecrets(initial.providers).then((hydrated) => {
      set({ providers: hydrated });
    });
  });

  return {
    ...initial,

    getProviderById: (id) => get().providers.find((p) => p.id === id),
    getModelById: (id) => get().models.find((m) => m.id === id),
    getModelsByProvider: (providerId) => get().models.filter((m) => m.providerId === providerId),
    getEnabledModels: () => {
      const enabledProviderIds = new Set(
        get()
          .providers.filter((p) => p.enabled !== false)
          .map((p) => p.id),
      );
      return get().models.filter(
        (m) =>
          m.enabled && enabledProviderIds.has(m.providerId) && m.outputModalities.includes("text"),
      );
    },
    getEnabledConversationModels: () => {
      const enabledProviderIds = new Set(
        get()
          .providers.filter((provider) => provider.enabled !== false)
          .map((provider) => provider.id),
      );
      return get().models.filter(
        (model) =>
          model.enabled &&
          enabledProviderIds.has(model.providerId) &&
          model.outputModalities.some((modality) => modality === "text" || modality === "image"),
      );
    },

    addProvider: async (provider) => {
      await secretStore.set(provider.id, provider.apiKey);
      set((s) => {
        const providers = [...s.providers, provider];
        persistProviders(providers);
        return { providers };
      });
    },

    updateProvider: async (id, updates) => {
      if (updates.apiKey !== undefined) {
        await secretStore.set(id, updates.apiKey ?? "");
      }
      // Warm the key on (re)enable so chat works without a restart — startup
      // hydration skips disabled providers.
      let warmedKey: string | undefined;
      if (updates.enabled === true && updates.apiKey === undefined) {
        const existing = get().providers.find((p) => p.id === id);
        if (existing && !existing.apiKey) warmedKey = (await secretStore.get(id)) ?? "";
      }
      set((s) => {
        const providers = s.providers.map((p) =>
          p.id === id
            ? { ...p, ...updates, ...(warmedKey !== undefined ? { apiKey: warmedKey } : {}) }
            : p,
        );
        persistProviders(providers);
        return { providers };
      });
    },

    deleteProvider: async (id) => {
      await secretStore.delete(id);
      set((s) => {
        const providers = s.providers.filter((p) => p.id !== id);
        const models = s.models.filter((m) => m.providerId !== id);
        persistProviders(providers);
        persistModels(models);
        return { providers, models };
      });
    },

    addModel: (model) => {
      set((s) => {
        const models = [...s.models, model];
        persistModels(models);
        return { models };
      });
    },

    addModelById: (providerId, modelId) => {
      const existing = get().models.find(
        (m) => m.providerId === providerId && m.modelId === modelId,
      );
      if (existing) return existing;

      const baseModel: Model = {
        id: generateId(),
        providerId,
        modelId,
        displayName: modelId,
        avatar: null,
        capabilities: {
          vision: false,
          toolCall: false,
          reasoning: false,
          streaming: true,
        },
        inputModalities: ["text"],
        outputModalities: ["text"],
        capabilitiesVerified: false,
        maxContextLength: 128000,
        metadataSource: "default",
        enabled: true,
      };

      const provider = get().providers.find((item) => item.id === providerId);
      const model = provider ? applyCatalogMetadata(baseModel, provider) : baseModel;

      get().addModel(model);
      return model;
    },

    updateModel: (id, updates) => {
      set((s) => {
        const models = s.models.map((m) => (m.id === id ? { ...m, ...updates } : m));
        persistModels(models);
        return { models };
      });
    },

    toggleModel: (id) => {
      const m = get().getModelById(id);
      if (!m) return;
      get().updateModel(id, { enabled: !m.enabled });
    },

    setProviderModelsEnabled: (providerId, enabled) => {
      set((s) => {
        const models = s.models.map((m) => (m.providerId === providerId ? { ...m, enabled } : m));
        persistModels(models);
        return { models };
      });
    },

    updateModelCapabilities: (id, caps) => {
      const m = get().getModelById(id);
      if (!m) return;
      get().updateModel(id, {
        capabilities: { ...m.capabilities, ...caps },
        probedCapabilities: { ...m.probedCapabilities, ...caps },
        capabilitiesVerified: true,
      });
    },

    deleteModel: (id) => {
      set((s) => {
        const models = s.models.filter((m) => m.id !== id);
        persistModels(models);
        return { models };
      });
    },

    setModels: (models) => {
      set({ models });
      persistModels(models);
    },

    loadFromStorage: () => {
      const providers = readPersistedProviders();
      const rawModels = readPersistedModels();
      const models: Model[] = rawModels.map(normalizeModel).map((model) => {
        const provider = providers.find((item) => item.id === model.providerId);
        return provider ? applyCatalogMetadata(model, provider) : model;
      });
      set({ providers, models });
      persistModels(models);
      void (async () => {
        let nextProviders = providers;
        let nextModels = models;
        try {
          const migrated = await migrateLegacyImageConfig(providers, models);
          nextProviders = migrated.providers;
          nextModels = migrated.models;
          if (migrated.defaultImageModelId) {
            persistProviders(nextProviders);
            persistModels(nextModels);
            useSettingsStore.getState().updateSettings({
              defaultImageModelId: migrated.defaultImageModelId,
              imageBaseUrl: "",
              imageApiKey: "",
              imageModel: "",
            });
          }
        } catch (error) {
          console.error("[provider-store] legacy image configuration migration failed", error);
        }
        const hydrated = await hydrateProviderSecrets(nextProviders);
        set({ providers: hydrated, models: nextModels });
      })();
    },

    fetchModels: async (providerId: string) => {
      const provider = get().providers.find((p) => p.id === providerId);
      if (!provider) return [];

      const modelList = await fetchProviderModels(provider);

      // Anthropic has no /models endpoint — keep existing models intact
      if (modelList.length === 0) {
        await get().updateProvider(providerId, { status: "connected" });
        return get().models.filter((m) => m.providerId === providerId);
      }

      const existingOther = get().models.filter((m) => m.providerId !== providerId);
      const existingForProvider = get().models.filter((m) => m.providerId === providerId);

      const newModels: Model[] = modelList.map((payload) => {
        const existing = existingForProvider.find((model) => model.modelId === payload.id);
        const model = createModelFromProviderPayload(
          existing?.id ?? generateId(),
          providerId,
          payload.id,
          existing,
          payload.context_length ?? 128000,
        );
        return applyCatalogMetadata(model, provider, payload.context_length);
      });

      const allModels = [...existingOther, ...newModels];
      set({ models: allModels });
      persistModels(allModels);
      await get().updateProvider(providerId, { status: "connected" });

      return newModels;
    },

    testConnection: async (providerId: string) => {
      const provider = get().providers.find((p) => p.id === providerId);
      if (!provider) return false;

      try {
        const ok = await testProviderConnection(provider);
        await get().updateProvider(providerId, { status: ok ? "connected" : "error" });
        return ok;
      } catch {
        await get().updateProvider(providerId, { status: "error" });
        return false;
      }
    },

    probeModelCapabilities: async (modelId: string) => {
      const model = get().getModelById(modelId);
      if (!model) throw new Error("Model not found");
      const provider = get().getProviderById(model.providerId);
      if (!provider) throw new Error("Provider not found");

      const result = await probeProviderModelCapabilities(provider, model.modelId);
      if (Object.keys(result.capabilities).length === 0) {
        throw new Error(result.warnings.join("; ") || "Capability probe returned no results");
      }
      get().updateModelCapabilities(modelId, result.capabilities);
      if (model.metadataSource === "default" || !model.metadataSource) {
        get().updateModel(modelId, { metadataSource: "probe" });
      }
      return { warnings: result.warnings };
    },

    checkModelHealth: async (modelId: string) => {
      const model = get().getModelById(modelId);
      if (!model) return { ok: false, error: "Model not found" };
      const provider = get().getProviderById(model.providerId);
      if (!provider) return { ok: false, error: "Provider not found" };
      return checkModelHealth(provider, model.modelId);
    },
  };
});
