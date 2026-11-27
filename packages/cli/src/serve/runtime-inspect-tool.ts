import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { truncateUtf8ToBytes } from "@zhixing-ai/core/skills/archive";
import type { ModelRoleId, ToolDefinition } from "@zhixing-ai/core";
import {
  hasPostTurnControlCapability,
  runContextStorage,
} from "@zhixing-ai/orchestrator/runtime";
import { inspectLocalHealth, type DoctorReport } from "../maintenance/doctor.js";
import type { ModelRolePublicSummary } from "../runtime/model-runtime-port.js";
import {
  buildManagedHostPublicStatus,
  readOfflineStatusSnapshot,
  type StatusDeps,
} from "./status.js";
import { loadCurrentManagedServiceState } from "./managed-service-runtime.js";
import type { BackupTargetConfigurationRepository } from "./backup-target-config.js";
import {
  getDefaultPidPath,
  getDefaultPortPath,
  getDefaultStatePath,
  readLock,
  type ServerStateSnapshot,
} from "@zhixing-ai/server";
import path from "node:path";
import {
  resolveRuntimeSessionKind,
  type RuntimeSessionKind,
} from "./session-surface-kind.js";

export const RUNTIME_INSPECT_MAX_BYTES = 6144;

export interface RuntimeInspectWorkspaceEntry {
  readonly deviceName: string;
  readonly workspaceName: string;
}

export interface RuntimeInspectModelsInfo {
  readonly roleSummary: Readonly<Record<ModelRoleId, ModelRolePublicSummary>>;
  readonly sessionSelectionMode?: string;
  readonly dispatchSelectionMode?: string;
}

export interface RuntimeInspectHealthInfo {
  readonly processStatus: "running" | "stopped" | "unknown";
  readonly healthCode: DoctorReport["code"];
}

export interface RuntimeInspectDeps {
  readonly version: string;
  readonly deviceRoles: () => readonly ("anchor" | "executor")[];
  readonly executionRole: () => "anchor" | "executor" | "hybrid";
  readonly anchorReachable?: () => boolean;
  readonly mcpServerIds?: () => readonly string[];
  readonly listWorkspaces?: () => Promise<readonly RuntimeInspectWorkspaceEntry[]>;
  readonly readModels?: (
    conversationId: string | undefined,
  ) => Promise<RuntimeInspectModelsInfo>;
  readonly inspectHealth?: () => Promise<RuntimeInspectHealthInfo>;
  readonly healthBinding?: {
    readonly zhixingHome: string;
    readonly backupTargets: BackupTargetConfigurationRepository;
    readonly statusDeps: StatusDeps;
  };
}

const RESTRICTED_SUMMARY_ONLY_KINDS = new Set<RuntimeSessionKind>([
  "channel",
  "ephemeral",
  "sub-agent",
  "orchestration-node",
]);

const WORKSPACE_TOOL_GATES = new Set([
  "workscene_change_approve",
  "workscene_set_workdir_current",
]);

function byteLen(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function fitSummaryWithinBudget(payload: {
  readonly version: string;
  readonly sessionKind: RuntimeSessionKind;
  readonly runtimeKind: string;
  readonly lineageRole: string;
  readonly effectivePrimaryRole: string;
  readonly deviceRoles: readonly ("anchor" | "executor")[];
  readonly executionRole: "anchor" | "executor" | "hybrid";
  readonly hasAuthorizedWorkspace: boolean;
  readonly anchorReachable: boolean;
  readonly hasPostTurnControl: boolean;
  readonly tools: readonly string[];
  readonly mountedMcpServers: readonly string[];
  readonly logAccess: {
    readonly mode: "storage" | "conversation" | "none";
    readonly filterableRefKinds: readonly string[];
  };
  readonly availableScopes: readonly ("summary" | "workspaces" | "models" | "health")[];
}): Record<string, unknown> {
  const tools = [...payload.tools];
  const mounted = [...payload.mountedMcpServers];
  const toolsTotal = tools.length;
  const mountedTotal = mounted.length;

  const build = (): Record<string, unknown> => {
    const omittedTools = toolsTotal - tools.length;
    const omittedMounted = mountedTotal - mounted.length;
    const omittedCount = omittedTools + omittedMounted;
    return {
      ...payload,
      tools,
      mountedMcpServers: mounted,
      ...(omittedCount > 0
        ? {
            totalCount: toolsTotal + mountedTotal,
            omittedCount,
            ...(omittedTools > 0
              ? { toolsPagination: { totalCount: toolsTotal, omittedCount: omittedTools } }
              : {}),
            ...(omittedMounted > 0
              ? {
                  mountedMcpServersPagination: {
                    totalCount: mountedTotal,
                    omittedCount: omittedMounted,
                  },
                }
              : {}),
          }
        : {}),
    };
  };

  while (byteLen(build()) > RUNTIME_INSPECT_MAX_BYTES) {
    if (mounted.length > 0) {
      mounted.pop();
      continue;
    }
    if (tools.length > 0) {
      tools.pop();
      continue;
    }
    break;
  }
  return build();
}

function extractMcpServerIdsFromToolNames(toolNames: readonly string[]): readonly string[] {
  const ids = new Set<string>();
  for (const name of toolNames) {
    if (!name.startsWith("mcp__")) continue;
    const sep = name.indexOf("__", 5);
    if (sep > 5) ids.add(name.slice(5, sep));
  }
  return [...ids].sort();
}

function resolveHealthReader(
  deps: RuntimeInspectDeps,
): (() => Promise<RuntimeInspectHealthInfo>) | undefined {
  if (deps.inspectHealth) return deps.inspectHealth;
  const binding = deps.healthBinding;
  if (!binding) return undefined;
  return async (): Promise<RuntimeInspectHealthInfo> => {
    const local = await readOfflineStatusSnapshot(binding.statusDeps);
    const report = await inspectLocalHealth({
      homeDir: binding.zhixingHome,
      backupTargets: binding.backupTargets,
      statusDeps: binding.statusDeps,
      inspectManaged: () =>
        buildManagedHostPublicStatus(local.report, {
          deps: {
            loadCurrent: () => loadCurrentManagedServiceState("inspect", binding.zhixingHome),
          },
        }),
    });
    const processStatus =
      local.report.status === "running"
        ? ("running" as const)
        : local.report.status === "stopped"
          ? ("stopped" as const)
          : ("unknown" as const);
    return {
      processStatus,
      healthCode: report.code,
    };
  };
}

function decodeWorkspaceCursor(cursor: string | undefined): number | null {
  if (cursor === undefined) return 0;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      readonly v?: unknown;
      readonly offset?: unknown;
    };
    if (
      decoded?.v === 1 &&
      typeof decoded.offset === "number" &&
      Number.isSafeInteger(decoded.offset) &&
      decoded.offset >= 0
    ) {
      return decoded.offset;
    }
  } catch {
    // Fall through to null
  }
  return null;
}

function encodeWorkspaceCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, offset }), "utf8").toString("base64url");
}

function formatWorkspacePage(
  entries: readonly RuntimeInspectWorkspaceEntry[],
  offset: number,
): Record<string, unknown> {
  const counts = new Map<string, number>();
  const deviceCounts = new Map<string, number>();
  for (const entry of entries) {
    const pairKey = `${entry.deviceName}\0${entry.workspaceName}`;
    counts.set(pairKey, (counts.get(pairKey) ?? 0) + 1);
    deviceCounts.set(entry.workspaceName, (deviceCounts.get(entry.workspaceName) ?? 0) + 1);
  }
  const sorted = [...entries].sort((a, b) =>
    a.deviceName !== b.deviceName
      ? a.deviceName.localeCompare(b.deviceName)
      : a.workspaceName.localeCompare(b.workspaceName),
  );
  const start = Math.min(offset, sorted.length);
  const totalCount = sorted.length;
  const items: {
    readonly deviceName: string;
    readonly workspaceName: string;
    readonly ambiguous?: true;
    readonly truncatedDisplay?: true;
  }[] = [];

  const packItem = (entry: RuntimeInspectWorkspaceEntry, maxFieldBytes: number) => {
    const dShort = truncateUtf8ToBytes(entry.deviceName, maxFieldBytes);
    const wShort = truncateUtf8ToBytes(entry.workspaceName, maxFieldBytes);
    const truncated = dShort !== entry.deviceName || wShort !== entry.workspaceName;
    const isAmbiguous =
      (counts.get(`${entry.deviceName}\0${entry.workspaceName}`) ?? 0) > 1 ||
      (deviceCounts.get(entry.workspaceName) ?? 0) > 1;
    return {
      deviceName: dShort,
      workspaceName: wShort,
      ...(isAmbiguous ? { ambiguous: true as const } : {}),
      ...(truncated ? { truncatedDisplay: true as const } : {}),
    };
  };

  let cursorIndex = start;
  const remaining = totalCount - start;
  const buildResponse = (
    list: typeof items,
    nextIdx: number,
  ): Record<string, unknown> => {
    const hasMore = nextIdx < totalCount;
    const omittedCount = totalCount - start - list.length;
    return {
      availability: "ok",
      items: list,
      totalCount,
      omittedCount: Math.max(0, omittedCount),
      ...(hasMore ? { nextCursor: encodeWorkspaceCursor(nextIdx) } : {}),
    };
  };

  while (cursorIndex < totalCount) {
    let fieldLimit = 256;
    let candidate = packItem(sorted[cursorIndex]!, fieldLimit);
    let nextList = [...items, candidate];
    if (items.length === 0) {
      // Ensure at least one item per page so cursor strictly advances.
      while (byteLen(buildResponse(nextList, cursorIndex + 1)) > RUNTIME_INSPECT_MAX_BYTES && fieldLimit > 16) {
        fieldLimit = Math.floor(fieldLimit / 2);
        candidate = packItem(sorted[cursorIndex]!, fieldLimit);
        nextList = [candidate];
      }
      items.push(candidate);
      cursorIndex += 1;
      continue;
    }
    if (byteLen(buildResponse(nextList, cursorIndex + 1)) > RUNTIME_INSPECT_MAX_BYTES) {
      break;
    }
    items.push(candidate);
    cursorIndex += 1;
  }

  // If zero-length remaining, ensure valid envelope
  if (remaining <= 0) {
    return buildResponse([], totalCount);
  }
  return buildResponse(items, cursorIndex);
}

/** Built-in read-only narrow runtime introspection tool bounded to <= 6144 UTF-8 bytes. */
export function createRuntimeInspectTool(deps: RuntimeInspectDeps): ToolDefinition {
  const readHealth = resolveHealthReader(deps);
  return {
    name: "runtime_inspect",
    description:
      "只读查看当前运行实例的实时窄状态。支持 summary（会话类型、角色、冻结工具与实际挂载 MCP）、workspaces（仅有场景选参资格时列公开工作区名）、models（非通道顶层会话的三角色无秘密摘要）与 health（非通道顶层会话的进程健康码）。结果不包含密钥或物理路径。",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["summary", "workspaces", "models", "health"],
        },
        cursor: { type: "string" },
      },
      additionalProperties: false,
    },
    isReadOnly: true,
    isParallelSafe: true,
    needsPermission: false,
    boundaries: [{ boundaryType: "app-state", access: "read", dynamic: false }],
    async call(input) {
      const keys = Object.keys(input ?? {});
      if (keys.some((key) => key !== "scope" && key !== "cursor")) {
        return { isError: true, content: "不接受未定义参数" };
      }
      const rawScope = input.scope;
      const scope =
        rawScope === undefined ? "summary" : String(rawScope);
      if (!["summary", "workspaces", "models", "health"].includes(scope)) {
        return { isError: true, content: `未知 scope: ${scope}` };
      }
      if (input.cursor !== undefined && scope !== "workspaces") {
        return {
          isError: true,
          content: 'cursor 仅支持与 scope="workspaces" 配合分页',
        };
      }
      if (input.cursor !== undefined && typeof input.cursor !== "string") {
        return { isError: true, content: "cursor 必须是字符串" };
      }

      const run = runContextStorage.getStore();
      const sessionKind = resolveRuntimeSessionKind(run);
      const runtimeKind =
        run?.runtimeKind ??
        (sessionKind === "ephemeral"
          ? "ephemeral"
          : sessionKind === "sub-agent"
            ? "sub-agent"
            : sessionKind === "orchestration-node"
              ? "orchestration-node"
              : "conversation");
      const lineageRole = run?.lineageRole ?? (sessionKind === "workscene" ? "power" : "main");
      const effectivePrimaryRole =
        run?.effectivePrimaryRole ?? lineageRole;
      const tools = [...(run?.toolNames ?? [])];
      const hasWorkspaceTools = tools.some((name) => WORKSPACE_TOOL_GATES.has(name));
      const hostMcp = deps.mcpServerIds ? new Set(deps.mcpServerIds()) : undefined;
      const candidateMcp =
        run?.toolNames !== undefined
          ? extractMcpServerIdsFromToolNames(tools)
          : [...(run?.mountedMcpServers ?? [])];
      const mountedMcpServers = hostMcp
        ? candidateMcp.filter((id) => hostMcp.has(id))
        : candidateMcp;

      const restrictedSummaryOnly = RESTRICTED_SUMMARY_ONLY_KINDS.has(sessionKind);
      const workspacesEligible =
        !restrictedSummaryOnly &&
        (sessionKind === "main" || sessionKind === "workscene") &&
        hasWorkspaceTools &&
        Boolean(deps.listWorkspaces);
      const availableScopes: ("summary" | "workspaces" | "models" | "health")[] =
        restrictedSummaryOnly
          ? ["summary"]
          : [
              "summary",
              ...(workspacesEligible ? (["workspaces"] as const) : []),
              "models",
              "health",
            ];

      if (scope === "summary") {
        const hasLogSearch = tools.includes("log_search") || tools.includes("log_read");
        const logMode: "storage" | "conversation" | "none" = !hasLogSearch
          ? "none"
          : restrictedSummaryOnly
            ? "conversation"
            : "storage";
        const filterableRefKinds =
          logMode === "none"
            ? []
            : logMode === "conversation"
              ? ["conversation"]
              : [
                  "conversation",
                  "toolCall",
                  "extension",
                  "operation",
                  "delivery",
                  "modelAttempt",
                  "task",
                  "generation",
                ];
        const summary = fitSummaryWithinBudget({
          version: deps.version,
          sessionKind,
          runtimeKind,
          lineageRole,
          effectivePrimaryRole,
          deviceRoles: deps.deviceRoles(),
          executionRole: deps.executionRole(),
          hasAuthorizedWorkspace: run?.hasAuthorizedWorkspace === true,
          anchorReachable: deps.anchorReachable?.() ?? true,
          hasPostTurnControl: hasPostTurnControlCapability(),
          tools,
          mountedMcpServers,
          logAccess: {
            mode: logMode,
            filterableRefKinds,
          },
          availableScopes,
        });
        return { content: JSON.stringify(summary) };
      }

      if (scope === "workspaces") {
        if (
          restrictedSummaryOnly ||
          !(sessionKind === "main" || sessionKind === "workscene") ||
          !hasWorkspaceTools
        ) {
          return {
            content: JSON.stringify({
              availability: "ineligible",
              items: [],
            }),
          };
        }
        if (!deps.listWorkspaces) {
          return {
            content: JSON.stringify({
              availability: "unavailable",
              items: [],
            }),
          };
        }
        const offset = decodeWorkspaceCursor(
          typeof input.cursor === "string" ? input.cursor : undefined,
        );
        if (offset === null) {
          return { isError: true, content: "无效的工作区分页游标" };
        }
        const catalog = await deps.listWorkspaces();
        return {
          content: JSON.stringify(formatWorkspacePage(catalog, offset)),
        };
      }

      if (scope === "models") {
        if (restrictedSummaryOnly) {
          return {
            content: JSON.stringify({ availability: "ineligible" }),
          };
        }
        if (!deps.readModels) {
          return {
            content: JSON.stringify({ availability: "unavailable" }),
          };
        }
        const models = await deps.readModels(run?.conversationId);
        const out = {
          availability: "ok",
          effectivePrimaryRole,
          roleSummary: models.roleSummary,
          ...(models.sessionSelectionMode !== undefined
            ? { sessionSelectionMode: models.sessionSelectionMode }
            : {}),
          ...(models.dispatchSelectionMode !== undefined
            ? { dispatchSelectionMode: models.dispatchSelectionMode }
            : {}),
        };
        if (byteLen(out) > RUNTIME_INSPECT_MAX_BYTES) {
          return {
            content: JSON.stringify({
              availability: "ok",
              effectivePrimaryRole,
              roleSummary: models.roleSummary,
              omittedCount: 1,
            }),
          };
        }
        return { content: JSON.stringify(out) };
      }

      // scope === "health"
      if (restrictedSummaryOnly) {
        return {
          content: JSON.stringify({ availability: "ineligible" }),
        };
      }
      if (!readHealth) {
        return {
          content: JSON.stringify({ availability: "unavailable" }),
        };
      }
      const health = await readHealth();
      // 严禁外泄 DoctorReport.action（含备份目录路径）、PID 或端口号
      return {
        content: JSON.stringify({
          availability: "ok",
          processStatus: health.processStatus,
          healthCode: health.healthCode,
        }),
      };
    },
  };
}

/** Constructs explicit home-bound health dependencies (never falling back to default ~/.zhixing). */
export function createHomeBoundHealthBinding(
  zhixingHome: string,
  backupTargets: BackupTargetConfigurationRepository,
): NonNullable<RuntimeInspectDeps["healthBinding"]> {
  const resolved = path.resolve(zhixingHome);
  const pidPath = getDefaultPidPath(resolved);
  const portPath = getDefaultPortPath(resolved);
  const statePath = getDefaultStatePath(resolved);
  return {
    zhixingHome: resolved,
    backupTargets,
    statusDeps: {
      readLockFn: () => readLock({ pidPath, portPath }),
      readStateFn: async () => {
        try {
          return JSON.parse(await readFile(statePath, "utf8")) as ServerStateSnapshot;
        } catch {
          return null;
        }
      },
    },
  };
}
