import { beforeEach, describe, expect, it, vi } from "vitest";

const { appFetch } = vi.hoisted(() => ({ appFetch: vi.fn() }));
vi.mock("../../../lib/http", () => ({ appFetch }));

import { ChatCompletionsAdapter } from "../chat-completions";

const params = {
  baseUrl: "https://api.example.com/v1",
  headers: { Authorization: "Bearer test" },
  modelId: "reasoning-model",
};

describe("capability probes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("only returns positively confirmed capabilities", async () => {
    appFetch
      .mockResolvedValueOnce(new Response("unsupported", { status: 400 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    const result = await new ChatCompletionsAdapter().probeCapabilities(params);

    expect(result.capabilities).toEqual({ toolCall: true });
    expect(result.capabilities).not.toHaveProperty("vision");
    expect(result.capabilities).not.toHaveProperty("reasoning");
    expect(result.warnings).toEqual(["Vision probe returned HTTP 400"]);
  });

  it("surfaces transport failures without inventing negative capabilities", async () => {
    appFetch.mockRejectedValue(new Error("network offline"));

    const result = await new ChatCompletionsAdapter().probeCapabilities(params);

    expect(result.capabilities).toEqual({});
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.join(" ")).toContain("network offline");
  });
});
