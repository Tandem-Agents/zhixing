/**
 * skill.* RPC 方法 —— 技能库管理面(/skills 列表、启停 / 置顶 / 模式、归档)
 * 与 slash 补全候选源的执行体。
 *
 * 写操作(setState / archive)成功后向全部已认证连接广播
 * `skill.changed { structuralVersion }`——技能是全局域(非会话),变更对一切
 * 接入面可见;接入面据版本号刷新补全候选(与本地 skillVersionSeen 机制同构)。
 */

import type { SkillMode } from "@zhixing/core";
import type { MethodEntry } from "../handlers.js";
import { RpcAppError, RpcErrors } from "../handlers.js";
import { RPC_ERROR_CODES } from "../protocol.js";
import type { ServerContext } from "../../context.js";
import type { SkillDirectory } from "../../runtime/management-directories.js";

const SKILL_MODES: ReadonlySet<string> = new Set(["main", "work"]);

function requireSkills(server: ServerContext): SkillDirectory {
  if (!server.skills) {
    throw new RpcAppError(
      RPC_ERROR_CODES.INTERNAL_ERROR,
      "SkillDirectory not configured on server",
    );
  }
  return server.skills;
}

function broadcastChanged(server: ServerContext): void {
  server.broadcastAll?.("skill.changed", {
    structuralVersion: server.skills?.structuralVersion() ?? 0,
  });
}

export function buildSkillListMethod(): MethodEntry {
  return {
    name: "skill.list",
    requiresAuth: true,
    async handler(_params, ctx) {
      const skills = await requireSkills(ctx.server).list();
      return {
        skills,
        structuralVersion: ctx.server.skills?.structuralVersion() ?? 0,
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
      const patch: { mode?: SkillMode; pinned?: boolean; disabled?: boolean } = {};
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
        patch.mode = params.mode as SkillMode;
      }
      if (Object.keys(patch).length === 0) {
        throw RpcErrors.invalidParams(
          "skill.setState requires at least one of: pinned / disabled / mode",
        );
      }
      const ok = await requireSkills(ctx.server).setState(params.skillId, patch);
      if (!ok) {
        throw RpcErrors.notFound(`Skill not found: ${params.skillId}`);
      }
      broadcastChanged(ctx.server);
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
      const ok = await requireSkills(ctx.server).archive(params.skillId);
      if (!ok) {
        throw RpcErrors.notFound(`Skill not found: ${params.skillId}`);
      }
      broadcastChanged(ctx.server);
      return { ok: true };
    },
  };
}
