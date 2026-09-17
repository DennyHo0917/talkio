import type { Provider } from "../../types";
import { appFetch } from "../../lib/http";
import { buildProviderHeaders } from "../provider-headers";
import { resolveProviderResourceUrl } from "../provider-request";
import { checkModelHealth } from "../provider-service";
import { getProfile } from "./registry";
import type { CheckResult, ConnectionCheck, ModelDiscoveryConfig } from "./types";

function ok(detail?: string): CheckResult {
  return { status: "ok", detail };
}

function fail(detail: string): CheckResult {
  return { status: "fail", detail };
}

function skipped(detail?: string): CheckResult {
  return { status: "skipped", detail };
}

function discoveryPath(discovery: ModelDiscoveryConfig): string | null {
  if (discovery.type === "openai-models") return discovery.path ?? "/models";
  if (discovery.type === "gemini-models") return "/models";
  if (discovery.type === "ollama-tags") return "/api/tags";
  return null;
}

function modelCount(discovery: ModelDiscoveryConfig, payload: unknown): number {
  if (!payload || typeof payload !== "object") return 0;
  const object = payload as Record<string, unknown>;
  const candidate =
    discovery.type === "openai-models"
      ? object.data
      : discovery.type === "gemini-models" || discovery.type === "ollama-tags"
        ? object.models
        : discovery.type === "static"
          ? discovery.models
          : [];
  return Array.isArray(candidate) ? candidate.length : 0;
}

export async function checkProviderConnection(
  provider: Provider,
  selectedModelId?: string,
): Promise<ConnectionCheck> {
  const profile = provider.profileId ? getProfile(provider.profileId) : undefined;
  const discovery =
    profile?.modelDiscovery ??
    (provider.apiFormat === "gemini-generate-content"
      ? ({ type: "gemini-models" } as const)
      : ({ type: "openai-models" } as const));
  const path = discoveryPath(discovery);
  const headers = buildProviderHeaders(provider);

  const endpoint: CheckResult = await (async () => {
    if (!path) return skipped("Provider has no discovery endpoint");
    try {
      const res = await appFetch(resolveProviderResourceUrl(provider, path), {
        method: "GET",
        signal: AbortSignal.timeout(10000),
      });
      if (res.status >= 500) return fail(`Endpoint unavailable (HTTP ${res.status})`);
      return ok(`${res.status} ${res.statusText}`.trim());
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  })();

  const authentication: CheckResult = await (async () => {
    if (!path) {
      return provider.apiKey ? ok("Credentials configured") : fail("Credentials missing");
    }
    try {
      const res = await appFetch(resolveProviderResourceUrl(provider, path), {
        headers,
        signal: AbortSignal.timeout(10000),
      });
      if (res.status === 401 || res.status === 403) {
        return fail(`Credentials rejected (HTTP ${res.status})`);
      }
      if (!res.ok) return fail(`Authentication check failed (HTTP ${res.status})`);
      return ok(`Credentials accepted (HTTP ${res.status})`);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  })();

  const modelDiscovery: CheckResult = await (async () => {
    if (discovery.type === "manual") return skipped("Models are configured manually");
    if (discovery.type === "static") return ok(`${discovery.models.length} static models`);
    if (!path) return skipped("Provider has no discovery endpoint");
    try {
      const res = await appFetch(resolveProviderResourceUrl(provider, path), {
        headers,
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return fail(`Model list failed (HTTP ${res.status})`);
      const count = modelCount(discovery, await res.json());
      if (count === 0) return fail("Model list returned no models");
      return ok(`${count} models discoverable`);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  })();

  const selectedModelAccess: CheckResult = selectedModelId
    ? skipped("Verified by protocol compatibility request")
    : skipped("No model selected");

  const protocolCompatibility: CheckResult = await (async () => {
    if (!selectedModelId) return skipped("No model selected");
    const result = await checkModelHealth(provider, selectedModelId);
    return result.ok
      ? ok("Protocol accepted request")
      : fail(result.error ?? "Protocol check failed");
  })();

  return { endpoint, authentication, modelDiscovery, selectedModelAccess, protocolCompatibility };
}
