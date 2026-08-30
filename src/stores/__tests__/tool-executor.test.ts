import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "../../types";
import type { GenerationContext } from "../chat-generation";

const mocks = vi.hoisted(() => ({
  executeBuiltInTool: vi.fn(),
  getBuiltInToolDefs: vi.fn(),
  executeMcpToolByName: vi.fn(),
  requestApproval: vi.fn(),
}));

vi.mock("../../services/built-in-tools", () => ({
  executeBuiltInTool: mocks.executeBuiltInTool,
  getBuiltInToolDefs: mocks.getBuiltInToolDefs,
}));
vi.mock("../../services/mcp", () => ({
  executeMcpToolByName: mocks.executeMcpToolByName,
}));
vi.mock("../../services/tool-approval", () => ({
  toolApproval: { request: mocks.requestApproval },
}));

import { createToolExecutor } from "../tool-executor";

const conversation: Conversation = {
  id: "conversation-1",
  type: "single",
  title: "Tools",
  participants: [{ id: "participant-1", modelId: "model-1", identityId: null }],
  lastMessage: null,
  lastMessageAt: null,
  pinned: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function makeExecutor(signal?: AbortSignal) {
  const definitions = ["first", "second"].map((name) => ({
    type: "function",
    function: { name, description: name, parameters: { type: "object" } },
  }));
  mocks.getBuiltInToolDefs.mockReturnValue(definitions);
  return createToolExecutor({
    ctx: { cid: conversation.id, conversation } as GenerationContext,
    modelId: "model-1",
    toolDefs: definitions,
    identity: null,
    builtInEnabledByName: {},
    allowedBuiltInToolNames: null,
    allowedServerIds: undefined,
    toolContext: { signal },
  });
}

describe("tool executor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requestApproval.mockResolvedValue(true);
    mocks.executeMcpToolByName.mockResolvedValue(null);
  });

  it("executes model-requested tools sequentially", async () => {
    const first = Promise.withResolvers<void>();
    const events: string[] = [];
    mocks.executeBuiltInTool.mockImplementation(async (name: string) => {
      events.push(`start:${name}`);
      if (name === "first") await first.promise;
      events.push(`end:${name}`);
      return { success: true, content: name };
    });
    const execute = makeExecutor();

    const firstResult = execute("first", {});
    const secondResult = execute("second", {});
    await vi.waitFor(() => expect(events).toEqual(["start:first"]));
    first.resolve();

    await expect(Promise.all([firstResult, secondResult])).resolves.toEqual(["first", "second"]);
    expect(events).toEqual(["start:first", "end:first", "start:second", "end:second"]);
  });

  it("does not start queued tools after the conversation is aborted", async () => {
    const first = Promise.withResolvers<void>();
    mocks.executeBuiltInTool.mockImplementation(async (name: string) => {
      if (name === "first") await first.promise;
      return { success: true, content: name };
    });
    const controller = new AbortController();
    const execute = makeExecutor(controller.signal);

    const firstResult = execute("first", {});
    const secondResult = execute("second", {});
    await vi.waitFor(() => expect(mocks.executeBuiltInTool).toHaveBeenCalledTimes(1));
    controller.abort();
    first.resolve();

    await expect(firstResult).resolves.toBe("first");
    await expect(secondResult).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.executeBuiltInTool).toHaveBeenCalledTimes(1);
  });
});
