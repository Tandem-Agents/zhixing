/**
 * Memory 工具 — AI 自主管理记忆
 *
 * Phase M2 核心交付：让 AI 可以保存、查询、更新和删除用户记忆。
 *
 * 支持的操作：
 * - save: 保存一条记忆（profile / person）
 * - search: 搜索记忆
 * - list: 列出某类别下所有记忆
 * - update: 更新已有记忆
 * - delete: 删除记忆
 *
 * 设计要点：
 * - 所有写操作对用户透明（工具调用在 CLI 中可见）
 * - 记忆文件为 Markdown + YAML frontmatter，用户可用编辑器直接修改
 * - memory 工具的 description 指导 AI 何时主动保存记忆
 */

import type { ToolDefinition, ToolResult } from "@zhixing/core";
import type { MemoryStore, MemoryCategory } from "@zhixing/core";

const MEMORY_SYSTEM_PROMPT_HINTS: readonly string[] = [
  "- Use `memory` to save, search, and manage stable personal memories (identity, preferences, relationships)",
  "- Only consider saving information that is likely to be useful long-term; confirm first unless the user explicitly asked you to remember it",
];

/**
 * store 由装配期注入（单一 scoped 实例，与 flush strategy 共用）—— 工具不再
 * 自建 `new MemoryStore()`，杜绝双实例与工作场景下写穿个人记忆域。
 */
export function createMemoryTool(store: MemoryStore): ToolDefinition {

  return {
    name: "memory",
    description:
      "Manage the user's persistent memory across three categories:\n" +
      "  - profile : the user's own identity (id is always 'profile')\n" +
      "  - person  : people in the user's life (id like 'wife-xiaoli')\n" +
      "\n" +
      "Actions and required fields:\n" +
      "  - save   : category + id + meta + content (create new entry)\n" +
      "  - update : category + id + meta + content (replace existing entry)\n" +
      "  - delete : category + id\n" +
      "  - list   : category (enumerates entries in that category; call once per category to scan all)\n" +
      "  - search : query (category optional; narrows scope when provided)\n" +
      "\n" +
      "Use this whenever the user asks to remember/recall something, or when you discover personal " +
      "information worth keeping (name, preferences, relationships). " +
      "Confirm with the user before saving new memories unless they explicitly asked you to remember.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "The action to perform",
          enum: ["save", "search", "list", "update", "delete"],
        },
        category: {
          type: "string",
          description:
            "Memory category: 'profile' (user identity), 'person' (relationships)",
          enum: ["profile", "person"],
        },
        id: {
          type: "string",
          description:
            "Memory ID (filename without .md). For profile, always use 'profile'. " +
            "For person, use a slug like 'wife-xiaoli'.",
        },
        meta: {
          type: "object",
          description:
            "YAML frontmatter fields. For profile: {name, language?, timezone?}. " +
            "For person: {name, relation, birthday?, tags?}.",
        },
        content: {
          type: "string",
          description: "Markdown body content for the memory entry",
        },
        query: {
          type: "string",
          description: "Search query string (for 'search' action)",
        },
      },
      required: ["action"],
    },

    isReadOnly: false,
    isParallelSafe: false,
    needsPermission: false,
    // 记忆是知行应用本地状态（~/.zhixing/me）：写本地数据、无外部副作用 →
    // 经 app-state 边界判 internal（自动放行）。
    boundaries: [{ boundaryType: "app-state", access: "write", dynamic: false }],
    systemPromptHints: MEMORY_SYSTEM_PROMPT_HINTS,

    async call(input): Promise<ToolResult> {
      const action = input.action as string;

      try {
        switch (action) {
          case "save":
            return await handleSave(store, input);
          case "search":
            return await handleSearch(store, input);
          case "list":
            return await handleList(store, input);
          case "update":
            return await handleSave(store, input);
          case "delete":
            return await handleDelete(store, input);
          default:
            return { content: `Unknown action: ${action}. Valid actions: save, search, list, update, delete`, isError: true };
        }
      } catch (err) {
        return {
          content: `Memory operation failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  };
}

// ─── Action Handlers ───

async function handleSave(
  store: MemoryStore,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const category = input.category as MemoryCategory | undefined;
  const id = input.id as string | undefined;
  const meta = (input.meta as Record<string, unknown>) ?? {};
  const content = (input.content as string) ?? "";

  if (!category) {
    return { content: "Missing required field: category", isError: true };
  }
  if (!id) {
    return { content: "Missing required field: id", isError: true };
  }

  const filePath = await store.save({ category, id, meta, content });
  return { content: `Memory saved: ${filePath}` };
}

async function handleSearch(
  store: MemoryStore,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const query = input.query as string | undefined;
  if (!query) {
    return { content: "Missing required field: query", isError: true };
  }

  const results = await store.search(query);

  if (results.length === 0) {
    return { content: `No memories found matching "${query}"` };
  }

  const lines = results.map((entry) => {
    const title = entry.meta.title ?? entry.meta.name ?? entry.id;
    return `- [${entry.category}] ${title} (${entry.id})`;
  });

  return {
    content: `Found ${results.length} memories:\n${lines.join("\n")}`,
  };
}

async function handleList(
  store: MemoryStore,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const category = input.category as MemoryCategory | undefined;
  if (!category) {
    return { content: "Missing required field: category", isError: true };
  }

  const entries = await store.list(category);

  if (entries.length === 0) {
    return { content: `No ${category} memories found` };
  }

  const lines = entries.map((entry) => {
    const title = entry.meta.title ?? entry.meta.name ?? entry.id;
    const tags = entry.meta.tags ? ` [${String(entry.meta.tags)}]` : "";
    return `- ${title}${tags} (${entry.id})`;
  });

  return {
    content: `${category} memories (${entries.length}):\n${lines.join("\n")}`,
  };
}

async function handleDelete(
  store: MemoryStore,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const category = input.category as MemoryCategory | undefined;
  const id = input.id as string | undefined;

  if (!category) {
    return { content: "Missing required field: category", isError: true };
  }
  if (!id) {
    return { content: "Missing required field: id", isError: true };
  }

  const deleted = await store.delete(category, id);
  if (deleted) {
    return { content: `Memory deleted: ${category}/${id}` };
  }
  return { content: `Memory not found: ${category}/${id}`, isError: true };
}
