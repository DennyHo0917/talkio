import type { ModelCapabilities } from "../../types";

/** Parameters for probing model capabilities */
export interface ProbeParams {
  baseUrl: string;
  headers: Record<string, string>;
  modelId: string;
}

/** Only positively confirmed capabilities are returned; failures stay diagnostic. */
export interface ProbeResult {
  capabilities: Partial<ModelCapabilities>;
  warnings: string[];
}

/**
 * ProviderAdapter — probes provider/model capabilities (vision, tool call,
 * reasoning) with lightweight raw requests. Chat streaming/tools/compression
 * now go through the Vercel AI SDK (see runtime/ai-sdk), not this adapter.
 */
export interface ProviderAdapter {
  probeCapabilities(params: ProbeParams): Promise<ProbeResult>;
}
