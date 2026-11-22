/**
 * 对话模型 section 定义（v2 服务商连接 + 用途默认 + 模型资料与更新三块统一组织，设计 §3.1、§3.2、§3.4）。
 *
 * L1 主面板"对话模型"分组：
 *   1. 服务商连接（管理已配连接、新增预设/自定义/本地免密连接、删除与轮换）
 *   2. 条件修复/建议入口：迁移待修复项、预设更新建议（有项时顶部显式提醒）
 *   3. 用途默认（主模型必填；轻量/强力可选，缺配沿用主模型）
 *   4. 模型资料与更新（来源、修订、检查状态、立即刷新与自动检查开关）
 */

import type {
  ConfigEditorRuntime,
  EntryState,
  ModelRole,
  Section,
  SectionEntry,
  WorkingState,
} from "../types.js";
import {
  DEFAULT_MODEL_CATALOG_PORT,
  ROLE_SPECS,
} from "@zhixing-ai/providers/configuration";
import {
  countMigrationRepairItems,
  listPresetUpdateSuggestions,
  readConnection,
  readConnections,
  readModelMaxOutputPreference,
  readModelRole,
} from "../state.js";
import {
  checkModel,
  connectionCredentialStatus,
  hasApiKey,
  isConnectionReady,
  type ModelIssue,
} from "../checks/model.js";
import { collectBlockingConnectionIssues } from "../model/entity.js";

function formatCatalogSourceZh(
  source: "bundled" | "trusted-remote" | "recovered-previous",
): string {
  switch (source) {
    case "trusted-remote":
      return "官方可信目录";
    case "recovered-previous":
      return "已恢复上一版";
    case "bundled":
      return "随包基线";
  }
}

function formatCatalogLastStatusZh(
  status: "idle" | "up-to-date" | "updated" | "offline" | "failed" | "disabled",
): string {
  switch (status) {
    case "up-to-date":
      return "已是最新";
    case "updated":
      return "已更新";
    case "offline":
      return "离线保底";
    case "failed":
      return "刷新失败（已保底）";
    case "disabled":
      return "已关自动检查";
    case "idle":
      return "待检查";
  }
}

export const modelSection: Section = {
  id: "model",
  title: "对话模型",
  description: "三块统一组织：服务商连接、用途默认（主模型必填；轻/强力缺省沿用主模型）、模型资料与更新",
  entries: (state, runtime?: ConfigEditorRuntime) => {
    const catalog = runtime?.modelCatalog?.() ?? DEFAULT_MODEL_CATALOG_PORT;
    const allIssues = checkModel(state.config, state.credentials);
    const connections = readConnections(state);
    const connEntries = Object.entries(connections);
    const compromisedCount = connEntries.filter(
      ([, c]) => connectionCredentialStatus(c, state.credentials) === "compromised",
    ).length;
    const readyCount = connEntries.filter(([, c]) =>
      isConnectionReady(c, state.credentials),
    ).length;
    const presetSuggestions = listPresetUpdateSuggestions(state, catalog);
    const connBlockingIssues = collectBlockingConnectionIssues(state);

    const entries: SectionEntry[] = [
      {
        label: "服务商连接",
        state:
          connBlockingIssues.length > 0
            ? {
                kind: "blocked",
                statusText: connBlockingIssues[0]!.summary,
                issues: connBlockingIssues.map((item) => item.label),
              }
            : connEntries.length === 0
              ? { kind: "disabled", statusText: "未配置连接（按 Enter 新增预设或自定义/本地连接）" }
              : compromisedCount > 0
                ? {
                    kind: "disabled",
                    statusText: `已配 ${connEntries.length} 个连接（${compromisedCount} 个凭据已封禁需替换）`,
                  }
                : {
                    kind: "ready",
                    statusText: `已配 ${connEntries.length} 个连接（${readyCount} 个就绪${presetSuggestions.length > 0 ? ` · ${presetSuggestions.length} 项预设建议` : ""}）`,
                  },
        enterTarget: { kind: "connection-list" },
      },
    ];

    const repairCount = countMigrationRepairItems(state);
    if (repairCount > 0) {
      entries.push({
        label: "迁移待修复项",
        state: {
          kind: "disabled",
          statusText: `${repairCount} 项旧自定义端点或未归属覆盖待确认`,
        },
        enterTarget: { kind: "migration-repair" },
      });
    }

    if (presetSuggestions.length > 0) {
      entries.push({
        label: "预设更新建议",
        state: {
          kind: "disabled",
          statusText: `${presetSuggestions.length} 个连接有新的官方地址或协议建议（按 Enter 并排对比）`,
        },
        enterTarget: { kind: "preset-update-list" },
      });
    }

    for (const spec of ROLE_SPECS) {
      entries.push(
        buildRoleEntry(state, spec.id, allIssues, {
          label: `${spec.labelZh}（${spec.parenZh}）`,
          missingStatusText: spec.missingStatusZh,
          isOptional: !spec.required,
        }),
      );
    }

    const catStatus = runtime?.catalogStatus?.();
    const catSource = catStatus ? formatCatalogSourceZh(catStatus.source) : "随包基线";
    const catRevision = catStatus?.activeRevision ?? catalog.revision;
    const catStatusText = catStatus
      ? `${catSource} · ${catRevision} · ${formatCatalogLastStatusZh(catStatus.lastStatus)}${catStatus.upgradeNotice ? " · 建议升级知行" : ""}`
      : `${catSource} · ${catRevision}（按 Enter 查看状态与刷新）`;
    entries.push({
      label: "模型资料与更新",
      state:
        catStatus && (catStatus.lastStatus === "failed" || catStatus.upgradeNotice)
          ? { kind: "disabled", statusText: catStatusText }
          : { kind: "ready", statusText: catStatusText },
      enterTarget: { kind: "catalog-config" },
    });

    return entries;
  },
};

function buildRoleEntry(
  state: WorkingState,
  role: ModelRole,
  allIssues: ModelIssue[],
  display: { label: string; missingStatusText: string; isOptional: boolean },
): SectionEntry {
  const roleCfg = readModelRole(state, role);
  const isConfigured = Boolean(roleCfg?.provider && roleCfg?.model);
  const myIssues = allIssues.filter((i) => i.role === role);
  const conn = roleCfg?.provider ? readConnection(state, roleCfg.provider) : undefined;
  const connLabel = conn?.name ?? roleCfg?.provider ?? "";
  const credStatus = conn ? connectionCredentialStatus(conn, state.credentials) : undefined;
  const isReady = conn
    ? isConnectionReady(conn, state.credentials)
    : roleCfg?.provider
      ? hasApiKey(state.credentials, roleCfg.provider)
      : false;
  const mainConnectionId = readModelRole(state, "main")?.provider;
  const maxOutputPreference = readModelMaxOutputPreference(state, role);

  return {
    label: display.label,
    state: buildEntryState(
      roleCfg,
      conn,
      connLabel,
      credStatus,
      isConfigured,
      myIssues,
      isReady,
      mainConnectionId,
      maxOutputPreference,
      display,
    ),
    enterTarget: { kind: "provider-list", role },
  };
}

function buildEntryState(
  config: ReturnType<typeof readModelRole>,
  conn: ReturnType<typeof readConnection>,
  connLabel: string,
  credStatus: ReturnType<typeof connectionCredentialStatus> | undefined,
  isConfigured: boolean,
  myIssues: ModelIssue[],
  isReady: boolean,
  mainConnectionId: string | undefined,
  maxOutputPreference: number | undefined,
  display: { missingStatusText: string; isOptional: boolean },
): EntryState {
  if (!isConfigured && display.isOptional) {
    return { kind: "disabled", statusText: display.missingStatusText };
  }
  if (!isConfigured) {
    return {
      kind: "blocked",
      statusText: display.missingStatusText,
      issues: myIssues.map((i) => i.label),
    };
  }
  if (myIssues.length > 0) {
    if (credStatus === "compromised") {
      return {
        kind: "blocked",
        statusText: `${connLabel} · ${config!.model}（已封禁 · 存在但不可读取，需替换凭据）`,
        issues: myIssues.map((i) => i.label),
      };
    }
    if (credStatus === "revoked") {
      return {
        kind: "blocked",
        statusText: `${connLabel} · ${config!.model}（凭据已撤销，需重填）`,
        issues: myIssues.map((i) => i.label),
      };
    }
    const fields = myIssues.map((i) => i.fieldLabel).join(" / ");
    return {
      kind: "blocked",
      statusText: `${connLabel} · ${config!.model}（待补 ${fields}）`,
      issues: myIssues.map((i) => i.label),
    };
  }
  if (!isReady) {
    const sameAsMain = config!.provider === mainConnectionId;
    const secretNoun = conn?.auth.mode === "header" ? "认证头凭据" : "API Key";
    return {
      kind: "disabled",
      statusText: sameAsMain
        ? `${connLabel} · ${config!.model}（随主模型补 ${secretNoun}）`
        : credStatus === "compromised"
          ? `${connLabel} · ${config!.model}（已封禁 · 缺则回退主模型）`
          : `${connLabel} · ${config!.model}（待补 ${secretNoun}，缺则回退主模型）`,
    };
  }
  const readyTags: string[] = [];
  if (credStatus === "none") readyTags.push("免密");
  if (maxOutputPreference !== undefined) readyTags.push(`输出偏好 ${maxOutputPreference}`);
  return {
    kind: "ready",
    statusText:
      readyTags.length > 0
        ? `${connLabel} · ${config!.model}（${readyTags.join(" · ")}）`
        : `${connLabel} · ${config!.model}`,
  };
}
