import type { Provider } from "../types";
import { getProfile } from "./provider-profiles/registry";

export const DEFAULT_AZURE_OPENAI_API_VERSION = "2024-10-21";

/** OpenCode-compatible endpoints need a stable session header per chat. */
export function isOpenCodeProvider(provider: Provider): boolean {
  if (provider.profileId === "opencode") return true;
  try {
    return new URL(provider.baseUrl).hostname === "opencode.ai";
  } catch {
    return false;
  }
}

export function buildSessionHeaders(provider: Provider, sessionId: string): Record<string, string> {
  return isOpenCodeProvider(provider) ? { "x-opencode-session": sessionId } : {};
}

export function isAzureOpenAIProvider(provider: Provider): boolean {
  return provider.profileId === "azure-openai" || provider.type === "azure-openai";
}

export function providerApiVersion(provider: Provider): string | undefined {
  if (!isAzureOpenAIProvider(provider)) return provider.apiVersion;
  return (
    provider.apiVersion ||
    (provider.profileId ? getProfile(provider.profileId)?.endpoint.apiVersion : undefined) ||
    DEFAULT_AZURE_OPENAI_API_VERSION
  );
}

export function appendApiVersion(url: string, apiVersion?: string): string {
  if (!apiVersion) return url;
  const parsed = new URL(url);
  parsed.searchParams.set("api-version", apiVersion);
  return parsed.toString();
}

/** Append a resource path before an existing query string. */
export function appendResourcePath(baseUrl: string, path: string): string {
  const parsed = new URL(baseUrl);
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  return parsed.toString();
}

/**
 * Adapter base URL for a concrete model/deployment.
 * Azure OpenAI addresses chat completions below `/deployments/{deployment}`;
 * protocol adapters append their normal resource path afterwards.
 */
export function resolveAdapterBaseUrl(provider: Provider, modelId: string): string {
  const baseUrl = provider.baseUrl.replace(/\/+$/, "");
  if (!isAzureOpenAIProvider(provider)) return baseUrl;
  const deploymentBase = appendResourcePath(baseUrl, `/deployments/${encodeURIComponent(modelId)}`);
  return appendApiVersion(deploymentBase, providerApiVersion(provider));
}

export function resolveProviderResourceUrl(provider: Provider, path: string): string {
  const baseUrl = provider.baseUrl.replace(/\/+$/, "");
  return appendApiVersion(appendResourcePath(baseUrl, path), providerApiVersion(provider));
}
