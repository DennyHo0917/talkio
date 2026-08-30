/** Parameters for probing model capabilities */
export interface ProbeParams {
  baseUrl: string;
  headers: Record<string, string>;
  modelId: string;
}

/** Model capabilities result */
export interface ProbeResult {
  vision: boolean;
  toolCall: boolean;
  reasoning: boolean;
  streaming: boolean;
}

/**
 * ProviderAdapter — probes provider/model capabilities (vision, tool call,
 * reasoning) with lightweight raw requests. Chat streaming/tools/compression
 * now go through the Vercel AI SDK (see runtime/ai-sdk), not this adapter.
 */
export interface ProviderAdapter {
  probeCapabilities(params: ProbeParams): Promise<ProbeResult>;
}
