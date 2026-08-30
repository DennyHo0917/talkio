import type { ProviderAdapter, ProbeParams, ProbeResult } from "./types";
import { appFetch } from "../../lib/http";

export class ResponsesAdapter implements ProviderAdapter {
  async probeCapabilities(params: ProbeParams): Promise<ProbeResult> {
    const caps: ProbeResult = { vision: false, toolCall: false, reasoning: false, streaming: true };

    // Probe vision
    try {
      const res = await appFetch(`${params.baseUrl}/responses`, {
        method: "POST",
        headers: params.headers,
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          model: params.modelId,
          max_output_tokens: 1,
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: "hi" },
                {
                  type: "input_image",
                  image_url:
                    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
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
      const res = await appFetch(`${params.baseUrl}/responses`, {
        method: "POST",
        headers: params.headers,
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          model: params.modelId,
          max_output_tokens: 1,
          input: [{ role: "user", content: "hi" }],
          tools: [
            {
              type: "function",
              name: "test",
              description: "test",
              parameters: { type: "object", properties: {} },
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
