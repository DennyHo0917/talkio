import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageStatus, type Conversation, type Message } from "../../types";

const mocks = vi.hoisted(() => ({
  getConversation: vi.fn(),
  insertMessage: vi.fn(),
  updateConversation: vi.fn(),
  updateMessage: vi.fn(),
  generateImages: vi.fn(),
  getModelById: vi.fn(),
  persistGeneratedImages: vi.fn(),
  notifyDbChange: vi.fn(),
}));

vi.mock("../../storage/database", () => ({
  getConversation: mocks.getConversation,
  insertMessage: mocks.insertMessage,
  updateConversation: mocks.updateConversation,
  updateMessage: mocks.updateMessage,
}));
vi.mock("../../services/image-generation", () => ({
  generateImages: mocks.generateImages,
}));
vi.mock("../provider-store", () => ({
  useProviderStore: {
    getState: () => ({ getModelById: mocks.getModelById }),
  },
}));
vi.mock("../../services/image-store", () => ({
  persistGeneratedImages: mocks.persistGeneratedImages,
}));
vi.mock("../../hooks/useDatabase", () => ({ notifyDbChange: mocks.notifyDbChange }));

const conversation: Conversation = {
  id: "conversation-1",
  type: "single",
  title: "Image chat",
  participants: [{ id: "participant-1", modelId: "image-model-1", identityId: null }],
  lastMessage: null,
  lastMessageAt: null,
  pinned: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

async function loadStore() {
  vi.resetModules();
  const { useChatStore } = await import("../chat-store");
  useChatStore.setState({
    currentConversationId: conversation.id,
    activeBranchId: null,
    isGenerating: false,
    streamingMessages: [],
  });
  return useChatStore;
}

describe("direct chat image generation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() {
        return values.size;
      },
    });
    mocks.getConversation.mockResolvedValue(conversation);
    mocks.getModelById.mockReturnValue({
      id: "image-model-1",
      modelId: "gpt-image-1",
      displayName: "GPT Image 1",
      providerId: "provider-1",
      outputModalities: ["image"],
      imageGenerationApi: "openai",
    });
    mocks.generateImages.mockResolvedValue(["data:image/png;base64,QUJD"]);
    mocks.persistGeneratedImages.mockResolvedValue(["generated/image.png"]);
  });

  it("persists the prompt and generated image as conversation messages", async () => {
    const store = await loadStore();

    await store.getState().generateImage("  a red cube  ", "image-model-1");

    expect(mocks.insertMessage).toHaveBeenCalledTimes(2);
    const [userMessage] = mocks.insertMessage.mock.calls[0] as [Message];
    const [assistantMessage] = mocks.insertMessage.mock.calls[1] as [Message];
    expect(userMessage).toMatchObject({ role: "user", content: "a red cube" });
    expect(assistantMessage).toMatchObject({
      role: "assistant",
      senderModelId: "image-model-1",
      participantId: "participant-1",
      status: MessageStatus.STREAMING,
    });
    expect(Date.parse(assistantMessage.createdAt)).toBeGreaterThan(
      Date.parse(userMessage.createdAt),
    );
    expect(mocks.generateImages).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "a red cube",
        model: "image-model-1",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(mocks.updateMessage).toHaveBeenCalledWith(
      assistantMessage.id,
      expect.objectContaining({
        generatedImages: ["generated/image.png"],
        status: MessageStatus.SUCCESS,
      }),
    );
    expect(store.getState().isGenerating).toBe(false);
  });

  it("persists image API failures on the assistant message", async () => {
    mocks.generateImages.mockRejectedValue(new Error("Image API 401: bad key"));
    const store = await loadStore();

    await store.getState().generateImage("a red cube", "image-model-1");

    const [assistantMessage] = mocks.insertMessage.mock.calls[1] as [Message];
    expect(mocks.updateMessage).toHaveBeenCalledWith(
      assistantMessage.id,
      expect.objectContaining({
        status: MessageStatus.ERROR,
        errorMessage: "Image API 401: bad key",
      }),
    );
    expect(store.getState().isGenerating).toBe(false);
  });

  it("rejects a model that is not selected by the conversation", async () => {
    const store = await loadStore();

    await expect(store.getState().generateImage("a red cube", "another-model")).rejects.toThrow(
      "must use the model selected for this conversation",
    );
    expect(mocks.insertMessage).not.toHaveBeenCalled();
    expect(mocks.generateImages).not.toHaveBeenCalled();
  });
});
