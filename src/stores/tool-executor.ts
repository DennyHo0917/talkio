/**
 * Tool executor — builds the `execute` callback the AI SDK calls during its
 * managed tool loop. Owns Talkio's product logic around a tool call: per-tool
 * human approval, built-in vs MCP routing, and surfacing tool-produced images.
 *
 * The multi-round orchestration (call → execute → feed back → repeat) is owned
 * by the AI SDK (`stopWhen`), not by Talkio.
 */
import {
  executeBuiltInTool,
  getBuiltInToolDefs,
  type ToolContext,
} from "../services/built-in-tools";
import { executeMcpToolByName } from "../services/mcp";
import { toolApproval } from "../services/tool-approval";
import type { GenerationContext } from "./chat-generation";

/** Execute a single tool call against built-in tools or MCP, gated by approval. */
async function executeOneTool(
  name: string,
  args: Record<string, unknown>,
  builtInEnabledByName: Record<string, boolean>,
  identity: any,
  allowedBuiltInToolNames: Set<string> | null,
  allowedServerIds: string[] | undefined,
  toolContext: ToolContext | undefined,
  approvalContext: {
    conversationId: string;
    participantName: string;
    modelName: string;
    availableTools: Map<string, string | undefined>;
  },
): Promise<{ content: string; images?: string[] }> {
  const description = approvalContext.availableTools.get(name);
  if (!approvalContext.availableTools.has(name)) return { content: `Tool not found: ${name}` };

  const risk = /^(read_|get_|list_|search_|git_status|git_diff|git_log)/.test(name)
    ? "read"
    : /^(edit_|write_|delete_|apply_|git_)/.test(name)
      ? "write"
      : "network";
  const approved = await toolApproval.request({
    toolName: name,
    description,
    args,
    conversationId: approvalContext.conversationId,
    participantName: approvalContext.participantName,
    modelName: approvalContext.modelName,
    risk,
  });
  if (!approved) return { content: `Tool call rejected by user: ${name}` };

  const builtInGloballyEnabled = builtInEnabledByName[name] !== false;
  const builtInEnabledForIdentity =
    !!identity && allowedBuiltInToolNames != null && allowedBuiltInToolNames.has(name);
  const builtIn =
    builtInGloballyEnabled || builtInEnabledForIdentity
      ? await executeBuiltInTool(name, args, toolContext)
      : null;
  if (builtIn) {
    return builtIn.success
      ? { content: builtIn.content, images: builtIn.images }
      : { content: `Error: ${builtIn.error}` };
  }

  try {
    const remote = await executeMcpToolByName(name, args, allowedServerIds);
    if (remote) return { content: remote.success ? remote.content : `Error: ${remote.error}` };
  } catch (error) {
    return {
      content: `Error: ${error instanceof Error ? error.message : "MCP tool execution failed"}`,
    };
  }
  return { content: `Tool not found: ${name}` };
}

export interface ToolExecutorParams {
  ctx: GenerationContext;
  modelId: string;
  toolDefs: any[];
  identity: any;
  builtInEnabledByName: Record<string, boolean>;
  allowedBuiltInToolNames: Set<string> | null;
  allowedServerIds: string[] | undefined;
  toolContext?: ToolContext;
  /** Called with any images a tool produced (e.g. generate_image). */
  onImages?: (images: string[]) => void;
}

/**
 * Build the `execute` callback passed into the runtime. Returns the tool's
 * text result (fed back to the model by the SDK) and side-channels any images
 * onto the assistant message via `onImages`.
 */
export function createToolExecutor(
  p: ToolExecutorParams,
): (name: string, input: Record<string, unknown>) => Promise<string> {
  const availableTools = new Map<string, string | undefined>();
  for (const definition of [...getBuiltInToolDefs(p.toolContext), ...p.toolDefs]) {
    const tool = "function" in definition ? definition.function : definition;
    if (typeof tool?.name === "string") {
      availableTools.set(
        tool.name,
        typeof tool.description === "string" ? tool.description : undefined,
      );
    }
  }
  const participant = p.ctx.conversation.participants.find((c) => c.modelId === p.modelId);
  const approvalContext = {
    conversationId: p.ctx.cid,
    participantName: participant?.nickname ?? p.modelId,
    modelName: p.modelId,
    availableTools,
  };

  return async (name, input) => {
    const result = await executeOneTool(
      name,
      input,
      p.builtInEnabledByName,
      p.identity,
      p.allowedBuiltInToolNames,
      p.allowedServerIds,
      p.toolContext,
      approvalContext,
    );
    if (result.images?.length && p.onImages) p.onImages(result.images);
    return result.content;
  };
}
