/**
 * Tool executor — builds the `execute` callback the AI SDK calls during its
 * managed tool loop. Owns built-in vs MCP routing and surfaces tool-produced
 * images.
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
import type { GenerationContext } from "./chat-generation";
import type { Identity } from "../types";

/** Execute a single tool call against built-in tools or MCP. */
async function executeOneTool(
  name: string,
  args: Record<string, unknown>,
  builtInEnabledByName: Record<string, boolean>,
  identity: Identity | null | undefined,
  allowedBuiltInToolNames: Set<string> | null,
  allowedServerIds: string[] | undefined,
  toolContext: ToolContext | undefined,
  availableTools: Set<string>,
): Promise<{ content: string; images?: string[] }> {
  if (!availableTools.has(name)) return { content: `Tool not found: ${name}` };

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
  toolDefs: Array<{ function: { name: string; description?: string } }>;
  identity: Identity | null | undefined;
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
  const availableTools = new Set<string>([
    ...getBuiltInToolDefs(p.toolContext).map((definition) => definition.function.name),
    ...p.toolDefs.map((definition) => definition.function.name),
  ]);
  let executionTail: Promise<void> = Promise.resolve();

  return (name, input) => {
    const execute = async () => {
      if (p.toolContext?.signal?.aborted) {
        throw new DOMException("Tool execution aborted", "AbortError");
      }
      const result = await executeOneTool(
        name,
        input,
        p.builtInEnabledByName,
        p.identity,
        p.allowedBuiltInToolNames,
        p.allowedServerIds,
        p.toolContext,
        availableTools,
      );
      if (result.images?.length && p.onImages) p.onImages(result.images);
      return result.content;
    };
    const pending = executionTail.then(execute);
    executionTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  };
}
