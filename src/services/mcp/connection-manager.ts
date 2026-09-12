import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CustomHeader, DiscoveredTool, McpServer } from "../../types";
import { appFetch } from "../../lib/http";
import { TauriStdioTransport } from "./stdio-transport";

export type McpConnectionStatus = "idle" | "connecting" | "connected" | "error";
export type McpErrorCode = "NETWORK" | "AUTH" | "TIMEOUT" | "SERVER_ERROR" | "UNKNOWN";

function classifyError(err: unknown): McpErrorCode {
  if (err && typeof err === "object") {
    const status =
      (err as { status?: unknown; statusCode?: unknown }).status ??
      (err as { statusCode?: unknown }).statusCode;
    if (typeof status === "number") {
      if (status === 401 || status === 403) return "AUTH";
      if (status === 408 || status === 504) return "TIMEOUT";
      if (status >= 500 && status <= 599) return "SERVER_ERROR";
    }
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (
    msg.includes("401") ||
    msg.includes("403") ||
    msg.includes("Unauthorized") ||
    msg.includes("Forbidden")
  )
    return "AUTH";
  if (msg.includes("timeout") || msg.includes("Timeout") || msg.includes("ETIMEDOUT"))
    return "TIMEOUT";
  if (msg.includes("500") || msg.includes("502") || msg.includes("503") || msg.includes("504"))
    return "SERVER_ERROR";
  if (
    msg.includes("Network") ||
    msg.includes("network") ||
    msg.includes("fetch") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("ENOTFOUND")
  )
    return "NETWORK";
  return "UNKNOWN";
}

interface ManagedConnection {
  client: Client;
  server: McpServer;
  serverSignature: string;
  tools: DiscoveredTool[];
  toolsDiscoveredAt: number;
  connected: boolean;
  connecting: Promise<void> | null;
}

function buildRequestInit(customHeaders?: CustomHeader[]): RequestInit | undefined {
  if (!customHeaders?.length) return undefined;
  const headers: Record<string, string> = {};
  for (const h of customHeaders) {
    if (h.name && h.value) headers[h.name] = h.value;
  }
  return { headers };
}

function getServerSignature(server: McpServer): string {
  return JSON.stringify({
    type: server.type ?? "http",
    url: server.url,
    headers: server.customHeaders ?? [],
    command: server.command ?? "",
    args: server.args ?? [],
    env: server.env ?? {},
  });
}

class McpConnectionManager {
  private connections = new Map<string, ManagedConnection>();

  private readonly TOOLS_TTL = 5 * 60 * 1000;

  async ensureConnected(server: McpServer): Promise<ManagedConnection> {
    const nextSignature = getServerSignature(server);
    let existing = this.connections.get(server.id);

    if (existing && existing.serverSignature !== nextSignature) {
      this.disconnect(server.id);
      existing = undefined;
    }

    if (existing?.connected) return existing;
    if (existing?.connecting) {
      await existing.connecting;
      const resolved = this.connections.get(server.id);
      if (!resolved)
        throw new Error(`[MCP] Connection lost for server ${server.id} during connect`);
      return resolved;
    }

    const conn: ManagedConnection = {
      client: null!,
      server,
      serverSignature: nextSignature,
      tools: [],
      toolsDiscoveredAt: 0,
      connected: false,
      connecting: null,
    };
    this.connections.set(server.id, conn);

    conn.connecting = this.connect(conn)
      .catch((err) => {
        this.connections.delete(server.id);
        throw err;
      })
      .finally(() => {
        const current = this.connections.get(server.id);
        if (current) current.connecting = null;
      });
    await conn.connecting;
    return conn;
  }

  private async connect(conn: ManagedConnection): Promise<void> {
    let transport: Transport;
    if (conn.server.type === "stdio" && conn.server.command) {
      transport = new TauriStdioTransport(
        conn.server.command,
        conn.server.args ?? [],
        conn.server.env,
      );
    } else {
      transport = new StreamableHTTPClientTransport(new URL(conn.server.url), {
        requestInit: buildRequestInit(conn.server.customHeaders),
        fetch: appFetch,
      });
    }
    const client = new Client({ name: "talkio-web", version: "2.0.0" }, { capabilities: {} });
    await client.connect(transport);

    conn.client = client;
    conn.connected = true;

    const { tools } = await client.listTools();
    conn.tools = (tools ?? []).map((t) => ({
      serverId: conn.server.id,
      serverName: conn.server.name,
      name: t.name,
      description: t.description ?? "",
      inputSchema: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
    }));
    conn.toolsDiscoveredAt = Date.now();
  }

  async discoverTools(server: McpServer): Promise<DiscoveredTool[]> {
    const conn = await this.ensureConnected(server);

    if (Date.now() - conn.toolsDiscoveredAt > this.TOOLS_TTL) {
      try {
        const { tools } = await conn.client.listTools();
        conn.tools = (tools ?? []).map((t) => ({
          serverId: conn.server.id,
          serverName: conn.server.name,
          name: t.name,
          description: t.description ?? "",
          inputSchema: (t.inputSchema ?? { type: "object", properties: {} }) as Record<
            string,
            unknown
          >,
        }));
        conn.toolsDiscoveredAt = Date.now();
      } catch {
        // keep stale cache
      }
    }

    return conn.tools;
  }

  async callTool(
    server: McpServer,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ success: boolean; content: string; error?: string; errorCode?: McpErrorCode }> {
    let conn: ManagedConnection;
    try {
      conn = await this.ensureConnected(server);
    } catch (err) {
      return {
        success: false,
        content: "",
        error: `Connection failed: ${err instanceof Error ? err.message : "Unknown"}`,
        errorCode: classifyError(err),
      };
    }

    try {
      const result = await conn.client.callTool({ name: toolName, arguments: args });
      const contentArray = Array.isArray(result.content) ? result.content : [];
      const textParts = contentArray
        .map((item: any) => {
          if (typeof item === "string") return item;
          if (item.type === "text") return item.text ?? "";
          return JSON.stringify(item);
        })
        .join("\n");

      if (result.isError) {
        return {
          success: false,
          content: "",
          error: textParts || "Tool execution failed",
          errorCode: "SERVER_ERROR",
        };
      }
      return { success: true, content: textParts || JSON.stringify(result) };
    } catch (err) {
      this.disconnect(server.id);
      return {
        success: false,
        content: "",
        error: err instanceof Error ? err.message : "Network error",
        errorCode: classifyError(err),
      };
    }
  }

  disconnect(serverId: string): void {
    const conn = this.connections.get(serverId);
    if (conn) {
      void conn.client?.close().catch((error) => {
        console.warn(`[MCP] Failed to close connection ${serverId}`, error);
      });
      this.connections.delete(serverId);
    }
  }

  reset(serverId: string): void {
    this.disconnect(serverId);
  }

  syncServers(activeServerIds: string[]): void {
    const active = new Set(activeServerIds);
    for (const serverId of this.connections.keys()) {
      if (!active.has(serverId)) this.disconnect(serverId);
    }
  }

  getConnectionStatus(serverId: string): McpConnectionStatus {
    const conn = this.connections.get(serverId);
    if (!conn) return "idle";
    if (conn.connecting) return "connecting";
    if (conn.connected) return "connected";
    return "idle";
  }
}

export const mcpConnectionManager = new McpConnectionManager();
