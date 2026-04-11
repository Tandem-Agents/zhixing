/**
 * Memory 工具 — AI 自主管理记忆
 *
 * Phase M2 核心交付：让 AI 可以保存、查询、更新和删除用户记忆。
 *
 * 支持的操作：
 * - save: 保存一条记忆（profile / person / skill）
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
import { MemoryStore, type MemoryCategory } from "@zhixing/core";

export function createMemoryTool(): ToolDefinition {
  const store = new MemoryStore();

  return {
    name: "memory",
    description:
      "Manage the user's persistent memory — save, search, list, update, or delete memories. " +
      "Use this when the user asks to remember something, or when you discover important personal information " +
      "(name, preferences, relationships, technical skills). " +
      "Categories: 'profile' (identity), 'person' (relationships), 'skill' (reusable methodologies). " +
      "Always confirm with the user before saving new memories unless they explicitly asked you to remember.",
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
            "Memory category: 'profile' (user identity), 'person' (relationships), 'skill' (reusable methodologies)",
          enum: ["profile", "person", "skill"],
        },
        id: {
          type: "string",
          description:
            "Memory ID (filename without .md). For profile, always use 'profile'. " +
            "For person, use a slug like 'wife-xiaoli'. " +
            "For skill, use a slug like 'docker-network-debug'.",
        },
        meta: {
          type: "object",
          description:
            "YAML frontmatter fields. For profile: {name, language?, timezone?}. " +
            "For person: {name, relation, birthday?, tags?}. " +
            "For skill: {title, tags, triggers, source}.",
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
