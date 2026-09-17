import { extractJsonMiddleware, generateText, jsonSchema, Output, wrapLanguageModel } from "ai";
import type { Provider } from "../types";
import { buildProviderHeaders } from "./provider-headers";
import { resolveAdapterBaseUrl } from "./provider-request";
import { getLanguageModel } from "./runtime/ai-sdk/ai-sdk-runtime";

export const IDENTITY_ICONS = [
  "code",
  "translate",
  "architecture",
  "security",
  "finance",
  "writing",
  "research",
  "marketing",
  "design",
  "general",
] as const;

export interface GeneratedIdentityDraft {
  name: string;
  icon: (typeof IDENTITY_ICONS)[number];
  systemPrompt: string;
}

const identityDraftSchema = jsonSchema<GeneratedIdentityDraft>({
  type: "object",
  additionalProperties: false,
  required: ["name", "icon", "systemPrompt"],
  properties: {
    name: { type: "string", description: "Short identity name, 2-4 words" },
    icon: { type: "string", enum: [...IDENTITY_ICONS] },
    systemPrompt: {
      type: "string",
      description: "Concise 2-4 sentence system prompt defining role, expertise, and tone",
    },
  },
});

export async function generateIdentityDraft(
  provider: Provider,
  modelId: string,
  description: string,
): Promise<GeneratedIdentityDraft> {
  const headers = buildProviderHeaders(provider);
  const model = wrapLanguageModel({
    model: getLanguageModel({
      apiFormat: provider.apiFormat,
      baseUrl: resolveAdapterBaseUrl(provider, modelId),
      headers,
      modelId,
    }),
    middleware: extractJsonMiddleware(),
  });
  const { output } = await generateText({
    model,
    output: Output.object({
      schema: identityDraftSchema,
      name: "identity_card",
      description: "Identity card for an AI assistant application",
    }),
    system:
      "Generate an identity card from the user's description. Keep the name short and the system prompt concise.",
    prompt: description,
    temperature: 0.7,
  });
  return output;
}
