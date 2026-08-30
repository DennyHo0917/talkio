import type { ProviderAdapter, ProbeParams, ProbeResult } from "./types";
import { appFetch } from "../../lib/http";

export class AnthropicMessagesAdapter implements ProviderAdapter {
  async probeCapabilities(params: ProbeParams): Promise<ProbeResult> {
    const caps: ProbeResult = { vision: false, toolCall: false, reasoning: false, streaming: true };

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
      caps.vision = res.ok;
    } catch {
      /* ignore */
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
      caps.toolCall = res.ok;
    } catch {
      /* ignore */
    }

    return caps;
  }
}
