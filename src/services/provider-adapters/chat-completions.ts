import type { ProviderAdapter, ProbeParams, ProbeResult } from "./types";
import { appendResourcePath } from "../provider-request";
import { appFetch } from "../../lib/http";

export class ChatCompletionsAdapter implements ProviderAdapter {
  async probeCapabilities(params: ProbeParams): Promise<ProbeResult> {
    const caps: ProbeResult = { vision: false, toolCall: false, reasoning: false, streaming: true };

    // Probe vision
    try {
      const res = await appFetch(appendResourcePath(params.baseUrl, "/chat/completions"), {
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
                  type: "image_url",
                  image_url: {
                    url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
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
      const res = await appFetch(appendResourcePath(params.baseUrl, "/chat/completions"), {
        method: "POST",
        headers: params.headers,
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          model: params.modelId,
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
          tools: [
            {
              type: "function",
              function: {
                name: "test",
                description: "test",
                parameters: { type: "object", properties: {} },
              },
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
