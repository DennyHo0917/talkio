export type ProviderType = "openai" | "anthropic" | "gemini" | "azure-openai";
export type ApiFormat =
  | "chat-completions"
  | "responses"
  | "anthropic-messages"
  | "gemini-generate-content";
export type ProviderStatus = "connected" | "disconnected" | "error" | "pending";
export type ConversationType = "single" | "group";
export type MessageRole = "user" | "assistant" | "system" | "tool";
export type McpToolType = "local" | "remote";
export type McpToolScope = "global" | "identity-bound" | "ad-hoc";

export interface CustomHeader {
  name: string;
  value: string;
}

export interface Provider {
  id: string;
  name: string;
  type: ProviderType;
  apiFormat?: ApiFormat;
  /** Optional data-driven profile reference (see provider-profiles registry). */
  profileId?: string;
  baseUrl: string;
  /**
   * Runtime memory only — never persisted to the providers blob.
   * Desktop: stored in the OS credential store keyed by provider id;
   * browser/Android fallback: localStorage under `talkio:secret:<id>`.
   */
  apiKey: string;
  apiVersion?: string;
  customHeaders: CustomHeader[];
  enabled: boolean;
  status: ProviderStatus;
  createdAt: string;
}

export interface ModelCapabilities {
  vision: boolean;
  toolCall: boolean;
  reasoning: boolean;
  streaming: boolean;
}

export type ModelInputModality = "text" | "image" | "audio" | "video" | "file";
export type ModelOutputModality = "text" | "image" | "audio";
export type ImageGenerationApi = "openai" | "openai-compatible" | "google";

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type ReasoningOption =
  | { type: "toggle" }
  | { type: "effort"; values: Array<ReasoningEffort | "default"> }
  | { type: "budget_tokens"; min?: number; max?: number };

export type ModelMetadataSource = "manual" | "models.dev" | "provider" | "probe" | "default";
export type ModelMetadataMatch = "exact" | "normalized";

export const REASONING_EFFORT_LEVELS: readonly (ReasoningEffort | undefined)[] = [
  undefined,
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export function nextReasoningEffort(
  current: ReasoningEffort | undefined,
  supportedLevels: readonly (ReasoningEffort | undefined)[] = REASONING_EFFORT_LEVELS,
): ReasoningEffort | undefined {
  const levels = supportedLevels.length > 0 ? supportedLevels : [undefined];
  const idx = levels.indexOf(current);
  return levels[(idx + 1) % levels.length];
}

export function reasoningEffortLabel(value: ReasoningEffort | undefined): string {
  return value ?? "default";
}

export interface Model {
  id: string;
  providerId: string;
  modelId: string;
  displayName: string;
  avatar: string | null;
  capabilities: ModelCapabilities;
  /** Capability fields confirmed by live probes; overrides catalog values field by field. */
  probedCapabilities?: Partial<ModelCapabilities>;
  inputModalities: ModelInputModality[];
  outputModalities: ModelOutputModality[];
  /** Independent image generation API exposed through an AI SDK ImageModel. */
  imageGenerationApi?: ImageGenerationApi;
  capabilitiesVerified: boolean;
  maxContextLength: number;
  maxOutputTokens?: number;
  reasoningOptions?: ReasoningOption[];
  metadataSource?: ModelMetadataSource;
  metadataMatch?: ModelMetadataMatch;
  metadataProviderId?: string;
  enabled: boolean;
}

export function getSupportedReasoningEfforts(
  model: Model | null | undefined,
): readonly (ReasoningEffort | undefined)[] {
  if (!model?.capabilities.reasoning) return [undefined];
  const effortOption = model.reasoningOptions?.find((option) => option.type === "effort");
  if (!effortOption || effortOption.type !== "effort") return [undefined];

  const levels: Array<ReasoningEffort | undefined> = [undefined];
  for (const value of effortOption.values) {
    const level = value === "default" ? undefined : value;
    if (!levels.includes(level)) levels.push(level);
  }
  return levels;
}

export interface IdentityParams {
  temperature: number;
}

export interface Identity {
  id: string;
  name: string;
  icon: string;
  systemPrompt: string;
  params: IdentityParams;
  mcpToolIds: string[];
  mcpServerIds: string[];
  createdAt: string;
}

// Persisted MCP server configuration
export interface McpServer {
  id: string;
  name: string;
  /** Connection type: "http" (default) or "stdio" (desktop only) */
  type?: "http" | "stdio";
  /** HTTP mode: server URL */
  url: string;
  customHeaders?: CustomHeader[];
  /** Stdio mode: executable command (e.g. "npx", "node") */
  command?: string;
  /** Stdio mode: command arguments */
  args?: string[];
  /** Stdio mode: environment variables */
  env?: Record<string, string>;
  enabled: boolean;
  /** Tool names disabled on this server — filtered out before sending to AI */
  disabledTools?: string[];
  /** Last known tool count from successful connection test */
  lastToolCount?: number;
}

// Legacy tool interface — still used for built-in tools
export interface McpTool {
  id: string;
  name: string;
  type: McpToolType;
  scope: McpToolScope;
  description: string;
  endpoint: string | null;
  nativeModule: string | null;
  permissions: string[];
  enabled: boolean;
  builtIn?: boolean;
  schema: McpToolSchema | null;
  customHeaders?: CustomHeader[];
}

export interface McpToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// Runtime tool definition discovered from an MCP server
export interface DiscoveredTool {
  serverId: string;
  serverName: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ConversationParticipant {
  id: string;
  modelId: string;
  identityId: string | null;
  nickname?: string;
  reasoningEffort?: ReasoningEffort;
  /** Muted participants skip automatic rounds and AI @ propagation; explicit user mentions still reach them. */
  muted?: boolean;
}

export type SpeakingOrder = "sequential" | "random" | "parallel";

export interface Conversation {
  id: string;
  type: ConversationType;
  title: string;
  participants: ConversationParticipant[];
  speakingOrder?: SpeakingOrder;
  groupSystemPrompt?: string;
  lastMessage: string | null;
  lastMessageAt: string | null;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  /** Per-conversation workspace directory for AI file I/O (desktop only) */
  workspaceDir?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolResult {
  toolCallId: string;
  content: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export enum MessageStatus {
  PENDING = "pending",
  STREAMING = "streaming",
  SUCCESS = "success",
  ERROR = "error",
  PAUSED = "paused",
}

/** Special message kinds driving product flows (moderator summary, tasks). */
export type MessageKind = "summary-request" | "summary" | "task-request" | "task-result";

export enum MessageBlockType {
  MAIN_TEXT = "main_text",
  THINKING = "thinking",
  TOOL = "tool",
  IMAGE = "image",
  ERROR = "error",
}

export enum MessageBlockStatus {
  PENDING = "pending",
  STREAMING = "streaming",
  SUCCESS = "success",
  ERROR = "error",
}

export interface MessageBlock {
  id: string;
  messageId: string;
  type: MessageBlockType;
  content: string;
  status: MessageBlockStatus;
  metadata: Record<string, unknown> | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string | null;
}

export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  senderModelId: string | null;
  senderName: string | null;
  identityId: string | null;
  participantId: string | null;
  content: string;
  images: string[];
  generatedImages: string[];
  reasoningContent: string | null;
  reasoningDuration: number | null;
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  branchId: string | null;
  parentMessageId: string | null;
  /** @deprecated Use status instead */
  isStreaming: boolean;
  status: MessageStatus;
  errorMessage: string | null;
  tokenUsage: TokenUsage | null;
  createdAt: string;
  /** Optional product-level kind (e.g. moderator summary requests/results). */
  kind?: MessageKind;
}

/** Lifecycle of a discussion task: created → executing → done/failed, pausable. */
export type TaskStatus = "pending" | "running" | "paused" | "done" | "failed";

export interface Task {
  id: string;
  conversationId: string;
  title: string;
  description: string;
  assigneeParticipantId: string | null;
  status: TaskStatus;
  /** Message the task was promoted from (context anchor). */
  sourceMessageId: string | null;
  /** The task-request user message driving execution. */
  requestMessageId: string | null;
  /** The task-result assistant message with the outcome. */
  resultMessageId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatApiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatApiMessage {
  role: MessageRole;
  content: string | ChatApiContentPart[];
  name?: string;
  tool_calls?: ChatApiToolCall[];
  tool_call_id?: string;
}

export type ChatApiContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatApiRequest {
  model: string;
  messages: ChatApiMessage[];
  stream: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: ChatApiToolDef[];
  [key: string]: unknown;
}

export interface ChatApiToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatApiChoice {
  index: number;
  message: {
    role: string;
    content: string | null;
    reasoning_content?: string | null;
    tool_calls?: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
  };
  finish_reason: string;
}

export interface ChatApiResponse {
  id: string;
  choices: ChatApiChoice[];
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}
