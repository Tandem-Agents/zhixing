/**
 * Skill Catalog v2 内置工具集 —— skill_read / skill_save / skill_admit / skill_materialize
 * 与统一准入工具构建器。领域契约一律从 `@zhixing-ai/core/skills/catalog` 导入。
 */

import * as path from "node:path";
import type { ContentThreat } from "@zhixing-ai/core/skills/admission";
import { truncateUtf8ToBytes } from "@zhixing-ai/core/skills/archive";
import { parseQualifiedSkillId } from "@zhixing-ai/core/skills/id";
import {
  SKILL_READ_MAX_RESPONSE_BYTES,
  SkillCatalogSaveError,
  SkillPackageReadError,
  type SkillCatalogAdmissionApplication,
  type SkillCatalogAdmissionOutcome,
  type SkillCatalogLoadApplication,
  type SkillCatalogSaveApplication,
  type SkillCatalogSaveDraft,
  type SkillCatalogSaveResourceDraft,
  type SkillMode,
  type SkillVisibility,
} from "@zhixing-ai/core/skills/catalog";
import type { ToolDefinition, ToolResult } from "@zhixing-ai/core";
import {
  SkillMaterializeBoundaryError,
  writeMaterializedSkillFile,
} from "./skill-materialize-fs.js";

export interface CreateSkillReadToolOptions {
  readonly systemOnly?: boolean;
}

function boundedErrorResult(code: string, message: string): ToolResult {
  return { content: boundedErrorJson(code, message), isError: true };
}

function invalidDraftResult(message: string): { readonly errorResult: ToolResult } {
  return {
    errorResult: {
      content: JSON.stringify({ error: "invalid-draft", message }),
      isError: true,
    },
  };
}

export function createSystemOnlySkillReadTool(
  application: SkillCatalogLoadApplication,
): ToolDefinition {
  return createSkillReadTool(application, { systemOnly: true });
}

export function createSkillReadTool(
  application: SkillCatalogLoadApplication,
  options: CreateSkillReadToolOptions = {},
): ToolDefinition {
  const systemOnly = options.systemOnly === true;
  return {
    name: "skill_read",
    description:
      "Read a skill package (root SKILL.md or a bundled resource) with bounded <= 12 KiB pages. " +
      "Root read returns packageVersion, navigation manifest, optional writeTemplate, and nextCursor. " +
      "Reading a non-root resource requires expectedVersion from the root read.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Skill identifier (prefer user:<id> or system:<id>).",
        },
        resource: {
          type: "string",
          description: "Optional relative resource path inside the skill package (default SKILL.md).",
        },
        expectedVersion: {
          type: "string",
          description: 'Exact packageVersion locked by root read (or "latest" to bypass lock).',
        },
        cursor: {
          type: "string",
          description: "Opaque pagination cursor returned by previous skill_read response.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },

    isReadOnly: systemOnly,
    isParallelSafe: true,
    needsPermission: false,
    boundaries: [
      {
        boundaryType: "app-state",
        access: systemOnly ? "read" : "write",
        dynamic: false,
      },
    ],

    async call(input, context): Promise<ToolResult> {
      const id = typeof input.id === "string" ? input.id.trim() : "";
      if (!id) return boundedErrorResult("not-found", "skill_read 需要非空的 id 参数。");
      if (systemOnly && parseQualifiedSkillId(id).namespace !== "system") {
        return boundedErrorResult("forbidden", "当前受限上下文仅允许只读访问 system:* 内置技能包。");
      }
      if (!application.readPackage) {
        return boundedErrorResult("unsupported", "Skill load application 未提供 readPackage 实现");
      }

      const resource = typeof input.resource === "string" ? input.resource : undefined;
      const expectedVersion = typeof input.expectedVersion === "string" ? input.expectedVersion : undefined;
      const cursor = typeof input.cursor === "string" ? input.cursor : undefined;

      try {
        const outcome = await application.readPackage({
          id,
          ...(resource !== undefined ? { resource } : {}),
          ...(expectedVersion !== undefined ? { expectedVersion } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
          ...(!systemOnly && context?.toolCallId ? { operationId: context.toolCallId } : {}),
        });
        return { content: boundedResponseJson(outcome), isError: "error" in outcome };
      } catch (err) {
        if (err instanceof SkillPackageReadError) {
          return boundedErrorResult(err.code, err.message);
        }
        return boundedErrorResult("read-failed", err instanceof Error ? err.message : String(err));
      }
    },
  };
}

export function createSkillSaveTool(
  application: SkillCatalogSaveApplication,
  defaultMode: SkillMode,
): ToolDefinition {
  return {
    name: "skill_save",
    description:
      "Save or update a skill package (SKILL.md + optional bundled resources + visibility). " +
      "Requires explicit user confirmation and write-back baseline verification (expectedVersion / expectedRevision) when updating an existing skill.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name." },
        description: { type: "string", description: "When-to-use summary line." },
        body: { type: "string", description: "Root SKILL.md markdown body." },
        mode: { type: "string", enum: ["main", "work"] },
        visibility: {
          type: "object",
          properties: {
            modelAutoIndex: { type: "boolean" },
            userSlashCommand: { type: "boolean" },
          },
          additionalProperties: false,
        },
        resources: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
              mediaType: { type: "string" },
              summary: { type: "string" },
            },
            required: ["path", "content"],
            additionalProperties: false,
          },
        },
        expectedVersion: { type: "string" },
        expectedRevision: { type: "number" },
      },
      required: ["name", "description", "body"],
      additionalProperties: false,
    },

    isReadOnly: false,
    isParallelSafe: false,
    needsPermission: false,
    requiresExplicitConfirmation: true,

    async prepareConfirmation(input, context) {
      const parsed = parseSkillSaveInput(input, defaultMode);
      if ("errorResult" in parsed) {
        return { earlyReturn: parsed.errorResult };
      }
      try {
        const preview = await application.validateSaveBaseline?.(
          parsed.draft,
          context?.toolCallId,
        );
        return {
          displayInput: {
            name: parsed.draft.name,
            description: parsed.draft.description,
            mode: parsed.draft.mode,
            visibility: preview?.resolvedVisibility ?? parsed.draft.visibility,
            ...(preview?.baselineVersion !== undefined
              ? { baselineVersion: preview.baselineVersion }
              : {}),
            ...(preview?.existingEntry
              ? { baselineRevision: preview.existingEntry.revision }
              : {}),
            ...(parsed.draft.expectedVersion !== undefined
              ? { expectedVersion: parsed.draft.expectedVersion }
              : {}),
            ...(parsed.draft.expectedRevision !== undefined
              ? { expectedRevision: parsed.draft.expectedRevision }
              : {}),
            rootDocument: preview?.rootDocument ?? parsed.draft.body,
            resources: preview?.finalResources ?? parsed.draft.resources ?? [],
            scrubbedCount: preview?.scrubbedCount ?? 0,
          },
        };
      } catch (err) {
        return { earlyReturn: formatSkillSaveError(err) };
      }
    },

    async call(input, context): Promise<ToolResult> {
      const parsed = parseSkillSaveInput(input, defaultMode);
      if ("errorResult" in parsed) return parsed.errorResult;
      try {
        const result = await application.save(parsed.draft, context?.toolCallId);
        const action = result.outcome === "created" ? "新建" : "更新";
        const lines = [
          `已记录${action}技能「${result.name}」(id: user:${result.id}${result.packageVersion ? `, packageVersion: ${result.packageVersion}` : ""})；本轮成功完成后入库。`,
        ];
        if (result.scrubbedCount > 0) {
          lines.push(
            `提交内容中有 ${result.scrubbedCount} 处敏感凭据已自动抹除 —— 请如实告知用户。`,
          );
        }
        return { content: lines.join("\n"), isError: false };
      } catch (err) {
        return formatSkillSaveError(err);
      }
    },
  };
}

export function buildSkillAdmissionTool(
  toolName: "admit_skill" | "skill_admit",
  application: SkillCatalogAdmissionApplication,
  defaultMode: SkillMode,
): ToolDefinition {
  return {
    name: toolName,
    description:
      "Admit an external skill (from a local path) into the skill library after an independent security " +
      "review. First call with `path`: a safe verdict installs it immediately; a malicious verdict rejects " +
      "it (final, never try to bypass); an uncertain verdict returns the review status and an admissionToken " +
      "WITHOUT installing — only after the user explicitly approves may you call again with that admissionToken.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Local path of the skill to admit (a directory containing SKILL.md, or a single SKILL.md file). Required on the first call.",
        },
        mode: {
          type: "string",
          enum: ["main", "work"],
          description:
            "Where the skill belongs: 'work' for workscene-specific, 'main' for general. Defaults to the current scene.",
        },
        admissionToken: {
          type: "string",
          description:
            "Confirmation token from a previous needs-confirm result. Pass it ONLY after the user explicitly approved admitting that reviewed content.",
        },
      },
      required: [],
    },

    isReadOnly: false,
    isParallelSafe: false,
    needsPermission: false,
    permissionArgumentKey: "path",
    filePathArgumentKeys: ["path"],
    boundaries: [
      { boundaryType: "filesystem", access: "read", dynamic: false },
      { boundaryType: "app-state", access: "write", dynamic: false },
    ],

    async call(input, context): Promise<ToolResult> {
      const token = typeof input.admissionToken === "string" ? input.admissionToken.trim() : "";
      const rawSrcPath = typeof input.path === "string" ? input.path.trim() : "";
      const workingDir = context?.workingDirectory?.trim();
      const srcPath =
        rawSrcPath && workingDir
          ? path.resolve(workingDir, rawSrcPath)
          : rawSrcPath;
      const mode: SkillMode = input.mode === "work" || input.mode === "main" ? input.mode : defaultMode;
      try {
        const authorizeFileAccess = context?.authorizeFileAccess;
        const outcome = await application.admit({
          ...(srcPath ? { source: { kind: "local-path", path: srcPath } } : {}),
          ...(token ? { admissionToken: token } : {}),
          mode,
          toolName,
          operationId: context?.toolCallId,
          ...(authorizeFileAccess
            ? {
                authorizeMemberRead: (realMemberPath: string) =>
                  authorizeFileAccess({ path: realMemberPath, access: "read" }),
              }
            : {}),
        });
        return renderAdmissionOutcome(outcome, toolName);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: token ? `接入失败:${message}(已丢弃,需重新审查)` : `接入失败:${message}`,
          isError: true,
        };
      }
    },
  };
}

export function createSkillAdmitTool(
  application: SkillCatalogAdmissionApplication,
  defaultMode: SkillMode,
): ToolDefinition {
  return buildSkillAdmissionTool("skill_admit", application, defaultMode);
}

export function createSkillMaterializeTool(
  loadApplication: SkillCatalogLoadApplication,
): ToolDefinition {
  return {
    name: "skill_materialize",
    description:
      "Write one non-root resource from a skill package into an authorized workspace file. " +
      "Requires exact expectedVersion from skill_read; checks skill enabled status and version match before touching disk.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Skill identifier (user:<id> or system:<id>)." },
        resource: { type: "string", description: "Relative resource path inside the skill package." },
        path: { type: "string", description: "Target file path in the authorized workspace." },
        expectedVersion: {
          type: "string",
          description: 'Exact packageVersion from skill_read (cannot be "latest").',
        },
        overwrite: {
          type: "boolean",
          description: "Overwrite target file atomically only if true (default false).",
        },
      },
      required: ["id", "resource", "path", "expectedVersion"],
      additionalProperties: false,
    },

    isReadOnly: false,
    isParallelSafe: false,
    needsPermission: true,
    permissionArgumentKey: "path",
    filePathArgumentKeys: ["path"],
    boundaries: [
      { boundaryType: "app-state", access: "read", dynamic: false },
      { boundaryType: "filesystem", access: "write", dynamic: false },
    ],

    async call(input, context): Promise<ToolResult> {
      const id = typeof input.id === "string" ? input.id.trim() : "";
      const resource = typeof input.resource === "string" ? input.resource.trim() : "";
      const rawPath = typeof input.path === "string" ? input.path.trim() : "";
      const expectedVersion = typeof input.expectedVersion === "string" ? input.expectedVersion.trim() : "";
      const overwrite = input.overwrite === true;

      if (!context?.workingDirectory || !context.workingDirectory.trim()) {
        return boundedErrorResult("workspace-required", "skill_materialize 需要当前运行具备已授权的工作区目录。");
      }
      if (!id || !resource || !rawPath || !expectedVersion) {
        return boundedErrorResult("invalid-input", "skill_materialize 需要非空的 id / resource / path / expectedVersion。");
      }
      if (!loadApplication.readMaterializeResource) {
        return boundedErrorResult("unsupported", "Skill load application 未提供 readMaterializeResource 实现");
      }

      // 1. 写入前强制校验技能启用状态与精确 packageVersion，任何不符 0 字节落盘
      let loaded: Awaited<ReturnType<NonNullable<SkillCatalogLoadApplication["readMaterializeResource"]>>>;
      try {
        loaded = await loadApplication.readMaterializeResource({ id, resource, expectedVersion });
      } catch (err) {
        if (err instanceof SkillPackageReadError) {
          return boundedErrorResult(err.code, err.message);
        }
        return boundedErrorResult("materialize-failed", err instanceof Error ? err.message : String(err));
      }

      if ("error" in loaded) {
        return { content: boundedResponseJson(loaded), isError: true };
      }

      // 2. 授权工作区实路径边界校验 + 重解析点逐级拒绝 + 写入鉴权 + 原子落盘
      try {
        const targetPath = await writeMaterializedSkillFile({
          workingDirectory: context.workingDirectory,
          rawPath,
          content: loaded.content,
          overwrite,
          authorizeFileAccess: context.authorizeFileAccess,
        });
        const bytes = Buffer.byteLength(loaded.content, "utf8");
        return {
          content: `已导出技能资源「${loaded.resource}」(${bytes} B, packageVersion: ${loaded.packageVersion}) 至 ${targetPath}。`,
          isError: false,
        };
      } catch (err) {
        if (err instanceof SkillMaterializeBoundaryError) {
          return boundedErrorResult(err.code, err.message);
        }
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          return {
            content: `导出失败：目标文件已存在且未设置 overwrite=true (${path.resolve(context.workingDirectory, rawPath)})`,
            isError: true,
          };
        }
        throw err;
      }
    },
  };
}

function parseSkillSaveInput(
  input: Record<string, unknown>,
  defaultMode: SkillMode,
):
  | { readonly draft: SkillCatalogSaveDraft }
  | { readonly errorResult: ToolResult } {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const description = typeof input.description === "string" ? input.description.trim() : "";
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (!name || !description || !body) {
    return invalidDraftResult("skill_save 需要非空的 name / description / body。");
  }
  const mode: SkillMode = input.mode === "work" || input.mode === "main" ? input.mode : defaultMode;

  let visibility: SkillVisibility | undefined;
  if (input.visibility !== undefined) {
    if (typeof input.visibility !== "object" || input.visibility === null || Array.isArray(input.visibility)) {
      return invalidDraftResult("visibility 必须是对象。");
    }
    const rawVis = input.visibility as Record<string, unknown>;
    visibility = {
      modelAutoIndex: typeof rawVis.modelAutoIndex === "boolean" ? rawVis.modelAutoIndex : true,
      userSlashCommand: typeof rawVis.userSlashCommand === "boolean" ? rawVis.userSlashCommand : true,
    };
  }

  let resources: SkillCatalogSaveResourceDraft[] | undefined;
  if (input.resources !== undefined) {
    if (!Array.isArray(input.resources)) {
      return invalidDraftResult("resources 必须是数组。");
    }
    resources = [];
    for (const item of input.resources) {
      if (
        typeof item !== "object" ||
        item === null ||
        Array.isArray(item) ||
        typeof (item as Record<string, unknown>).path !== "string" ||
        typeof (item as Record<string, unknown>).content !== "string"
      ) {
        return invalidDraftResult("resources 每一项都必须包含字符串 path 与 content。");
      }
      const record = item as Record<string, unknown>;
      resources.push({
        path: record.path as string,
        content: record.content as string,
        ...(typeof record.mediaType === "string" ? { mediaType: record.mediaType } : {}),
        ...(typeof record.summary === "string" ? { summary: record.summary } : {}),
      });
    }
  }

  let expectedRevision: number | undefined;
  if (input.expectedRevision !== undefined) {
    if (
      typeof input.expectedRevision !== "number" ||
      !Number.isInteger(input.expectedRevision) ||
      input.expectedRevision < 0
    ) {
      return invalidDraftResult("expectedRevision 必须是非负整数。");
    }
    expectedRevision = input.expectedRevision;
  }

  const expectedVersion =
    typeof input.expectedVersion === "string" && input.expectedVersion.trim()
      ? input.expectedVersion.trim()
      : undefined;

  return {
    draft: {
      name,
      description,
      body,
      mode,
      ...(visibility ? { visibility } : {}),
      ...(resources !== undefined ? { resources } : {}),
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    },
  };
}

function formatSkillSaveError(error: unknown): ToolResult {
  if (error instanceof SkillCatalogSaveError) {
    return {
      content: JSON.stringify({ error: error.code, message: error.message }),
      isError: true,
    };
  }
  return {
    content: JSON.stringify({
      error: "save-failed",
      message: error instanceof Error ? error.message : String(error),
    }),
    isError: true,
  };
}

function renderAdmissionOutcome(
  outcome: SkillCatalogAdmissionOutcome,
  toolName: "admit_skill" | "skill_admit",
): ToolResult {
  switch (outcome.kind) {
    case "missing-input":
      return { content: `${toolName} 首调需要 path(接入源本地路径);确认重调需要 admissionToken。`, isError: true };
    case "missing-name":
      return { content: "接入失败:技能缺少 name(SKILL.md frontmatter)。", isError: true };
    case "forbidden":
      return { content: `接入被拒绝(${outcome.code}):${outcome.reason}`, isError: true };
    case "blocked-secret":
      return {
        content: `接入被本地凭据硬阻断(命中类别: ${outcome.categories.join(", ") || "secret"}):${outcome.reason}`,
        isError: true,
      };
    case "review-declined":
      return { content: `接入未送审已终止:${outcome.reason}`, isError: true };
    case "publish-not-authorized":
      return { content: `未获本人发布入库批准(${outcome.verdict}):${outcome.reason}`, isError: true };
    case "escalated":
      return {
        content:
          outcome.threats.length > 0
            ? `接入被挡死(审查判定确凿恶意),不可绕过。\n裁判理由:${outcome.reason}\n${renderThreats(outcome.threats)}`
            : `接入被挡死(审查判定确凿恶意),不可绕过。\n状态说明:${outcome.reason}`,
        isError: true,
      };
    case "needs-confirm":
      return {
        content:
          outcome.threats.length > 0
            ? "审查拿不准,需要用户决定(未接入)。请把以下报告原样转述给用户:\n" +
              `裁判理由:${outcome.reason}\n${renderThreats(outcome.threats)}\n` +
              "用户明确同意接入后,带 admissionToken 重调本工具完成接入(有时效):" +
              outcome.admissionToken
            : `需要本人在宿主确认表面审阅后决定是否发布(未接入)。\n状态说明:${outcome.reason}\n确认后带 admissionToken 重调本工具完成入库(有时效):${outcome.admissionToken}`,
        isError: false,
      };
    case "confirmation-expired":
      return { content: "确认已失效(token 不存在或已过期),需要重新审查:请用 path 重新发起接入。", isError: true };
    case "candidate-changed":
      return { content: "接入中止:暂存内容与用户确认时不一致(可能被改写),已丢弃,需要重新审查。", isError: true };
    case "admitted":
      return { content: `已记录接入技能「${outcome.name}」(id: ${outcome.id})；本轮成功完成后入库。`, isError: false };
  }
}

function renderThreats(threats: readonly ContentThreat[]): string {
  return (
    "静态扫描信号:\n" +
    threats.map((threat) => `- ${threat.category}/${threat.rule}: ${threat.excerpt}`).join("\n")
  );
}

function boundedResponseJson(payload: unknown): string {
  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json, "utf8") <= SKILL_READ_MAX_RESPONSE_BYTES) {
    return json;
  }
  return boundedErrorJson("response-too-large", "skill_read 序列化响应超出 12,288 UTF-8 字节上限。");
}

function boundedErrorJson(code: string, message: string): string {
  const raw = JSON.stringify({ error: code, message });
  if (Buffer.byteLength(raw, "utf8") <= SKILL_READ_MAX_RESPONSE_BYTES) {
    return raw;
  }
  const budget = Math.max(
    128,
    SKILL_READ_MAX_RESPONSE_BYTES - Buffer.byteLength(JSON.stringify({ error: code, message: "" }), "utf8") - 16,
  );
  return JSON.stringify({ error: code, message: truncateUtf8ToBytes(message, budget) });
}
