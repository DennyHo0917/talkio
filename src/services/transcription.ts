import { transcribe } from "ai";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import { appFetch } from "../lib/http";

export interface TranscribeAudioParams {
  audio: Blob;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  signal?: AbortSignal;
}

function isGroqEndpoint(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === "api.groq.com";
  } catch {
    return false;
  }
}

export async function transcribeAudio(params: TranscribeAudioParams): Promise<string> {
  const baseURL = params.baseUrl.replace(/\/+$/, "");
  if (!baseURL) throw new Error("Transcription base URL is required");
  if (!params.apiKey) throw new Error("Transcription API key is required");
  const fetch = appFetch as typeof globalThis.fetch;
  const model = isGroqEndpoint(baseURL)
    ? createGroq({ baseURL, apiKey: params.apiKey, fetch }).transcription(params.modelId)
    : createOpenAI({ baseURL, apiKey: params.apiKey, fetch }).transcription(params.modelId);
  const result = await transcribe({
    model,
    audio: new Uint8Array(await params.audio.arrayBuffer()),
    abortSignal: params.signal,
    maxRetries: 2,
  });
  return result.text;
}
