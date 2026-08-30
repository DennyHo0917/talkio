import type { ProviderAdapter, ProbeParams, ProbeResult } from "./types";
import { appFetch } from "../../lib/http";

export class AnthropicMessagesAdapter implements ProviderAdapter {
  async probeCapabilities(params: ProbeParams): Promise<ProbeResult> {
    const capabilities: ProbeResult["capabilities"] = {};
    const warnings: string[] = [];

    // Probe vision
    try {
      const res = await appFetch(`${params.baseUrl}/v1/messages`, {
        method: "POST",
        headers: params.headers,
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          model: params.modelId,
          max_tokens: 1,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "hi" },
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
                  },
                },
              ],
            },
          ],
        }),
      });
      if (res.ok) capabilities.vision = true;
      else warnings.push(`Vision probe returned HTTP ${res.status}`);
    } catch (error) {
      warnings.push(
        `Vision probe failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Probe tool call
    try {
      const res = await appFetch(`${params.baseUrl}/v1/messages`, {
        method: "POST",
        headers: params.headers,
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          model: params.modelId,
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
          tools: [
            {
              name: "test",
              description: "test",
              input_schema: { type: "object", properties: {} },
            },
          ],
        }),
      });
      if (res.ok) capabilities.toolCall = true;
      else warnings.push(`Tool probe returned HTTP ${res.status}`);
    } catch (error) {
      warnings.push(`Tool probe failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    return { capabilities, warnings };
  }
}
