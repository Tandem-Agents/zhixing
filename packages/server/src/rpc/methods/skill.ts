/**
 * skill.* RPC binding —— 认证后的 wire 参数编解码、Skill 应用调用、
 * 错误映射与事实事件传输。
 *
 * 写操作(setState / archive)成功后向全部已认证连接广播
 * `skill.changed { structuralVersion }`——技能是全局域(非会话),变更对一切
 * 接入面可见;接入面据版本号刷新补全候选(与本地 skillVersionSeen 机制同构)。
 */

import {
  SKILL_CATALOG_ARCHIVE_COMMAND,
  SKILL_CATALOG_LIST_QUERY,
  SKILL_CATALOG_SET_STATE_COMMAND,
  SkillCatalogApplicationError,
  type SkillCatalogChangedFact,
  type SkillCatalogStatePatch,
} from "@zhixing/core/skills/catalog";
import type { ProductApiDispatcher } from "@zhixing/core/product-api";
import type { MethodEntry } from "../handlers.js";
import { RpcAppError, RpcErrors } from "../handlers.js";
import { RPC_ERROR_CODES } from "../protocol.js";
import type { ServerContext } from "../../context.js";

const SKILL_MODES: ReadonlySet<string> = new Set(["main", "work"]);

function requireProductApi(server: ServerContext): ProductApiDispatcher {
  if (!server.productApi) {
    throw new RpcAppError(
      RPC_ERROR_CODES.INTERNAL_ERROR,
      "Skill Catalog application not configured on server",
    );
  }
  return server.productApi;
}

function broadcastChanged(
  server: ServerContext,
  fact: SkillCatalogChangedFact,
): void {
  server.broadcastAll?.("skill.changed", {
    structuralVersion: fact.catalogRevision,
  });
}

async function callSkillApplication<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof SkillCatalogApplicationError)) throw error;
    if (error.code === "not-found") throw RpcErrors.notFound(error.message);
    if (error.code === "invalid-command") {
      throw RpcErrors.invalidParams(error.message);
    }
    // Preserve the pre-migration wire contract: concurrent authority conflicts
    // remain ordinary internal failures at the dispatcher boundary.
    throw error;
  }
}

export function buildSkillListMethod(): MethodEntry {
  return {
    name: "skill.list",
    requiresAuth: true,
    async handler(_params, ctx) {
      const view = await callSkillApplication(() =>
        requireProductApi(ctx.server).query(SKILL_CATALOG_LIST_QUERY, { kind: "list" })
      );
      return {
        skills: view.entries,
        structuralVersion: view.catalogRevision,
      };
    },
  };
}

export function buildSkillSetStateMethod(): MethodEntry {
  return {
    name: "skill.setState",
    requiresAuth: true,
    async handler(rawParams, ctx) {
      const params = (rawParams ?? {}) as {
        skillId?: string;
        pinned?: unknown;
        disabled?: unknown;
        mode?: unknown;
      };
      if (typeof params.skillId !== "string" || params.skillId.length === 0) {
        throw RpcErrors.invalidParams("skill.setState requires 'skillId'");
      }
      const patch: { mode?: "main" | "work"; pinned?: boolean; disabled?: boolean } = {};
      if (params.pinned !== undefined) {
        if (typeof params.pinned !== "boolean") {
          throw RpcErrors.invalidParams("skill.setState 'pinned' must be boolean");
        }
        patch.pinned = params.pinned;
      }
      if (params.disabled !== undefined) {
        if (typeof params.disabled !== "boolean") {
          throw RpcErrors.invalidParams("skill.setState 'disabled' must be boolean");
        }
        patch.disabled = params.disabled;
      }
      if (params.mode !== undefined) {
        if (typeof params.mode !== "string" || !SKILL_MODES.has(params.mode)) {
          throw RpcErrors.invalidParams(
            `skill.setState 'mode' must be one of: ${[...SKILL_MODES].join(", ")}`,
          );
        }
        patch.mode = params.mode as NonNullable<SkillCatalogStatePatch["mode"]>;
      }
      if (Object.keys(patch).length === 0) {
        throw RpcErrors.invalidParams(
          "skill.setState requires at least one of: pinned / disabled / mode",
        );
      }
      const result = await callSkillApplication(() =>
        requireProductApi(ctx.server).command(SKILL_CATALOG_SET_STATE_COMMAND, {
          kind: "set-state",
          skillId: params.skillId!,
          patch,
        })
      );
      for (const fact of result.facts) broadcastChanged(ctx.server, fact);
      return { ok: true };
    },
  };
}

export function buildSkillArchiveMethod(): MethodEntry {
  return {
    name: "skill.archive",
    requiresAuth: true,
    async handler(rawParams, ctx) {
      const params = (rawParams ?? {}) as { skillId?: string };
      if (typeof params.skillId !== "string" || params.skillId.length === 0) {
        throw RpcErrors.invalidParams("skill.archive requires 'skillId'");
      }
      const result = await callSkillApplication(() =>
        requireProductApi(ctx.server).command(SKILL_CATALOG_ARCHIVE_COMMAND, {
          kind: "archive",
          skillId: params.skillId!,
        })
      );
      for (const fact of result.facts) broadcastChanged(ctx.server, fact);
      return { ok: true };
    },
  };
}
