import type { ProviderAdapter, ProbeParams, ProbeResult } from "./types";
import { appendResourcePath } from "../provider-request";
import { appFetch } from "../../lib/http";

export class ChatCompletionsAdapter implements ProviderAdapter {
  async probeCapabilities(params: ProbeParams): Promise<ProbeResult> {
    const capabilities: ProbeResult["capabilities"] = {};
    const warnings: string[] = [];

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
      if (res.ok) capabilities.vision = true;
      else warnings.push(`Vision probe returned HTTP ${res.status}`);
    } catch (error) {
      warnings.push(
        `Vision probe failed: ${error instanceof Error ? error.message : String(error)}`,
      );
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
      if (res.ok) capabilities.toolCall = true;
      else warnings.push(`Tool probe returned HTTP ${res.status}`);
    } catch (error) {
      warnings.push(`Tool probe failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    return { capabilities, warnings };
  }
}
