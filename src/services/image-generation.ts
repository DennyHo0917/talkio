/**
 * Provider-backed image generation through the Vercel AI SDK.
 *
 * Image models are ordinary Talkio models with an explicit independent image
 * generation API. Multiple providers/models can coexist; callers may select
 * one by its stable model id or by the human-readable `provider/model` key.
 */
import { generateImage as generateImageWithSdk, type ImageModel } from "ai";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { appFetch } from "../lib/http";
import { useProviderStore } from "../stores/provider-store";
import { useSettingsStore } from "../stores/settings-store";
import type { Model, Provider } from "../types";
import { buildProviderHeaders } from "./provider-headers";

export interface AvailableImageModel {
  id: string;
  modelId: string;
  displayName: string;
  providerId: string;
  providerName: string;
  selectionKey: string;
}

interface ResolvedImageModel extends AvailableImageModel {
  model: Model;
  provider: Provider;
}

export interface GenerateImagesParams {
  prompt: string;
  model?: string;
  size?: string;
  aspectRatio?: string;
  n?: number;
  signal?: AbortSignal;
}

function authParts(headers: Record<string, string>): {
  apiKey?: string;
  headers: Record<string, string>;
} {
  const passthrough: Record<string, string> = {};
  let apiKey: string | undefined;
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === "authorization" && value.startsWith("Bearer ")) {
      apiKey = value.slice(7);
    } else if (lower === "x-api-key" || lower === "x-goog-api-key" || lower === "api-key") {
      apiKey ??= value;
    } else {
      passthrough[name] = value;
    }
  }
  return { apiKey, headers: passthrough };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function createSdkImageFetch(onMediaTypes: (mediaTypes: Array<string | undefined>) => void) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = await appFetch(input, init);
    if (!response.ok) return response;

    let payload: { data?: Array<{ b64_json?: string; url?: string }> };
    try {
      payload = await response.clone().json();
    } catch {
      return response;
    }
    if (!payload.data?.some((item) => item.url && !item.b64_json)) return response;

    const mediaTypes: Array<string | undefined> = [];
    const data = await Promise.all(
      payload.data.map(async (item, index) => {
        if (item.b64_json || !item.url) return item;
        const imageResponse = await appFetch(item.url, { signal: init?.signal });
        if (!imageResponse.ok) {
          throw new Error(`Cannot download generated image: HTTP ${imageResponse.status}`);
        }
        mediaTypes[index] = imageResponse.headers.get("content-type")?.split(";", 1)[0];
        return {
          ...item,
          url: undefined,
          b64_json: bytesToBase64(new Uint8Array(await imageResponse.arrayBuffer())),
        };
      }),
    );
    onMediaTypes(mediaTypes);

    const headers = new Headers(response.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    headers.set("content-type", "application/json");
    return new Response(JSON.stringify({ ...payload, data }), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

function resolvedImageModels(): ResolvedImageModel[] {
  const { providers, models } = useProviderStore.getState();
  const enabledProviders = new Map(
    providers
      .filter((provider) => provider.enabled !== false)
      .map((provider) => [provider.id, provider]),
  );

  return models.flatMap((model) => {
    const provider = enabledProviders.get(model.providerId);
    if (!provider || !model.enabled || !model.imageGenerationApi) return [];
    return [
      {
        id: model.id,
        modelId: model.modelId,
        displayName: model.displayName,
        providerId: provider.id,
        providerName: provider.name,
        selectionKey: `${provider.name}/${model.modelId}`,
        model,
        provider,
      },
    ];
  });
}

export function getAvailableImageModels(): AvailableImageModel[] {
  return resolvedImageModels().map(({ model: _model, provider: _provider, ...item }) => item);
}

export function isImageGenerationConfigured(): boolean {
  return resolvedImageModels().length > 0;
}

export function getDefaultImageModel(): AvailableImageModel | undefined {
  const available = resolvedImageModels();
  const defaultId = useSettingsStore.getState().settings.defaultImageModelId;
  const selected = available.find((item) => item.id === defaultId) ?? available[0];
  if (!selected) return undefined;
  const { model: _model, provider: _provider, ...item } = selected;
  return item;
}

function resolveConfiguredModel(selection?: string): ResolvedImageModel {
  const available = resolvedImageModels();
  if (available.length === 0) throw new Error("No enabled image generation model is configured");

  if (selection) {
    const exact = available.find(
      (item) => item.id === selection || item.selectionKey === selection,
    );
    if (exact) return exact;

    const byModelId = available.filter((item) => item.modelId === selection);
    if (byModelId.length === 1) return byModelId[0];
    if (byModelId.length > 1) {
      throw new Error(`Image model '${selection}' is ambiguous; specify provider/model`);
    }
    throw new Error(`Image model '${selection}' is not enabled or does not support image output`);
  }

  const defaultId = useSettingsStore.getState().settings.defaultImageModelId;
  return available.find((item) => item.id === defaultId) ?? available[0];
}

function createImageModel(
  provider: Provider,
  model: Model,
  fetch: typeof globalThis.fetch,
): ImageModel {
  const baseURL = provider.baseUrl.replace(/\/+$/, "");
  const auth = authParts(buildProviderHeaders(provider));

  if (model.imageGenerationApi === "google") {
    return createGoogle({ baseURL, apiKey: auth.apiKey, headers: auth.headers, fetch }).image(
      model.modelId,
    );
  }
  if (model.imageGenerationApi === "openai") {
    return createOpenAI({ baseURL, apiKey: auth.apiKey, headers: auth.headers, fetch }).imageModel(
      model.modelId,
    );
  }
  if (model.imageGenerationApi !== "openai-compatible") {
    throw new Error(`Model '${model.modelId}' does not expose a supported image generation API`);
  }
  return createOpenAICompatible({
    name: "openai-compatible",
    baseURL,
    apiKey: auth.apiKey,
    headers: auth.headers,
    fetch,
  }).imageModel(model.modelId);
}

function imageSize(value?: string): `${number}x${number}` | undefined {
  if (!value) return undefined;
  if (!/^\d+x\d+$/.test(value)) throw new Error(`Invalid image size '${value}'`);
  return value as `${number}x${number}`;
}

function imageAspectRatio(value?: string): `${number}:${number}` | undefined {
  if (!value) return undefined;
  if (!/^\d+:\d+$/.test(value)) throw new Error(`Invalid image aspect ratio '${value}'`);
  return value as `${number}:${number}`;
}

export async function generateImages(params: GenerateImagesParams): Promise<string[]> {
  const selected = resolveConfiguredModel(params.model);
  let normalizedMediaTypes: Array<string | undefined> = [];
  const fetch = createSdkImageFetch((mediaTypes) => {
    normalizedMediaTypes = mediaTypes;
  }) as typeof globalThis.fetch;
  const result = await generateImageWithSdk({
    model: createImageModel(selected.provider, selected.model, fetch),
    prompt: params.prompt,
    n: params.n,
    size: imageSize(params.size),
    aspectRatio: imageAspectRatio(params.aspectRatio),
    abortSignal: params.signal,
  });

  if (result.images.length === 0) throw new Error("Image API returned no images");
  return result.images.map(
    (image, index) =>
      `data:${normalizedMediaTypes[index] || image.mediaType || "image/png"};base64,${image.base64}`,
  );
}
