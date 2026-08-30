import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transcribe: vi.fn(),
  groqTranscription: vi.fn(() => ({ provider: "groq" })),
  openaiTranscription: vi.fn(() => ({ provider: "openai" })),
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, transcribe: mocks.transcribe };
});
vi.mock("@ai-sdk/groq", () => ({
  createGroq: () => ({ transcription: mocks.groqTranscription }),
}));
vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: () => ({ transcription: mocks.openaiTranscription }),
}));

import { transcribeAudio } from "../transcription";

describe("transcribeAudio", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transcribe.mockResolvedValue({ text: "hello" });
  });

  it("uses the Groq transcription provider for the Groq endpoint", async () => {
    const text = await transcribeAudio({
      audio: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }),
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: "secret",
      modelId: "whisper-large-v3-turbo",
    });

    expect(text).toBe("hello");
    expect(mocks.groqTranscription).toHaveBeenCalledWith("whisper-large-v3-turbo");
    expect(mocks.openaiTranscription).not.toHaveBeenCalled();
  });

  it("uses the OpenAI transcription provider for compatible custom endpoints", async () => {
    await transcribeAudio({
      audio: new Blob([new Uint8Array([1])]),
      baseUrl: "https://audio.example.com/v1/",
      apiKey: "secret",
      modelId: "whisper-1",
    });

    expect(mocks.openaiTranscription).toHaveBeenCalledWith("whisper-1");
  });
});
