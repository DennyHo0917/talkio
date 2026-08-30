import type { ProviderAdapter, ProbeParams, ProbeResult } from "./types";

export class GeminiAdapter implements ProviderAdapter {
  async probeCapabilities(params: ProbeParams): Promise<ProbeResult> {
    return {
      vision: true,
      toolCall: true,
      reasoning: /gemini-2\.5/i.test(params.modelId) || /thinking/i.test(params.modelId),
      streaming: true,
    };
  }
}
