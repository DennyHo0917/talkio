import type { ImageGenerationApi, Model, ModelOutputModality, Provider } from "../types";

/** An explicit ImageModel API means conversation input is an image prompt. */
export function isStandaloneImageModel(
  model: Pick<Model, "imageGenerationApi" | "outputModalities"> | null | undefined,
): boolean {
  return !!model?.imageGenerationApi && model.outputModalities.includes("image");
}

export function inferImageGenerationApi(
  provider: Provider,
  outputModalities: readonly ModelOutputModality[],
): ImageGenerationApi | undefined {
  if (!outputModalities.includes("image")) return undefined;

  // These providers may return images from language-model requests, but their
  // standalone image endpoints do not match the SDK providers used by Talkio.
  if (provider.profileId === "openrouter") return undefined;
  if (provider.profileId === "azure-openai" || provider.type === "azure-openai") return undefined;

  if (provider.apiFormat === "gemini-generate-content") return "google";
  if (provider.profileId === "openai") return "openai";
  if (
    provider.type === "openai" &&
    (!provider.apiFormat ||
      provider.apiFormat === "chat-completions" ||
      provider.apiFormat === "responses")
  ) {
    return "openai-compatible";
  }
  return undefined;
}
