/**
 * Offline model metadata catalog generated from models.dev.
 *
 * Resolution order:
 *   1. provider-scoped user override
 *   2. exact provider/model match
 *   3. exact model id match in a canonical provider
 *   4. conservative normalized match in a canonical provider
 *
 * Network access only happens in scripts/sync-models-dev.mjs. Runtime lookup
 * always uses the checked-in snapshot so startup and model selection work offline.
 */
import { kvStore } from "../../storage/kv-store";
import type { ReasoningOption } from "../../types";
import snapshotJson from "./models-dev.generated.json";
import type { ModelDescriptor, ResolvedModelDescriptor } from "./types";

export const MODEL_CATALOG_VERSION = 1;
const OVERRIDES_KEY = "model-catalog-overrides";
const DEFAULT_PROFILE_ID = "global";

const PROFILE_PROVIDER_ALIASES: Record<string, string> = {
  "azure-openai": "openai",
  fireworks: "fireworks-ai",
  gemini: "google",
  together: "togetherai",
};

const CANONICAL_PROVIDER_IDS = new Set([
  "alibaba",
  "anthropic",
  "cohere",
  "deepseek",
  "google",
  "meta",
  "minimax",
  "minimax-cn",
  "mistral",
  "moonshotai",
  "moonshotai-cn",
  "nvidia",
  "openai",
  "perplexity",
  "xai",
  "zai",
  "zhipuai",
]);

const FAMILY_PROVIDER_HINTS: Array<[RegExp, string[]]> = [
  [/^(?:chatgpt-|gpt-|o\d)/, ["openai"]],
  [/^claude-/, ["anthropic"]],
  [/^(?:gemini-|gemma-)/, ["google"]],
  [/^deepseek-/, ["deepseek"]],
  [/^grok-/, ["xai"]],
  [/^(?:mistral-|codestral-)/, ["mistral"]],
  [/^command-/, ["cohere"]],
  [/^llama-/, ["meta"]],
  [/^(?:qwen|qwq)/, ["alibaba"]],
  [/^kimi-/, ["moonshotai", "moonshotai-cn"]],
  [/^minimax-/, ["minimax", "minimax-cn"]],
  [/^glm-/, ["zai", "zhipuai"]],
];

type ModelsDevModel = {
  name?: string;
  input: string[];
  output: string[];
  context?: number;
  maxOutput?: number;
  reasoning: boolean;
  reasoningOptions: ReasoningOption[];
  tools: boolean;
  interleavedField?: string;
};

type ModelsDevSnapshot = {
  schemaVersion: number;
  source: string;
  providers: Record<string, Record<string, ModelsDevModel>>;
};

type CatalogEntry = {
  providerId: string;
  modelId: string;
  model: ModelsDevModel;
};

const snapshot = snapshotJson as ModelsDevSnapshot;
if (snapshot.schemaVersion !== 1) {
  throw new Error(`Unsupported models.dev snapshot schema: ${snapshot.schemaVersion}`);
}

const catalogEntries: CatalogEntry[] = Object.entries(snapshot.providers).flatMap(
  ([providerId, models]) =>
    Object.entries(models).map(([modelId, model]) => ({ providerId, modelId, model })),
);

const exactIndex = buildIndex((entry) => entry.modelId.toLowerCase());
const normalizedIndex = buildIndex((entry) => normalizeModelId(entry.modelId));

export interface ModelCatalogState {
  version: number;
  overrides: Record<string, Partial<ModelDescriptor>>;
}

function overrideKey(providerProfileId: string, modelId: string): string {
  return `${providerProfileId}:${modelId}`;
}

function catalogProviderId(providerProfileId: string): string {
  return PROFILE_PROVIDER_ALIASES[providerProfileId] ?? providerProfileId;
}

function normalizeModelId(modelId: string): string {
  const withoutModelsPrefix = modelId
    .trim()
    .replace(/^models\//i, "")
    .replace(/^~/, "");
  const basename = withoutModelsPrefix.split("/").at(-1) ?? withoutModelsPrefix;
  let normalized = basename.toLowerCase().replace(/:\d{4,8}$/, "");
  const gatewayOptionSuffix =
    /-(?:extra-low|non-reasoning|reasoning|thinking|minimal|low|medium|high|xhigh|max|fast|agent)$/;
  while (gatewayOptionSuffix.test(normalized)) {
    normalized = normalized.replace(gatewayOptionSuffix, "");
  }
  return normalized;
}

function buildIndex(keyOf: (entry: CatalogEntry) => string): Map<string, CatalogEntry[]> {
  const index = new Map<string, CatalogEntry[]>();
  for (const entry of catalogEntries) {
    const key = keyOf(entry);
    const matches = index.get(key);
    if (matches) matches.push(entry);
    else index.set(key, [entry]);
  }
  return index;
}

function inputModalities(values: string[]): ModelDescriptor["inputModalities"] {
  const mapped = values.map((value) => (value === "pdf" ? "file" : value));
  return [...new Set(mapped)].filter(
    (value): value is ModelDescriptor["inputModalities"][number] =>
      value === "text" ||
      value === "image" ||
      value === "audio" ||
      value === "video" ||
      value === "file",
  );
}

function outputModalities(values: string[]): ModelDescriptor["outputModalities"] {
  return [...new Set(values)].filter(
    (value): value is ModelDescriptor["outputModalities"][number] =>
      value === "text" || value === "image" || value === "audio",
  );
}

function entryToDescriptor(entry: CatalogEntry): ModelDescriptor {
  return {
    modelId: entry.modelId,
    displayName: entry.model.name ?? entry.modelId,
    inputModalities: inputModalities(entry.model.input),
    outputModalities: outputModalities(entry.model.output),
    contextWindow: entry.model.context,
    maxOutputTokens: entry.model.maxOutput,
    reasoningOptions: entry.model.reasoningOptions,
    interleavedReasoningField: entry.model.interleavedField,
    capabilities: {
      reasoning: entry.model.reasoning,
      tools: entry.model.tools,
    },
  };
}

function inferredProviderIds(modelId: string): string[] {
  const normalized = normalizeModelId(modelId);
  return FAMILY_PROVIDER_HINTS.find(([pattern]) => pattern.test(normalized))?.[1] ?? [];
}

function descriptorFingerprint(entry: CatalogEntry): string {
  const model = entry.model;
  return JSON.stringify({
    input: model.input,
    output: model.output,
    context: model.context,
    maxOutput: model.maxOutput,
    reasoning: model.reasoning,
    reasoningOptions: model.reasoningOptions,
    tools: model.tools,
  });
}

function chooseGlobalMatch(modelId: string, candidates: CatalogEntry[]): CatalogEntry | undefined {
  if (candidates.length === 0) return undefined;

  const providerHints = inferredProviderIds(modelId);
  for (const providerId of providerHints) {
    const hinted = candidates.find((candidate) => candidate.providerId === providerId);
    if (hinted) return hinted;
  }

  const canonical = candidates.filter((candidate) =>
    CANONICAL_PROVIDER_IDS.has(candidate.providerId),
  );
  if (canonical.length === 1) return canonical[0];
  if (canonical.length === 0) return undefined;

  const fingerprints = new Set(canonical.map(descriptorFingerprint));
  return fingerprints.size === 1 ? canonical[0] : undefined;
}

function findCatalogEntry(
  providerProfileId: string,
  modelId: string,
): { entry: CatalogEntry; match: "exact" | "normalized" } | undefined {
  const providerId = catalogProviderId(providerProfileId);
  const providerModels = snapshot.providers[providerId];
  const direct = providerModels?.[modelId];
  if (direct) return { entry: { providerId, modelId, model: direct }, match: "exact" };

  const caseInsensitiveDirect = providerModels
    ? Object.entries(providerModels).find(
        ([candidateId]) => candidateId.toLowerCase() === modelId.toLowerCase(),
      )
    : undefined;
  if (caseInsensitiveDirect) {
    return {
      entry: { providerId, modelId: caseInsensitiveDirect[0], model: caseInsensitiveDirect[1] },
      match: "exact",
    };
  }

  const exact = chooseGlobalMatch(modelId, exactIndex.get(modelId.toLowerCase()) ?? []);
  if (exact) return { entry: exact, match: "exact" };

  const normalized = chooseGlobalMatch(
    modelId,
    normalizedIndex.get(normalizeModelId(modelId)) ?? [],
  );
  return normalized ? { entry: normalized, match: "normalized" } : undefined;
}

function loadOverrides(): Record<string, Partial<ModelDescriptor>> {
  const raw = kvStore.getObject<ModelCatalogState>(OVERRIDES_KEY);
  if (!raw || raw.version !== MODEL_CATALOG_VERSION) return {};
  return raw.overrides ?? {};
}

function persistOverrides(overrides: Record<string, Partial<ModelDescriptor>>): void {
  kvStore.setObject(OVERRIDES_KEY, {
    version: MODEL_CATALOG_VERSION,
    overrides,
  } satisfies ModelCatalogState);
}

function mergeDescriptor(
  base: ModelDescriptor | undefined,
  modelId: string,
  override: Partial<ModelDescriptor>,
): ModelDescriptor {
  return {
    modelId,
    displayName: modelId,
    inputModalities: ["text"],
    outputModalities: ["text"],
    ...base,
    ...override,
    capabilities:
      base?.capabilities || override.capabilities
        ? { ...base?.capabilities, ...override.capabilities }
        : undefined,
    providerOptions:
      base?.providerOptions || override.providerOptions
        ? { ...base?.providerOptions, ...override.providerOptions }
        : undefined,
  };
}

/** Resolve metadata for a provider/model pair. */
export function resolveModelDescriptor(
  providerProfileId: string,
  modelId?: string,
): ResolvedModelDescriptor | undefined {
  const resolvedModelId = modelId ?? providerProfileId;
  const resolvedProfileId = modelId ? providerProfileId : DEFAULT_PROFILE_ID;
  const overrides = loadOverrides();
  const override = overrides[overrideKey(resolvedProfileId, resolvedModelId)];
  const match = findCatalogEntry(resolvedProfileId, resolvedModelId);
  const base = match ? entryToDescriptor(match.entry) : undefined;
  if (!base && !override) return undefined;

  return {
    ...mergeDescriptor(base, resolvedModelId, override ?? {}),
    metadataSource: override ? "manual" : "models.dev",
    metadataMatch: match?.match,
    metadataProviderId: match?.entry.providerId,
  };
}

/** All catalog entries for one provider profile, including override-only models. */
export function getAllModelDescriptors(
  providerProfileId: string = DEFAULT_PROFILE_ID,
): ResolvedModelDescriptor[] {
  const overrides = loadOverrides();
  const providerId = catalogProviderId(providerProfileId);
  const providerModels = snapshot.providers[providerId] ?? {};
  const merged: ResolvedModelDescriptor[] = Object.entries(providerModels).map(
    ([modelId, model]) => {
      const override = overrides[overrideKey(providerProfileId, modelId)];
      return {
        ...mergeDescriptor(
          entryToDescriptor({ providerId, modelId, model }),
          modelId,
          override ?? {},
        ),
        metadataSource: override ? ("manual" as const) : ("models.dev" as const),
        metadataMatch: "exact" as const,
        metadataProviderId: providerId,
      };
    },
  );

  const builtInIds = new Set(Object.keys(providerModels));
  const prefix = `${providerProfileId}:`;
  for (const [key, override] of Object.entries(overrides)) {
    if (!key.startsWith(prefix)) continue;
    const modelId = key.slice(prefix.length);
    if (builtInIds.has(modelId)) continue;
    merged.push({
      ...mergeDescriptor(undefined, modelId, override),
      metadataSource: "manual",
      metadataMatch: undefined,
      metadataProviderId: undefined,
    });
  }
  return merged;
}

/** Upsert a provider-scoped model override; an empty patch removes it. */
export function setModelOverride(
  providerProfileId: string,
  modelId: string,
  patch: Partial<ModelDescriptor>,
): void {
  const overrides = loadOverrides();
  const key = overrideKey(providerProfileId, modelId);
  if (Object.keys(patch).length === 0) delete overrides[key];
  else overrides[key] = patch;
  persistOverrides(overrides);
}

export function resetModelOverrides(): void {
  kvStore.delete(OVERRIDES_KEY);
}
