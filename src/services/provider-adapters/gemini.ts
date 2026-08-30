import type { ProviderAdapter, ProbeParams, ProbeResult } from "./types";
import { appFetch } from "../../lib/http";

export class GeminiAdapter implements ProviderAdapter {
  async probeCapabilities(params: ProbeParams): Promise<ProbeResult> {
    const capabilities: ProbeResult["capabilities"] = {};
    const warnings: string[] = [];
    const endpoint = `${params.baseUrl}/models/${encodeURIComponent(params.modelId)}:generateContent`;

    try {
      const response = await appFetch(endpoint, {
        method: "POST",
        headers: params.headers,
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                { text: "hi" },
                {
                  inlineData: {
                    mimeType: "image/png",
                    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
                  },
                },
              ],
            },
          ],
          generationConfig: { maxOutputTokens: 1 },
        }),
      });
      if (response.ok) capabilities.vision = true;
      else warnings.push(`Vision probe returned HTTP ${response.status}`);
    } catch (error) {
      warnings.push(
        `Vision probe failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      const response = await appFetch(endpoint, {
        method: "POST",
        headers: params.headers,
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          tools: [
            {
              functionDeclarations: [
                {
                  name: "test",
                  description: "test",
                  parameters: { type: "OBJECT", properties: {} },
                },
              ],
            },
          ],
          generationConfig: { maxOutputTokens: 1 },
        }),
      });
      if (response.ok) capabilities.toolCall = true;
      else warnings.push(`Tool probe returned HTTP ${response.status}`);
    } catch (error) {
      warnings.push(`Tool probe failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    return { capabilities, warnings };
  }
}
