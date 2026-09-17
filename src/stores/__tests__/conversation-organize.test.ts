import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "../../types";

const { getConversation, updateConversation, notifyDbChange } = vi.hoisted(() => ({
  getConversation: vi.fn(),
  updateConversation: vi.fn(),
  notifyDbChange: vi.fn(),
}));

vi.mock("../../storage/database", () => ({
  getConversation,
  updateConversation,
}));
vi.mock("../../hooks/useDatabase", () => ({ notifyDbChange }));
vi.mock("../provider-store", () => ({
  useProviderStore: {
    getState: () => ({ getModelById: (id: string) => ({ displayName: id }) }),
  },
}));

import { setConversationArchived, updateMembersAcrossGroups } from "../chat-store-actions";

const memberA = { id: "a", modelId: "model-a", identityId: null };
const memberB = { id: "b", modelId: "model-b", identityId: "role-1" };

function group(id: string, participants = [memberA, memberB]): Conversation {
  return {
    id,
    type: "group",
    title: id,
    participants,
    pinned: false,
    archived: false,
    lastMessage: "earlier message",
    lastMessageAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("conversation organization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateConversation.mockResolvedValue(undefined);
  });

  it("archives without deleting history or configuration, then restores", async () => {
    await setConversationArchived("g1", true);
    await setConversationArchived("g1", false);

    expect(updateConversation).toHaveBeenNthCalledWith(1, "g1", {
      archived: true,
      pinned: false,
    });
    expect(updateConversation).toHaveBeenNthCalledWith(2, "g1", {
      archived: false,
      pinned: undefined,
    });
    expect(notifyDbChange).toHaveBeenCalledTimes(2);
  });

  it("adds each model-role pair at most once and reports a failing group", async () => {
    getConversation.mockImplementation(async (id: string) => group(id));
    updateConversation.mockImplementation(async (id: string) => {
      if (id === "g2") throw new Error("disk full");
    });

    const result = await updateMembersAcrossGroups(["g1", "g2"], "add", [
      { modelId: "model-a", identityId: null },
      { modelId: "model-a", identityId: "role-2" },
      { modelId: "model-a", identityId: "role-2" },
    ]);

    expect(updateConversation.mock.calls[0][1].participants).toEqual([
      memberA,
      memberB,
      expect.objectContaining({ modelId: "model-a", identityId: "role-2" }),
    ]);
    expect(result).toEqual([
      expect.objectContaining({ conversationId: "g1", status: "updated", changedCount: 1 }),
      expect.objectContaining({ conversationId: "g2", status: "failed", error: "disk full" }),
    ]);
  });

  it("preserves the last member when a bulk removal would empty a group", async () => {
    getConversation.mockImplementation(async (id: string) =>
      id === "g1" ? group(id, [memberA]) : group(id),
    );

    const result = await updateMembersAcrossGroups(["g1", "g2"], "remove", [
      { modelId: "model-a", identityId: null },
    ]);

    expect(result[0]).toMatchObject({ conversationId: "g1", status: "failed" });
    expect(result[1]).toMatchObject({ conversationId: "g2", status: "updated", changedCount: 1 });
    expect(updateConversation).toHaveBeenCalledOnce();
    expect(updateConversation).toHaveBeenCalledWith("g2", {
      participants: [memberB],
      type: "single",
    });
  });
});
