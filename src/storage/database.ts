/**
 * Tauri SQLite database layer — replaces drizzle-orm/expo-sqlite.
 * Uses @tauri-apps/plugin-sql for SQLite access.
 * API matches the RN version's database.ts exports.
 */
import type { Message, Conversation, MessageBlock, Task } from "../types";
import { MessageStatus, MessageBlockType, MessageBlockStatus } from "../types";

// Dynamic import to avoid SSR issues and allow fallback
let _db: any = null;

async function getDb() {
  if (_db) return _db;
  try {
    const { default: Database } = await import("@tauri-apps/plugin-sql");
    _db = await Database.load("sqlite:talkio.db");
  } catch {
    // Fallback: SQLite WASM for dev/browser preview. This keeps SQL semantics
    // identical to the Tauri database instead of maintaining a SQL parser.
    console.warn("[DB] Tauri SQL plugin not available, using sql.js in-memory database");
    _db = await createInMemoryDb();
  }
  return _db;
}

// ─── In-Memory Fallback (for browser dev) ───
async function createInMemoryDb() {
  const { default: initSqlJs } = await import("sql.js");
  const SQL = await initSqlJs({
    // Keep the asset path static so Vite emits the WASM file instead of
    // interpreting the template URL as an import glob.
    locateFile: () => new URL("sql.js/dist/sql-wasm.wasm", import.meta.url).toString(),
  });
  const sqlite = new SQL.Database();
  const bind = (sql: string, params: any[]) => {
    const stmt = sqlite.prepare(sql);
    stmt.bind(params);
    return stmt;
  };
  return {
    execute: async (sql: string, params: any[] = []) => {
      const stmt = bind(sql, params);
      try {
        while (stmt.step()) {
          // Consume all rows for statements that return them.
        }
        return { rowsAffected: sqlite.getRowsModified() };
      } finally {
        stmt.free();
      }
    },
    select: async <T = any>(sql: string, params: any[] = []): Promise<T[]> => {
      const stmt = bind(sql, params);
      try {
        const rows: T[] = [];
        while (stmt.step()) rows.push(stmt.getAsObject() as T);
        return rows;
      } finally {
        stmt.free();
      }
    },
  };
}

// ─── JSON Helpers ───
function safeJsonParse<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return value as T; // already parsed object
  if (!value) return fallback;
  if (value === "[]") return [] as unknown as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToConversation(row: any): Conversation {
  return {
    id: row.id,
    type: row.type || "single",
    title: row.title || "",
    participants: safeJsonParse(row.participants, []),
    speakingOrder: row.speakingOrder ?? undefined,
    lastMessage: row.lastMessage ?? null,
    lastMessageAt: row.lastMessageAt ?? null,
    pinned: row.pinned === 1,
    archived: row.archived === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    workspaceDir: row.workspaceDir ?? undefined,
    groupSystemPrompt: row.groupSystemPrompt ?? undefined,
  };
}

function rowToMessage(row: any): Message {
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role,
    senderModelId: row.senderModelId ?? null,
    senderName: row.senderName ?? null,
    identityId: row.identityId ?? null,
    participantId: row.participantId ?? null,
    content: row.content || "",
    images: safeJsonParse(row.images, []),
    generatedImages: safeJsonParse(row.generatedImages, []),
    reasoningContent: row.reasoningContent ?? null,
    reasoningDuration: row.reasoningDuration ?? null,
    toolCalls: safeJsonParse(row.toolCalls, []),
    toolResults: safeJsonParse(row.toolResults, []),
    branchId: row.branchId ?? null,
    parentMessageId: row.parentMessageId ?? null,
    isStreaming: row.isStreaming === 1,
    status: (row.status as MessageStatus) || MessageStatus.SUCCESS,
    errorMessage: row.errorMessage ?? null,
    tokenUsage: safeJsonParse(row.tokenUsage, null),
    createdAt: row.createdAt,
    kind: row.kind ?? undefined,
  };
}

function rowToBlock(row: any): MessageBlock {
  return {
    id: row.id,
    messageId: row.messageId,
    type: row.type as MessageBlockType,
    content: row.content || "",
    status: row.status as MessageBlockStatus,
    metadata: safeJsonParse(row.metadata, null),
    sortOrder: row.sortOrder ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt ?? null,
  };
}

// ─── Init ───
export async function initDatabase(): Promise<void> {
  const db = await getDb();
  await db.execute(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'single',
      title TEXT NOT NULL DEFAULT '',
      participants TEXT NOT NULL DEFAULT '[]',
      speakingOrder TEXT,
      lastMessage TEXT,
      lastMessageAt TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )
  `);
  // Migration: add speakingOrder column for databases created before this field existed
  try {
    await db.execute(`ALTER TABLE conversations ADD COLUMN speakingOrder TEXT`);
  } catch {
    /* column already exists */
  }
  // Migration: add workspaceDir column
  try {
    await db.execute(`ALTER TABLE conversations ADD COLUMN workspaceDir TEXT`);
  } catch {
    /* column already exists */
  }
  // Migration: add groupSystemPrompt column
  try {
    await db.execute(`ALTER TABLE conversations ADD COLUMN groupSystemPrompt TEXT`);
  } catch {
    /* column already exists */
  }
  try {
    await db.execute(`ALTER TABLE conversations ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`);
  } catch {
    /* column already exists */
  }

  await db.execute(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversationId TEXT NOT NULL,
      role TEXT NOT NULL,
      senderModelId TEXT,
      senderName TEXT,
      identityId TEXT,
      participantId TEXT,
      content TEXT NOT NULL DEFAULT '',
      images TEXT NOT NULL DEFAULT '[]',
      generatedImages TEXT NOT NULL DEFAULT '[]',
      reasoningContent TEXT,
      reasoningDuration REAL,
      toolCalls TEXT NOT NULL DEFAULT '[]',
      toolResults TEXT NOT NULL DEFAULT '[]',
      branchId TEXT,
      parentMessageId TEXT,
      isStreaming INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'success',
      errorMessage TEXT,
      tokenUsage TEXT,
      createdAt TEXT NOT NULL,
      FOREIGN KEY (conversationId) REFERENCES conversations(id) ON DELETE CASCADE
    )
  `);
  await db.execute(
    `CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversationId)`,
  );
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_messages_branch ON messages(branchId)`);
  await db.execute(
    `CREATE INDEX IF NOT EXISTS idx_messages_conv_branch_created ON messages(conversationId, branchId, createdAt)`,
  );
  // Migration: add kind column (moderator summary requests/results, task flows).
  // Runs after CREATE TABLE messages so fresh databases get the column too.
  try {
    await db.execute(`ALTER TABLE messages ADD COLUMN kind TEXT`);
  } catch {
    /* column already exists */
  }
  await db.execute(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      conversationId TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      assigneeParticipantId TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      sourceMessageId TEXT,
      requestMessageId TEXT,
      resultMessageId TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (conversationId) REFERENCES conversations(id) ON DELETE CASCADE
    )
  `);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_tasks_conversation ON tasks(conversationId)`);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS message_blocks (
      id TEXT PRIMARY KEY,
      messageId TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'main_text',
      content TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'success',
      metadata TEXT,
      sortOrder INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT,
      FOREIGN KEY (messageId) REFERENCES messages(id) ON DELETE CASCADE
    )
  `);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_blocks_message ON message_blocks(messageId)`);
}

// ─── Conversations ───
export async function insertConversation(conv: Conversation): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO conversations (id, type, title, participants, speakingOrder, lastMessage, lastMessageAt, pinned, archived, createdAt, updatedAt, workspaceDir, groupSystemPrompt)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      conv.id,
      conv.type,
      conv.title,
      JSON.stringify(conv.participants),
      conv.speakingOrder ?? null,
      conv.lastMessage,
      conv.lastMessageAt,
      conv.pinned ? 1 : 0,
      conv.archived ? 1 : 0,
      conv.createdAt,
      conv.updatedAt,
      conv.workspaceDir ?? null,
      conv.groupSystemPrompt ?? null,
    ],
  );
}

export async function updateConversation(
  id: string,
  updates: Partial<Conversation>,
): Promise<void> {
  const db = await getDb();
  const sets: string[] = ["updatedAt = $1"];
  const params: any[] = [new Date().toISOString()];
  let idx = 2;

  if (updates.type !== undefined) {
    sets.push(`type = $${idx}`);
    params.push(updates.type);
    idx++;
  }
  if (updates.title !== undefined) {
    sets.push(`title = $${idx}`);
    params.push(updates.title);
    idx++;
  }
  if (updates.participants !== undefined) {
    sets.push(`participants = $${idx}`);
    params.push(JSON.stringify(updates.participants));
    idx++;
  }
  if (updates.lastMessage !== undefined) {
    sets.push(`lastMessage = $${idx}`);
    params.push(updates.lastMessage);
    idx++;
  }
  if (updates.lastMessageAt !== undefined) {
    sets.push(`lastMessageAt = $${idx}`);
    params.push(updates.lastMessageAt);
    idx++;
  }
  if (updates.pinned !== undefined) {
    sets.push(`pinned = $${idx}`);
    params.push(updates.pinned ? 1 : 0);
    idx++;
  }
  if (updates.archived !== undefined) {
    sets.push(`archived = $${idx}`);
    params.push(updates.archived ? 1 : 0);
    idx++;
  }
  if (updates.speakingOrder !== undefined) {
    sets.push(`speakingOrder = $${idx}`);
    params.push(updates.speakingOrder);
    idx++;
  }
  if (updates.workspaceDir !== undefined) {
    sets.push(`workspaceDir = $${idx}`);
    params.push(updates.workspaceDir || null);
    idx++;
  }
  if (updates.groupSystemPrompt !== undefined) {
    sets.push(`groupSystemPrompt = $${idx}`);
    params.push(updates.groupSystemPrompt || null);
    idx++;
  }

  params.push(id);
  await db.execute(`UPDATE conversations SET ${sets.join(", ")} WHERE id = $${idx}`, params);
}

export async function deleteConversation(id: string): Promise<void> {
  const db = await getDb();
  await db.execute(`DELETE FROM tasks WHERE conversationId = $1`, [id]);
  await db.execute(`DELETE FROM messages WHERE conversationId = $1`, [id]);
  await db.execute(`DELETE FROM conversations WHERE id = $1`, [id]);
}

export async function deleteAllConversations(): Promise<void> {
  const db = await getDb();
  await db.execute(`DELETE FROM tasks`);
  await db.execute(`DELETE FROM messages`);
  await db.execute(`DELETE FROM conversations`);
}

export async function getAllConversations(): Promise<Conversation[]> {
  const db = await getDb();
  const rows = await db.select(`SELECT * FROM conversations ORDER BY pinned DESC, updatedAt DESC`);
  return rows.map(rowToConversation);
}

export async function getConversation(id: string): Promise<Conversation | null> {
  const db = await getDb();
  const rows = await db.select(`SELECT * FROM conversations WHERE id = $1 LIMIT 1`, [id]);
  return rows.length > 0 ? rowToConversation(rows[0]) : null;
}

// ─── Messages ───
export async function insertMessage(msg: Message): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO messages (id, conversationId, role, senderModelId, senderName, identityId, participantId,
     content, images, generatedImages, reasoningContent, reasoningDuration,
     toolCalls, toolResults, branchId, parentMessageId, isStreaming, status, errorMessage, tokenUsage, createdAt, kind)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
    [
      msg.id,
      msg.conversationId,
      msg.role,
      msg.senderModelId,
      msg.senderName,
      msg.identityId,
      msg.participantId,
      msg.content,
      JSON.stringify(msg.images ?? []),
      JSON.stringify(msg.generatedImages ?? []),
      msg.reasoningContent,
      msg.reasoningDuration,
      JSON.stringify(msg.toolCalls),
      JSON.stringify(msg.toolResults),
      msg.branchId,
      msg.parentMessageId,
      msg.isStreaming ? 1 : 0,
      msg.status ?? MessageStatus.SUCCESS,
      msg.errorMessage ?? null,
      msg.tokenUsage ? JSON.stringify(msg.tokenUsage) : null,
      msg.createdAt,
      msg.kind ?? null,
    ],
  );
}

export async function updateMessage(id: string, updates: Partial<Message>): Promise<void> {
  const db = await getDb();
  const sets: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (updates.content !== undefined) {
    sets.push(`content = $${idx}`);
    params.push(updates.content);
    idx++;
  }
  if (updates.images !== undefined) {
    sets.push(`images = $${idx}`);
    params.push(JSON.stringify(updates.images));
    idx++;
  }
  if (updates.generatedImages !== undefined) {
    sets.push(`generatedImages = $${idx}`);
    params.push(JSON.stringify(updates.generatedImages));
    idx++;
  }
  if (updates.reasoningContent !== undefined) {
    sets.push(`reasoningContent = $${idx}`);
    params.push(updates.reasoningContent);
    idx++;
  }
  if (updates.reasoningDuration !== undefined) {
    sets.push(`reasoningDuration = $${idx}`);
    params.push(updates.reasoningDuration);
    idx++;
  }
  if (updates.toolCalls !== undefined) {
    sets.push(`toolCalls = $${idx}`);
    params.push(JSON.stringify(updates.toolCalls));
    idx++;
  }
  if (updates.toolResults !== undefined) {
    sets.push(`toolResults = $${idx}`);
    params.push(JSON.stringify(updates.toolResults));
    idx++;
  }
  if (updates.isStreaming !== undefined) {
    sets.push(`isStreaming = $${idx}`);
    params.push(updates.isStreaming ? 1 : 0);
    idx++;
  }
  if (updates.status !== undefined) {
    sets.push(`status = $${idx}`);
    params.push(updates.status);
    idx++;
  }
  if (updates.errorMessage !== undefined) {
    sets.push(`errorMessage = $${idx}`);
    params.push(updates.errorMessage);
    idx++;
  }
  if (updates.kind !== undefined) {
    sets.push(`kind = $${idx}`);
    params.push(updates.kind);
    idx++;
  }
  if (updates.tokenUsage !== undefined) {
    sets.push(`tokenUsage = $${idx}`);
    params.push(updates.tokenUsage ? JSON.stringify(updates.tokenUsage) : null);
    idx++;
  }
  if (updates.participantId !== undefined) {
    sets.push(`participantId = $${idx}`);
    params.push(updates.participantId);
    idx++;
  }

  if (sets.length === 0) return;
  params.push(id);
  await db.execute(`UPDATE messages SET ${sets.join(", ")} WHERE id = $${idx}`, params);
}

export async function getMessages(
  conversationId: string,
  branchId?: string | null,
  limit = 100,
  offset = 0,
): Promise<Message[]> {
  const db = await getDb();
  let rows: any[];
  if (branchId) {
    rows = await db.select(
      `SELECT * FROM messages WHERE conversationId = $1 AND branchId = $2 ORDER BY createdAt ASC LIMIT $3 OFFSET $4`,
      [conversationId, branchId, limit, offset],
    );
  } else {
    rows = await db.select(
      `SELECT * FROM messages WHERE conversationId = $1 AND branchId IS NULL ORDER BY createdAt ASC LIMIT $2 OFFSET $3`,
      [conversationId, limit, offset],
    );
  }
  return rows.map(rowToMessage);
}

export async function getRecentMessages(
  conversationId: string,
  branchId?: string | null,
  limit = 40,
): Promise<Message[]> {
  const db = await getDb();
  let rows: any[];
  if (branchId) {
    rows = await db.select(
      `SELECT * FROM messages WHERE conversationId = $1 AND branchId = $2 ORDER BY createdAt DESC LIMIT $3`,
      [conversationId, branchId, limit],
    );
  } else {
    rows = await db.select(
      `SELECT * FROM messages WHERE conversationId = $1 AND branchId IS NULL ORDER BY createdAt DESC LIMIT $2`,
      [conversationId, limit],
    );
  }
  return rows.map(rowToMessage).reverse();
}

export async function getMessagesBefore(
  conversationId: string,
  branchId: string | null | undefined,
  before: string,
  limit = 40,
): Promise<Message[]> {
  const db = await getDb();
  let rows: any[];
  if (branchId) {
    rows = await db.select(
      `SELECT * FROM messages WHERE conversationId = $1 AND branchId = $2 AND createdAt < $3 ORDER BY createdAt DESC LIMIT $4`,
      [conversationId, branchId, before, limit],
    );
  } else {
    rows = await db.select(
      `SELECT * FROM messages WHERE conversationId = $1 AND branchId IS NULL AND createdAt < $2 ORDER BY createdAt DESC LIMIT $3`,
      [conversationId, before, limit],
    );
  }
  return rows.map(rowToMessage).reverse();
}

export async function searchMessages(query: string): Promise<Message[]> {
  const db = await getDb();
  const rows = await db.select(
    `SELECT * FROM messages WHERE content LIKE $1 ORDER BY createdAt DESC LIMIT 50`,
    [`%${query}%`],
  );
  return rows.map(rowToMessage);
}

export async function deleteMessage(id: string): Promise<void> {
  const db = await getDb();
  await db.execute(`DELETE FROM message_blocks WHERE messageId = $1`, [id]);
  await db.execute(`DELETE FROM messages WHERE id = $1`, [id]);
}

export async function getAllMessagesForConversation(conversationId: string): Promise<Message[]> {
  const db = await getDb();
  const rows = await db.select(
    `SELECT * FROM messages WHERE conversationId = $1 ORDER BY createdAt ASC`,
    [conversationId],
  );
  return rows.map(rowToMessage);
}

export async function getAllMessagesForConversationBranch(
  conversationId: string,
  branchId?: string | null,
): Promise<Message[]> {
  const db = await getDb();
  const rows = branchId
    ? await db.select(
        `SELECT * FROM messages WHERE conversationId = $1 AND branchId = $2 ORDER BY createdAt ASC`,
        [conversationId, branchId],
      )
    : await db.select(
        `SELECT * FROM messages WHERE conversationId = $1 AND branchId IS NULL ORDER BY createdAt ASC`,
        [conversationId],
      );
  return rows.map(rowToMessage);
}

export async function getAllMessages(): Promise<Message[]> {
  const db = await getDb();
  const rows = await db.select(`SELECT * FROM messages ORDER BY createdAt ASC`);
  return rows.map(rowToMessage);
}

/**
 * File names in `generatedImages` that some message still points at.
 *
 * Reads just that one column rather than whole messages: this only feeds the
 * orphan-image sweep, which runs over the entire table.
 */
export async function getReferencedImageNames(): Promise<Set<string>> {
  const db = await getDb();
  const rows: Array<{ generatedImages: string }> = await db.select(
    `SELECT generatedImages FROM messages WHERE generatedImages != '[]'`,
  );
  const names = new Set<string>();
  for (const row of rows) {
    for (const ref of safeJsonParse<string[]>(row.generatedImages, [])) names.add(ref);
  }
  return names;
}

export async function clearMessages(conversationId: string): Promise<void> {
  const db = await getDb();
  await db.execute(`DELETE FROM tasks WHERE conversationId = $1`, [conversationId]);
  await db.execute(`DELETE FROM messages WHERE conversationId = $1`, [conversationId]);
}

export async function insertMessages(msgs: Message[]): Promise<void> {
  if (msgs.length === 0) return;
  const db = await getDb();
  try {
    await db.execute("BEGIN TRANSACTION");
  } catch {
    /* in-memory fallback doesn't support transactions */
  }
  try {
    for (const msg of msgs) {
      await insertMessage(msg);
    }
    try {
      await db.execute("COMMIT");
    } catch {}
  } catch (err) {
    try {
      await db.execute("ROLLBACK");
    } catch {}
    throw err;
  }
}

// ─── Message Blocks ───
export async function insertBlock(block: MessageBlock): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO message_blocks (id, messageId, type, content, status, metadata, sortOrder, createdAt, updatedAt)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      block.id,
      block.messageId,
      block.type,
      block.content,
      block.status,
      block.metadata ? JSON.stringify(block.metadata) : null,
      block.sortOrder,
      block.createdAt,
      block.updatedAt,
    ],
  );
}

export async function updateBlock(id: string, updates: Partial<MessageBlock>): Promise<void> {
  const db = await getDb();
  const sets: string[] = [`updatedAt = $1`];
  const params: any[] = [new Date().toISOString()];
  let idx = 2;

  if (updates.content !== undefined) {
    sets.push(`content = $${idx}`);
    params.push(updates.content);
    idx++;
  }
  if (updates.status !== undefined) {
    sets.push(`status = $${idx}`);
    params.push(updates.status);
    idx++;
  }
  if (updates.type !== undefined) {
    sets.push(`type = $${idx}`);
    params.push(updates.type);
    idx++;
  }
  if (updates.metadata !== undefined) {
    sets.push(`metadata = $${idx}`);
    params.push(updates.metadata ? JSON.stringify(updates.metadata) : null);
    idx++;
  }
  if (updates.sortOrder !== undefined) {
    sets.push(`sortOrder = $${idx}`);
    params.push(updates.sortOrder);
    idx++;
  }

  if (sets.length <= 1) return;
  params.push(id);
  await db.execute(`UPDATE message_blocks SET ${sets.join(", ")} WHERE id = $${idx}`, params);
}

export async function getBlocksByMessageId(messageId: string): Promise<MessageBlock[]> {
  const db = await getDb();
  const rows = await db.select(
    `SELECT * FROM message_blocks WHERE messageId = $1 ORDER BY sortOrder ASC`,
    [messageId],
  );
  return rows.map(rowToBlock);
}

export async function getAllBlocks(): Promise<MessageBlock[]> {
  const db = await getDb();
  const rows = await db.select(
    `SELECT * FROM message_blocks ORDER BY createdAt ASC, sortOrder ASC`,
  );
  return rows.map(rowToBlock);
}

export async function getAllTasks(): Promise<Task[]> {
  const db = await getDb();
  const rows = await db.select(`SELECT * FROM tasks ORDER BY createdAt ASC`);
  return rows.map(rowToTask);
}

export async function replaceChatData(args: {
  conversations: Conversation[];
  messages: Message[];
  messageBlocks: MessageBlock[];
  tasks: Task[];
}): Promise<void> {
  const conversationIds = new Set(args.conversations.map((conversation) => conversation.id));
  const messageIds = new Set(args.messages.map((message) => message.id));
  if (args.messages.some((message) => !conversationIds.has(message.conversationId))) {
    throw new Error("Backup contains a message without its conversation");
  }
  if (args.messageBlocks.some((block) => !messageIds.has(block.messageId))) {
    throw new Error("Backup contains a message block without its message");
  }
  if (args.tasks.some((task) => !conversationIds.has(task.conversationId))) {
    throw new Error("Backup contains a task without its conversation");
  }

  const db = await getDb();
  await db.execute("BEGIN TRANSACTION");
  try {
    await db.execute(`DELETE FROM tasks`);
    await db.execute(`DELETE FROM message_blocks`);
    await db.execute(`DELETE FROM messages`);
    await db.execute(`DELETE FROM conversations`);
    for (const conversation of args.conversations) await insertConversation(conversation);
    for (const message of args.messages) await insertMessage(message);
    for (const block of args.messageBlocks) await insertBlock(block);
    for (const task of args.tasks) await insertTask(task);
    await db.execute("COMMIT");
  } catch (error) {
    try {
      await db.execute("ROLLBACK");
    } catch {
      // Preserve the restore error if rollback itself fails.
    }
    throw error;
  }
}

export async function deleteBlocksByMessageId(messageId: string): Promise<void> {
  const db = await getDb();
  await db.execute(`DELETE FROM message_blocks WHERE messageId = $1`, [messageId]);
}

// ─── Tasks ───
function rowToTask(row: any): Task {
  return {
    id: row.id,
    conversationId: row.conversationId,
    title: row.title || "",
    description: row.description || "",
    assigneeParticipantId: row.assigneeParticipantId ?? null,
    status: row.status,
    sourceMessageId: row.sourceMessageId ?? null,
    requestMessageId: row.requestMessageId ?? null,
    resultMessageId: row.resultMessageId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function insertTask(task: Task): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO tasks (id, conversationId, title, description, assigneeParticipantId, status,
     sourceMessageId, requestMessageId, resultMessageId, createdAt, updatedAt)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      task.id,
      task.conversationId,
      task.title,
      task.description,
      task.assigneeParticipantId,
      task.status,
      task.sourceMessageId,
      task.requestMessageId,
      task.resultMessageId,
      task.createdAt,
      task.updatedAt,
    ],
  );
}

export async function updateTask(id: string, updates: Partial<Task>): Promise<void> {
  const db = await getDb();
  const sets: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (updates.title !== undefined) {
    sets.push(`title = $${idx}`);
    params.push(updates.title);
    idx++;
  }
  if (updates.description !== undefined) {
    sets.push(`description = $${idx}`);
    params.push(updates.description);
    idx++;
  }
  if (updates.assigneeParticipantId !== undefined) {
    sets.push(`assigneeParticipantId = $${idx}`);
    params.push(updates.assigneeParticipantId);
    idx++;
  }
  if (updates.status !== undefined) {
    sets.push(`status = $${idx}`);
    params.push(updates.status);
    idx++;
  }
  if (updates.sourceMessageId !== undefined) {
    sets.push(`sourceMessageId = $${idx}`);
    params.push(updates.sourceMessageId);
    idx++;
  }
  if (updates.requestMessageId !== undefined) {
    sets.push(`requestMessageId = $${idx}`);
    params.push(updates.requestMessageId);
    idx++;
  }
  if (updates.resultMessageId !== undefined) {
    sets.push(`resultMessageId = $${idx}`);
    params.push(updates.resultMessageId);
    idx++;
  }
  sets.push(`updatedAt = $${idx}`);
  params.push(new Date().toISOString());
  idx++;

  if (sets.length === 0) return;
  params.push(id);
  await db.execute(`UPDATE tasks SET ${sets.join(", ")} WHERE id = $${idx}`, params);
}

export async function getTaskById(id: string): Promise<Task | null> {
  const db = await getDb();
  const rows = await db.select(`SELECT * FROM tasks WHERE id = $1`, [id]);
  return rows.length > 0 ? rowToTask(rows[0]) : null;
}

export async function getTasksByConversation(conversationId: string): Promise<Task[]> {
  const db = await getDb();
  const rows = await db.select(`SELECT * FROM tasks WHERE conversationId = $1 ORDER BY createdAt`, [
    conversationId,
  ]);
  return rows.map(rowToTask);
}

export async function clearTasks(conversationId: string): Promise<void> {
  const db = await getDb();
  await db.execute(`DELETE FROM tasks WHERE conversationId = $1`, [conversationId]);
}

// Re-exports for compatibility
export {
  updateMessage as dbUpdateMessage,
  deleteConversation as dbDeleteConversation,
  updateConversation as dbUpdateConversation,
  getMessages as dbGetMessages,
  getRecentMessages as dbGetRecentMessages,
  getMessagesBefore as dbGetMessagesBefore,
  searchMessages as dbSearchMessages,
  deleteMessage as dbDeleteMessage,
  clearMessages as dbClearMessages,
  insertMessages as dbInsertMessages,
};
