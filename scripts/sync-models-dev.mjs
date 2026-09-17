import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const SOURCE_URL = "https://models.dev/api.json";
const OUTPUT_URL = new URL(
  "../src/services/provider-profiles/models-dev.generated.json",
  import.meta.url,
);
const REASONING_OPTION_TYPES = new Set(["toggle", "effort", "budget_tokens"]);
const INCLUDED_PROVIDER_IDS = new Set([
  "alibaba",
  "anthropic",
  "azure",
  "cohere",
  "deepseek",
  "fireworks-ai",
  "google",
  "groq",
  "meta",
  "minimax",
  "minimax-cn",
  "mistral",
  "moonshotai",
  "moonshotai-cn",
  "nvidia",
  "openai",
  "openrouter",
  "perplexity",
  "togetherai",
  "xai",
  "zai",
  "zhipuai",
]);
const REASONING_EFFORTS = new Set([
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function assertObject(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value;
}

function optionalTokenLimit(value, path) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${path} must be a non-negative number`);
  }
  // models.dev uses 0 for non-token image/video models where the limit does not apply.
  return value === 0 ? undefined : value;
}

function optionalFiniteNumber(value, path) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
  return value;
}

function stringArray(value, path) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${path} must be a string array`);
  }
  return value;
}

function reasoningOptions(value, path) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value.map((option, index) => {
    const parsed = assertObject(option, `${path}[${index}]`);
    if (!REASONING_OPTION_TYPES.has(parsed.type)) {
      throw new Error(`${path}[${index}] has unsupported type: ${String(parsed.type)}`);
    }
    if (parsed.type === "effort") {
      if (!Array.isArray(parsed.values)) {
        throw new Error(`${path}[${index}].values must be an array`);
      }
      const values = parsed.values.map((value) => (value === null ? "default" : value));
      stringArray(values, `${path}[${index}].values`);
      const unsupported = values.find((value) => !REASONING_EFFORTS.has(value));
      if (unsupported) {
        throw new Error(`${path}[${index}].values has unsupported effort: ${unsupported}`);
      }
      return { ...parsed, values };
    }
    optionalFiniteNumber(parsed.min, `${path}[${index}].min`);
    optionalFiniteNumber(parsed.max, `${path}[${index}].max`);
    return parsed;
  });
}

function compactModel(model, path) {
  const parsed = assertObject(model, path);
  const modalities = assertObject(parsed.modalities, `${path}.modalities`);
  const limit = assertObject(parsed.limit, `${path}.limit`);
  const interleaved =
    parsed.interleaved && typeof parsed.interleaved === "object" ? parsed.interleaved : undefined;

  return {
    name: typeof parsed.name === "string" ? parsed.name : undefined,
    input: stringArray(modalities.input, `${path}.modalities.input`),
    output: stringArray(modalities.output, `${path}.modalities.output`),
    context: optionalTokenLimit(limit.context, `${path}.limit.context`),
    maxOutput: optionalTokenLimit(limit.output, `${path}.limit.output`),
    reasoning: parsed.reasoning === true,
    reasoningOptions: reasoningOptions(parsed.reasoning_options, `${path}.reasoning_options`),
    tools: parsed.tool_call === true,
    interleavedField:
      interleaved && typeof interleaved.field === "string" ? interleaved.field : undefined,
  };
}

async function main() {
  const response = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${SOURCE_URL}: HTTP ${response.status}`);
  }

  const source = assertObject(await response.json(), "models.dev response");
  const providers = {};
  for (const providerId of [...INCLUDED_PROVIDER_IDS].sort()) {
    if (!source[providerId]) {
      throw new Error(`models.dev response is missing required provider: ${providerId}`);
    }
    const provider = assertObject(source[providerId], `provider ${providerId}`);
    const models = assertObject(provider.models, `provider ${providerId}.models`);
    providers[providerId] = {};
    for (const modelId of Object.keys(models).sort()) {
      providers[providerId][modelId] = compactModel(
        models[modelId],
        `provider ${providerId}.models.${modelId}`,
      );
    }
  }

  const snapshot = { schemaVersion: 1, source: SOURCE_URL, providers };
  await writeFile(OUTPUT_URL, `${JSON.stringify(snapshot)}\n`, "utf8");
  const count = Object.values(providers).reduce(
    (total, models) => total + Object.keys(models).length,
    0,
  );
  console.log(`Synced ${count} models from ${SOURCE_URL}`);
  console.log(`Wrote ${fileURLToPath(OUTPUT_URL)}`);
}

await main();
