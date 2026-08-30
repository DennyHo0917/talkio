/**
 * ParticipantRuntime — protocol-agnostic participant interface.
 *
 * Chat scheduling depends only on this interface, never on a specific
 * provider SDK. Implementations can wrap a plain model provider, a local
 * coding agent, an ACP agent, an A2A remote agent, or a durable task runtime.
 */
import type { ModelMessage } from "ai";
import type { ApiFormat, ModelOutputModality } from "../../types";
import type { GenerationEvent } from "./events";

export interface ParticipantRequest {
  runId: string;
  apiFormat?: ApiFormat;
  baseUrl: string;
  headers: Record<string, string>;
  modelId: string;
  outputModalities?: ModelOutputModality[];
  /** Standard AI SDK messages (a leading system message is lifted to `system`). */
  messages: ModelMessage[];
  toolDefs?: unknown[];
  /**
   * Executes a tool call and returns the text result fed back to the model.
   * When provided, the runtime runs the whole call→execute→feed-back loop
   * (SDK-managed via stopWhen); approval/MCP routing live inside this callback.
   */
  executeTool?: (name: string, input: Record<string, unknown>) => Promise<string>;
  /** Max steps for the SDK-managed tool loop (default 8). */
  maxToolRounds?: number;
  reasoningEffort?: string;
  identity?: unknown;
  signal: AbortSignal;
}

export interface ResumeInput {
  runId: string;
  text?: string;
  toolResults?: Array<{ callId: string; result: unknown }>;
}

export interface ParticipantRuntime {
  /** Start (or resume) a generation run; events stream until completion/failure. */
  run(request: ParticipantRequest): AsyncIterable<GenerationEvent>;
  /** Request cancellation of an in-flight run. */
  cancel(runId: string): Promise<void>;
  /** Optional: resume a paused run (e.g. after user approval). */
  resume?(runId: string, input: ResumeInput): AsyncIterable<GenerationEvent>;
}
