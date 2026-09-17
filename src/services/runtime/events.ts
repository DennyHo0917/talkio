/**
 * GenerationEvent — the stable boundary between runtimes and Talkio's UI and
 * persistence layers.
 */
import type { TokenUsage } from "../../types";

/** Reference to a shared artifact produced during a run. */
export interface ArtifactRef {
  id: string;
  name: string;
  kind: "file" | "note" | "task";
  url?: string;
}

/** Structured error carried by run-failed. */
export interface GenerationError {
  code: "aborted" | "auth" | "rate-limit" | "invalid-request" | "api" | "tool" | "unknown";
  message: string;
  retryable: boolean;
}

export type GenerationEvent =
  | { type: "run-started"; runId: string }
  | { type: "text-delta"; text: string }
  | { type: "thinking-delta"; text: string }
  | { type: "image-generated"; url: string }
  | { type: "tool-call-started"; callId: string; name: string }
  | { type: "tool-call-arguments-delta"; callId: string; delta: string }
  | { type: "tool-result"; callId: string; result: unknown }
  | { type: "artifact-updated"; artifact: ArtifactRef }
  | { type: "usage"; usage: TokenUsage }
  | { type: "run-completed"; reason: string }
  | { type: "run-failed"; error: GenerationError };
