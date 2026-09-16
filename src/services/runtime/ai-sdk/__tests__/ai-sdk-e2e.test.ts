import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { createOpenAI } from "@ai-sdk/openai";
import { AISdkRuntime, getLanguageModel } from "../ai-sdk-runtime";
import type { GenerationEvent } from "../../events";
import type { ParticipantRequest } from "../../types";

const encoder = new TextEncoder();

/** Build an OpenAI chat-completions SSE response with incremental tool args. */
function openaiSseResponse(): Response {
  const chunks = [
    'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}\n\n',
    'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{"reasoning_content":"thinking hard"},"finish_reason":null}]}\n\n',
    'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{\\"ci"}}]},"finish_reason":null}]}\n\n',
    'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ty\\":\\"NYC\\"}"}}]},"finish_reason":null}]}\n\n',
    'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
    "data: [DONE]\n\n",
  ];
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

function taggedReasoningResponse(tag: string): Response {
  const content = [`<${tag.slice(0, 2)}`, `${tag.slice(2)}>hidden</${tag}>visible`];
  const chunks = [
    ...content.map(
      (text) =>
        `data: ${JSON.stringify({
          id: "reasoning-1",
          object: "chat.completion.chunk",
          created: 1,
          model: "reasoning-model",
          choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
        })}\n\n`,
    ),
    'data: {"id":"reasoning-1","object":"chat.completion.chunk","created":1,"model":"reasoning-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n",
  ];
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

function makeRequest(overrides: Partial<ParticipantRequest> = {}): ParticipantRequest {
  return {
    runId: "run-1",
    apiFormat: "chat-completions",
    baseUrl: "https://api.example.com/v1",
    headers: { Authorization: "Bearer sk-test" },
    modelId: "gpt-5",
    messages: [{ role: "user", content: "hi" }],
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function collect(gen: AsyncIterable<GenerationEvent>): Promise<GenerationEvent[]> {
  const events: GenerationEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

describe("AISdkRuntime end-to-end (real AI SDK + mocked transport)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("streams text, thinking, incremental tool args and usage from a real OpenAI-compatible SSE stream", async () => {
    mockFetch.mockResolvedValue(openaiSseResponse());

    const runtime = new AISdkRuntime((req) => getLanguageModel(req));

    const events = await collect(runtime.run(makeRequest()));

    // URL & auth are wired through the provider (headers are lowercased by
    // the AI SDK's header normalization).
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toBe("https://api.example.com/v1/chat/completions");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer sk-test" });
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      stream_options: { include_usage: true },
    });

    const text = events
      .filter((e) => e.type === "text-delta")
      .map((e) => (e as { text: string }).text)
      .join("");
    expect(text).toBe("Hello");

    // Note: ai@7 does not surface reasoning_content on the OpenAI chat path
    // (no reasoning events in fullStream) — thinking coverage lives in the
    // mapping unit tests. The reasoning_content SSE chunk above is ignored.
    expect(events).toContainEqual({
      type: "tool-call-started",
      callId: "call_1",
      name: "get_weather",
    });
    // Incremental arguments arrive as two deltas.
    const argDeltas = events.filter((e) => e.type === "tool-call-arguments-delta");
    expect(argDeltas.length).toBeGreaterThanOrEqual(1);
    const joinedArgs = argDeltas.map((e) => (e as { delta: string }).delta).join("");
    expect(JSON.parse(joinedArgs)).toEqual({ city: "NYC" });
    expect(events).toContainEqual({ type: "usage", usage: { inputTokens: 10, outputTokens: 5 } });
    expect(events[events.length - 1].type).toBe("run-completed");
  });

  it("preserves Azure api-key auth and appends api-version after the resource path", async () => {
    mockFetch.mockResolvedValue(openaiSseResponse());
    const runtime = new AISdkRuntime((req) => getLanguageModel(req));

    await collect(
      runtime.run(
        makeRequest({
          baseUrl:
            "https://resource.openai.azure.com/openai/deployments/prod%20deployment?api-version=2024-10-21",
          headers: { "api-key": "azure-secret" },
        }),
      ),
    );

    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toBe(
      "https://resource.openai.azure.com/openai/deployments/prod%20deployment/chat/completions?api-version=2024-10-21",
    );
    expect((init as RequestInit).headers).toMatchObject({ "api-key": "azure-secret" });
    expect((init as RequestInit).headers).not.toHaveProperty("authorization");
  });

  it("sends the selected identity temperature", async () => {
    mockFetch.mockResolvedValue(openaiSseResponse());
    const runtime = new AISdkRuntime((req) => getLanguageModel(req));

    await collect(runtime.run(makeRequest({ temperature: 0.35 })));

    expect(JSON.parse(String((mockFetch.mock.calls[0][1] as RequestInit).body))).toMatchObject({
      temperature: 0.35,
    });
  });

  it.each(["think", "thinking"])(
    "extracts <%s> text as reasoning across stream chunks",
    async (tag) => {
      mockFetch.mockResolvedValue(taggedReasoningResponse(tag));
      const runtime = new AISdkRuntime((req) => getLanguageModel(req));

      const events = await collect(runtime.run(makeRequest({ modelId: "reasoning-model" })));

      expect(
        events
          .filter((event) => event.type === "thinking-delta")
          .map((event) => event.text)
          .join(""),
      ).toBe("hidden");
      expect(
        events
          .filter((event) => event.type === "text-delta")
          .map((event) => event.text)
          .join(""),
      ).toBe("visible");
    },
  );

  it("normalizes an HTTP 401 into run-failed auth", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Invalid API key" } }), { status: 401 }),
    );

    const runtime = new AISdkRuntime((req) =>
      createOpenAI({
        apiKey: "sk-bad",
        baseURL: req.baseUrl,
        fetch: mockFetch as unknown as typeof fetch,
      }).chat(req.modelId),
    );

    const events = await collect(runtime.run(makeRequest()));

    expect(events[events.length - 1]).toMatchObject({
      type: "run-failed",
      error: { code: "auth" },
    });
  });

  it("cancel() aborts the in-flight request", async () => {
    // A response body that never closes until the signal aborts (the real
    // fetch abort semantics: body stream errors). Handles both timings —
    // abort before fetch starts (signal already aborted) and mid-flight.
    mockFetch.mockImplementation((_url: string, init: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          if (init.signal?.aborted) {
            controller.error(new DOMException("aborted", "AbortError"));
            return;
          }
          init.signal?.addEventListener("abort", () => {
            controller.error(new DOMException("aborted", "AbortError"));
          });
        },
      });
      return Promise.resolve(
        new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
      );
    });

    const runtime = new AISdkRuntime((req) =>
      createOpenAI({
        apiKey: "sk-test",
        baseURL: req.baseUrl,
        fetch: mockFetch as unknown as typeof fetch,
      }).chat(req.modelId),
    );

    const gen = runtime.run(makeRequest())[Symbol.asyncIterator]();
    await gen.next(); // run-started
    const pending = gen.next(); // blocks on the stream
    await runtime.cancel("run-1");
    const next = await pending;

    expect(next.done).toBe(false);
    expect(next.value).toMatchObject({ type: "run-failed", error: { code: "aborted" } });
  });
});
