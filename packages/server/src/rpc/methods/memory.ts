/**
 * memory.* RPC 方法 —— 记忆域查看面(/journal 统计、/people 关系列表)。
 *
 * 只读执行体:journal 生命周期维护(过期清理 / 凝练写)随宿主 turn 后自跑,
 * 不设写方法。
 */

import type { MethodEntry } from "../handlers.js";
import { RpcAppError } from "../handlers.js";
import { RPC_ERROR_CODES } from "../protocol.js";
import type { ServerContext } from "../../context.js";
import type { MemoryDirectory } from "../../runtime/management-directories.js";

function requireMemory(server: ServerContext): MemoryDirectory {
  if (!server.memory) {
    throw new RpcAppError(
      RPC_ERROR_CODES.INTERNAL_ERROR,
      "MemoryDirectory not configured on server",
    );
  }
  return server.memory;
}

export function buildMemoryJournalStatsMethod(): MethodEntry {
  return {
    name: "memory.journalStats",
    requiresAuth: true,
    async handler(_params, ctx) {
      return { stats: await requireMemory(ctx.server).journalStats() };
    },
  };
}

export function buildMemoryPeopleListMethod(): MethodEntry {
  return {
    name: "memory.peopleList",
    requiresAuth: true,
    async handler(_params, ctx) {
      return { people: await requireMemory(ctx.server).peopleList() };
    },
  };
}
