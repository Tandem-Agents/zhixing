/**
 * 交互式 `/model` 命令控制器（设计 §3.1、§3.2、§3.4 #4、§7）。
 *
 * 构建在既有受控选择页原语 `chooseTerminalSelection` 之上，无需变更底层原生终端二进制：
 * - 顶部总览：当前会话生效模型（连接、精确型号、参数与来源：`跟随 main` / `跟随工作场景 power` / `本会话覆盖`）
 *   及 `main / light / power` 三用途默认与跟随状态；不可用当前项始终保留可见并说明原因与修复入口；
 * - 完整能力：按连接分组、当前项与适用推荐置顶、按名/ID/服务商搜索、安全分页、查看字段来源/容量/价格详情；
 * - 清晰作用域：普通确认仅改本会话主角色（`session.setModelSelection`），独立显式动作“设为用途默认”与“恢复跟随默认”；
 * - 原位调参 & 换模重算：直接按当前/目标型号已注册 `ThinkingControl` 重建控件，明确选择仅本会话或写入用途默认；
 * - 隐藏与取消隐藏：供应方型号可独立隐藏（写入 `hiddenModels`，刷新不复活），末尾提供“已隐藏型号（N）”折叠入口一键恢复；
 * - 刷新保态：刷新模型目录保持当前搜索词、页码与焦点，并分别反馈刷新结果。
 */

import { createHash } from "node:crypto";
import type {
  ModelSelectionParams,
  SessionModelSelection,
  ThinkingConfig,
  ThinkingControl,
} from "@zhixing-ai/core";
import {
  DEFAULT_MODEL_CATALOG_PORT,
  isLLMConfigV2,
  ROLE_SPECS,
  synthesizeConnectionModels,
  type DiscoveredModelRecord,
  type FieldProvenanceSource,
  type LLMConfigV2,
  type ModelCatalogPort,
  type ModelConnectionConfig,
  type ProviderCredentialProjection,
  type RoleId,
  type SynthesizedModelCandidate,
  type ZhixingConfig,
} from "@zhixing-ai/providers/configuration";
import type { ConfigurationApplicationResult } from "../runtime/configuration-application.js";
import {
  formatModelParamsSummary,
  formatRoleBrief,
  projectEffectiveModelDisplay,
  type EffectiveModelDisplay,
} from "../runtime/model-display-projection.js";
import { connectionCredentialStatus } from "../runtime/model-configuration-check.js";
import type { SelectionOption } from "../tui/selection/types.js";
import { chooseTerminalSelection, type TerminalSelectionPort } from "./selection.js";

const MODELS_PER_PAGE = 12;
const HIDDEN_PER_PAGE = 18;

export interface ModelCommandConversationMode {
  readonly kind: "main" | "normal" | "workscene";
  readonly sceneName?: string;
}

export interface ModelCommandController {
  readonly current: {
    readonly conversationId: string;
    readonly mode: ModelCommandConversationMode;
  };
}

export interface ModelCommandConversationPort {
  getModelSelection(
    conversationId: string,
  ): Promise<{ readonly modelSelection: SessionModelSelection }>;
  setModelSelection(
    conversationId: string,
    modelSelection: SessionModelSelection,
  ): Promise<{ readonly modelSelection: SessionModelSelection }>;
}

export interface ModelCommandCatalogRefreshReceipt {
  readonly status: string;
  readonly changed: boolean;
  readonly activeRevision: string;
  readonly message?: string;
  readonly error?: string;
}

export interface ModelCommandDiscoverySnapshot {
  readonly models?: readonly DiscoveredModelRecord[];
  readonly authoritativeNativeFacts?: boolean;
}

export interface TerminalModelCommandOptions {
  readonly controller: () => ModelCommandController | undefined;
  readonly conversation: ModelCommandConversationPort;
  readonly readConfiguration: () => Promise<{
    readonly config: ZhixingConfig;
    readonly credentials: ProviderCredentialProjection;
  }>;
  readonly saveModelConfiguration: (
    mutate: (config: ZhixingConfig) => ZhixingConfig,
  ) => Promise<ConfigurationApplicationResult>;
  readonly readCatalog: () => Promise<ModelCatalogPort>;
  readonly refreshCatalog: (signal?: AbortSignal) => Promise<ModelCommandCatalogRefreshReceipt>;
  /** 当前是否已连接宿主（宿主已接纳刷新不因离开等待页而取消；无宿主离线刷新允许本地取消）。 */
  readonly isHostConnected?: () => boolean;
  readonly readDiscoveryRecords?: (
    connectionId: string,
    connection: ModelConnectionConfig,
    credentials: ProviderCredentialProjection,
  ) => Promise<ModelCommandDiscoverySnapshot | undefined>;
  readonly choose: TerminalSelectionPort;
  readonly publishNotice: (message: string, isError?: boolean) => Promise<void>;
  readonly onChanged: () => Promise<void>;
  readonly signal: AbortSignal;
}

export interface ThinkingCompatibilityCheck {
  readonly compatible: boolean;
  readonly reason?: string;
}

export interface MaxOutputPreferenceValidation {
  readonly valid: boolean;
  readonly value?: number;
  readonly error?: string;
}

/** 校验请求级输出上限偏好（注册语义 `output.maxTokensPreference`），严禁与物理 `maxOutputTokens` 规格覆盖混淆。 */
export function validateMaxOutputPreferenceInput(
  raw: string,
  physicalMaxOutputTokens?: number,
): MaxOutputPreferenceValidation {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return { valid: false, error: "请输入正整数 token 数量（或选择清除输出偏好）。" };
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return { valid: false, error: "输出偏好必须为大于 0 的正整数。" };
  }
  if (
    physicalMaxOutputTokens !== undefined &&
    Number.isFinite(physicalMaxOutputTokens) &&
    parsed > physicalMaxOutputTokens
  ) {
    return {
      valid: false,
      error: `输出偏好 ${parsed} 超出该模型物理最大输出上限（${physicalMaxOutputTokens} tokens）；请求输出偏好不可超过物理上限，如需调整物理上限请到 /config「服务商连接 → 规格覆盖」。`,
    };
  }
  return { valid: true, value: parsed };
}

/** 校验既有 thinking 参数是否与目标型号已注册的 ThinkingControl 兼容（与 `/config` 共用同一规则源）。 */
export function isThinkingCompatible(
  control: ThinkingControl | undefined,
  thinking: ThinkingConfig | undefined,
): ThinkingCompatibilityCheck {
  if (!thinking) return { compatible: true };
  if (!control || control.type === "none") {
    if (thinking.mode === "off") return { compatible: true };
    return {
      compatible: false,
      reason: "目标型号未声明可配思考控制，旧思考参数无法继续沿用",
    };
  }
  if (control.type === "toggle") {
    if (thinking.mode === "off" || thinking.mode === "on") return { compatible: true };
    return {
      compatible: false,
      reason: `目标型号仅支持开关形态（开启/关闭），无法沿用原 ${thinking.mode} 参数`,
    };
  }
  if (control.type === "effort") {
    if (thinking.mode === "off" || thinking.mode === "on") return { compatible: true };
    if (thinking.mode === "effort" && control.efforts.includes(thinking.effort)) {
      return { compatible: true };
    }
    return {
      compatible: false,
      reason: `目标型号支持的思考强度为 ${control.efforts.join(" / ")}，原参数不兼容`,
    };
  }
  if (control.type === "budget") {
    if (thinking.mode === "off" || thinking.mode === "on") return { compatible: true };
    if (thinking.mode === "budget") {
      if (
        control.range &&
        (thinking.budget < control.range[0] || thinking.budget > control.range[1])
      ) {
        return {
          compatible: false,
          reason: `目标型号思考预算合法范围为 ${control.range[0]}–${control.range[1]} tokens，原预算 ${thinking.budget} 超出范围`,
        };
      }
      return { compatible: true };
    }
    return {
      compatible: false,
      reason: "目标型号仅支持 token 预算形态（budget/开启/关闭），无法沿用原参数",
    };
  }
  return { compatible: true };
}

export function describeProvenanceSource(
  source: FieldProvenanceSource,
  thirdPartyUnverified?: boolean,
): string {
  switch (source) {
    case "user-override":
      return "用户覆盖";
    case "native-discovery":
      return thirdPartyUnverified ? "聚合端发现（非权威）" : "原生发现";
    case "curated-catalog":
      return "官方策展目录";
    case "builtin-baseline":
      return "随包基线";
    case "unknown":
      return "未知";
  }
}

interface CatalogListItem {
  readonly key: string;
  readonly connectionId: string;
  readonly connectionName: string;
  readonly connection?: ModelConnectionConfig;
  readonly modelId: string;
  readonly displayName: string;
  readonly isCurrent: boolean;
  readonly isRecommended: boolean;
  readonly isAvailable: boolean;
  readonly unavailableReason?: string;
  readonly candidate?: SynthesizedModelCandidate;
  readonly isCustom: boolean;
}

interface HiddenModelEntry {
  readonly key: string;
  readonly connectionId: string;
  readonly connectionName: string;
  readonly modelId: string;
  readonly displayName: string;
}

interface BuiltModelCatalogView {
  readonly effective: EffectiveModelDisplay;
  readonly items: readonly CatalogListItem[];
  readonly hidden: readonly HiddenModelEntry[];
  readonly config: ZhixingConfig;
  readonly credentials: ProviderCredentialProjection;
  readonly catalog: ModelCatalogPort;
  readonly sessionSelection: SessionModelSelection;
  readonly defaultRole: "main" | "power";
}

function formatTokensCompact(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "未知";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

function formatBoolField(value: boolean | undefined): string {
  if (value === true) return "支持";
  if (value === false) return "不支持";
  return "未知";
}

function formatThinkingControl(control: ThinkingControl | undefined): string {
  if (!control || control.type === "none") return "无独立思考控件";
  if (control.type === "toggle") return "开关（开启 / 关闭）";
  if (control.type === "effort") {
    return `档位（${control.efforts.join(" / ")}${control.default ? `，默认 ${control.default}` : ""}）`;
  }
  if (control.type === "budget") {
    return control.range
      ? `预算（${control.range[0]}–${control.range[1]} tokens）`
      : "预算（自定义 tokens）";
  }
  return "未知";
}

export function buildModelDetailLines(item: CatalogListItem): string[] {
  const lines: string[] = [
    `模型 ID：${item.modelId}`,
    ...(item.displayName !== item.modelId ? [`显示名称：${item.displayName}`] : []),
    `所属连接：${item.connectionName} (${item.connectionId})`,
  ];
  if (item.connection) {
    lines.push(`协议 / 端点：${item.connection.adapter} · ${item.connection.endpoint}`);
  }
  if (!item.isAvailable && item.unavailableReason) {
    lines.push(`⚠ 当前不可用：${item.unavailableReason}`);
  }
  const c = item.candidate;
  if (c) {
    lines.push(
      `上下文窗口：${formatTokensCompact(c.fields.contextWindow.value)}（来源：${describeProvenanceSource(c.fields.contextWindow.source, c.fields.contextWindow.thirdPartyUnverified)}）`,
    );
    lines.push(
      `最大输出：${formatTokensCompact(c.fields.maxOutputTokens.value)}（来源：${describeProvenanceSource(c.fields.maxOutputTokens.source, c.fields.maxOutputTokens.thirdPartyUnverified)}）`,
    );
    if (c.recommendedMaxOutputTokens !== undefined) {
      lines.push(`建议默认输出上限：${formatTokensCompact(c.recommendedMaxOutputTokens)}`);
    }
    lines.push(
      `图片输入：${formatBoolField(c.fields.supportsImages.value)}（来源：${describeProvenanceSource(c.fields.supportsImages.source, c.fields.supportsImages.thirdPartyUnverified)}）`,
    );
    lines.push(
      `工具调用：${formatBoolField(c.fields.supportsTools.value)}（来源：${describeProvenanceSource(c.fields.supportsTools.source, c.fields.supportsTools.thirdPartyUnverified)}）`,
    );
    lines.push(
      `思考能力：${formatBoolField(c.fields.supportsThinking.value)} · ${formatThinkingControl(c.fields.thinkingControl.value)}（来源：${describeProvenanceSource(c.fields.thinkingControl.source, c.fields.thinkingControl.thirdPartyUnverified)}）`,
    );
    if (c.pricing) {
      const priceParts: string[] = [];
      if (c.pricing.inputPerMillion !== undefined) priceParts.push(`输入 ${c.pricing.inputPerMillion}`);
      if (c.pricing.outputPerMillion !== undefined) priceParts.push(`输出 ${c.pricing.outputPerMillion}`);
      if (c.pricing.cachedInputPerMillion !== undefined) {
        priceParts.push(`缓存读 ${c.pricing.cachedInputPerMillion}`);
      }
      lines.push(
        `参考价格（每百万 tokens，${c.pricing.currency}）：${priceParts.join(" / ") || "未标明"}${c.pricing.note ? `（${c.pricing.note}）` : ""}`,
      );
    }
    if (c.lifecycle === "deprecated") {
      lines.push(
        `生命周期：已弃用${c.replacementModelId ? `（建议迁移至 ${c.replacementModelId}）` : ""}${c.lifecycleReason ? ` · ${c.lifecycleReason}` : ""}`,
      );
    } else if (c.lifecycle === "retired") {
      lines.push(
        `生命周期：已停供${c.replacementModelId ? `（建议迁移至 ${c.replacementModelId}）` : ""}${c.lifecycleReason ? ` · ${c.lifecycleReason}` : ""}`,
      );
    }
    if (c.requiresUpgrade) {
      lines.push(`版本要求：需要升级知行客户端（缺少能力：${c.missingCapabilities.join("、")}）`);
    }
    if (c.overrideConflicts.length > 0) {
      lines.push("⚠ 规格覆盖受权威硬约束限制：");
      for (const conflict of c.overrideConflicts) {
        lines.push(`  - ${conflict.message}`);
      }
    }
  } else {
    lines.push("模型规格：资料不足/未知（未在策展目录或原生发现中收录；仍可直接选用或在 /config 添加规格覆盖）");
  }
  return lines;
}

function summarizeCandidateCompact(item: CatalogListItem): string {
  const tags: string[] = [];
  if (item.isCurrent) tags.push("当前");
  if (item.isRecommended) tags.push("推荐");
  if (!item.isAvailable) tags.push("不可用");
  const c = item.candidate;
  if (c) {
    if (c.discovered) tags.push("已发现");
    if (c.isCustom) tags.push("自定义");
    if (c.lifecycle === "deprecated") tags.push("已弃用");
    if (c.lifecycle === "retired") tags.push("已停供");
    if (c.requiresUpgrade) tags.push("需升级知行");
    if (c.overrideConflicts.length > 0) tags.push("覆盖受限");
    if (c.metadataStatus === "unknown") tags.push("资料未知");
    const specs: string[] = [];
    if (c.fields.contextWindow.value !== undefined) {
      specs.push(formatTokensCompact(c.fields.contextWindow.value));
    }
    if (c.fields.supportsImages.value === true) specs.push("视觉");
    if (c.fields.supportsThinking.value === true) specs.push("思考");
    if (specs.length > 0) tags.push(specs.join("/"));
  } else if (item.isCustom) {
    tags.push("自定义");
  }
  if (!item.isAvailable && item.unavailableReason) {
    tags.push(item.unavailableReason.slice(0, 48));
  }
  return tags.join(" · ");
}

function describeConfigApplyResult(result: ConfigurationApplicationResult, actionLabel: string): string {
  if (result.kind === "local-applied") {
    return result.warning
      ? `✓ ${actionLabel}已保存并窄生效（提示：${result.warning}）。`
      : `✓ ${actionLabel}已保存并立即生效。`;
  }
  if (result.kind === "saved-pending") {
    return `⚠ ${actionLabel}已保存、待应用${result.reason ? `：${result.reason}` : "。"}`;
  }
  if (result.kind === "reloaded") {
    return `✓ ${actionLabel}已保存并完成服务重载。`;
  }
  return `已取消${actionLabel}。`;
}

function makeModelKey(connectionId: string, modelId: string): string {
  // 必须严格满足 terminalSelectionActions 的 ASCII 可打印与 <=256 长度约束，且跨目录刷新稳定保焦
  return createHash("sha256")
    .update(`${connectionId}\u0000${modelId}`, "utf8")
    .digest("hex")
    .slice(0, 16);
}

export class TerminalModelCommand {
  #generation = 0;
  #running = false;
  #disposed = false;
  #activeRefresh?: {
    readonly hostManaged: boolean;
    readonly promise: Promise<string>;
    readonly abortOffline?: () => void;
  };
  #completedRefreshBanner?: string;
  readonly #refreshListeners = new Set<() => void>();

  constructor(readonly options: TerminalModelCommandOptions) {}

  invalidate(): void {
    ++this.#generation;
  }

  dispose(): void {
    this.#disposed = true;
    this.invalidate();
    this.#refreshListeners.clear();
    // 仅取消本地无宿主离线刷新；宿主已接纳的刷新绝不因关闭页面而被取消
    this.#activeRefresh?.abortOffline?.();
    if (this.#activeRefresh && !this.#activeRefresh.hostManaged) {
      this.#activeRefresh = undefined;
    }
  }

  #notifyRefreshSettled(): void {
    for (const listener of [...this.#refreshListeners]) {
      try {
        listener();
      } catch {
        // 单个订阅者异常不影响其他刷新收尾
      }
    }
  }

  async run(initialQuery = ""): Promise<void> {
    if (this.#running) throw Error("另一个模型管理页面尚未结束。");
    const controller = this.options.controller();
    if (!controller || this.#disposed || this.options.signal.aborted) {
      throw Error("连接不可用，请重新连接后再打开 /model。");
    }
    const generation = ++this.#generation;
    const conversationId = controller.current.conversationId;
    const isCurrent = () =>
      !this.#disposed &&
      !this.options.signal.aborted &&
      generation === this.#generation &&
      this.options.controller() === controller &&
      controller.current.conversationId === conversationId;

    this.#running = true;
    let searchQuery = initialQuery.trim();
    let page = 0;
    let focusValue: string | undefined;
    let banner: string | undefined;

    try {
      for (;;) {
        if (!isCurrent()) return;
        let view = await this.#loadView(controller);
        if (!isCurrent()) return;
        let latestView = view;

        if (!banner && this.#completedRefreshBanner) {
          banner = this.#completedRefreshBanner;
          this.#completedRefreshBanner = undefined;
        }
        const activeRefreshAtLoad = this.#activeRefresh;
        const initialBuilt = this.#buildCatalogListPage(view, {
          searchQuery,
          page,
          focusValue,
          banner,
        });
        let totalPages = initialBuilt.totalPages;
        page = initialBuilt.clampedPage;

        const chosen = await chooseTerminalSelection(
          initialBuilt.request,
          this.options.choose,
          {
            subscribe: (onUpdate) => {
              let subscribed = true;
              const pushLatest = async () => {
                if (!subscribed || !isCurrent()) return;
                let nextView = latestView;
                try {
                  nextView = await this.#loadView(controller);
                } catch {
                  // 瞬态读取失败时仍以现有列表刷新横幅与动作按钮，避免停留于“后台进行中”
                }
                if (!subscribed || !isCurrent()) return;
                latestView = nextView;
                const nextBanner = this.#completedRefreshBanner ?? banner;
                const rebuilt = this.#buildCatalogListPage(nextView, {
                  searchQuery,
                  page,
                  focusValue,
                  banner: nextBanner,
                });
                const markDisplayed = () => {
                  if (!subscribed) return;
                  view = nextView;
                  totalPages = rebuilt.totalPages;
                  page = rebuilt.clampedPage;
                  banner = nextBanner;
                  if (this.#completedRefreshBanner === nextBanner) {
                    this.#completedRefreshBanner = undefined;
                  }
                };
                await onUpdate(rebuilt.request, markDisplayed);
              };
              const listener = () => {
                void pushLatest();
              };
              this.#refreshListeners.add(listener);
              // 若后台刷新在 #loadView 与 subscribe 之间的微任务窗口内刚结束，立即推送收口更新
              if (activeRefreshAtLoad && this.#activeRefresh !== activeRefreshAtLoad) {
                queueMicrotask(listener);
              }
              return () => {
                subscribed = false;
                this.#refreshListeners.delete(listener);
              };
            },
          },
        );
        if (!isCurrent() || !chosen || chosen.kind === "cancelled" || chosen.value === "action:close") {
          return;
        }

        banner = undefined;
        focusValue = chosen.value;

        if (chosen.value === "action:search") {
          searchQuery = ("input" in chosen ? chosen.input : "").trim();
          page = 0;
          focusValue = undefined;
          continue;
        }
        if (chosen.value === "action:clear-search") {
          searchQuery = "";
          page = 0;
          focusValue = undefined;
          continue;
        }
        if (chosen.value === "page:prev") {
          page = Math.max(0, page - 1);
          focusValue = undefined;
          continue;
        }
        if (chosen.value === "page:next") {
          page = Math.min(totalPages - 1, page + 1);
          focusValue = undefined;
          continue;
        }
        if (chosen.value === "action:refresh-progress") {
          if (this.#activeRefresh) {
            const outcome = await this.#refreshCatalogFlow(searchQuery, isCurrent);
            if (outcome.action === "exit") return;
            banner = outcome.banner;
          } else {
            // 后台刷新已完成后绝不借“查看目录刷新进度”暗中重发刷新
            banner = this.#completedRefreshBanner ?? "✓ 模型目录刷新已完成，列表已更新。";
            this.#completedRefreshBanner = undefined;
            focusValue = "action:refresh-catalog";
          }
          continue;
        }
        if (chosen.value === "action:refresh-catalog") {
          const outcome = await this.#refreshCatalogFlow(searchQuery, isCurrent);
          if (outcome.action === "exit") return;
          banner = outcome.banner;
          // 明确保持 searchQuery、page 与 focusValue 不变
          continue;
        }
        if (chosen.value === "action:follow-default") {
          try {
            await this.options.conversation.setModelSelection(conversationId, {
              mode: "follow-default",
            });
            await this.options.onChanged();
            banner = `✓ 本会话已恢复跟随默认（${latestView.defaultRole === "power" ? "工作场景 power / main" : "主模型 main"}）。`;
            focusValue = undefined;
          } catch (error) {
            banner = `⚠ 恢复跟随默认失败：${error instanceof Error ? error.message : String(error)}`;
          }
          continue;
        }
        if (chosen.value === "action:tune") {
          const outcome = await this.#tuneCurrentModelFlow(conversationId, latestView, isCurrent);
          if (outcome) banner = outcome;
          continue;
        }
        if (chosen.value === "action:hidden") {
          const outcome = await this.#hiddenModelsFlow(latestView, isCurrent);
          if (outcome) banner = outcome;
          continue;
        }
        if (chosen.value.startsWith("model:")) {
          const modelKey = chosen.value.slice("model:".length);
          const item =
            latestView.items.find((entry) => entry.key === modelKey) ??
            view.items.find((entry) => entry.key === modelKey);
          if (!item) continue;
          const outcome = await this.#modelActionFlow(conversationId, latestView, item, isCurrent);
          if (outcome) banner = outcome;
          continue;
        }
      }
    } finally {
      this.#running = false;
    }
  }

  #buildCatalogListPage(
    view: BuiltModelCatalogView,
    params: {
      readonly searchQuery: string;
      readonly page: number;
      readonly focusValue: string | undefined;
      readonly banner: string | undefined;
    },
  ): {
    readonly totalPages: number;
    readonly clampedPage: number;
    readonly request: {
      readonly id: string;
      readonly title: string;
      readonly body: string[];
      readonly options: SelectionOption<string>[];
      readonly initialValue?: string;
      readonly submitLabel: string;
    };
  } {
    const { searchQuery, focusValue, banner } = params;
    const filtered = this.#filterItems(view.items, searchQuery);
    const totalPages = Math.max(1, Math.ceil(filtered.length / MODELS_PER_PAGE));
    const clampedPage = Math.min(Math.max(0, params.page), totalPages - 1);
    const pageItems = filtered.slice(
      clampedPage * MODELS_PER_PAGE,
      (clampedPage + 1) * MODELS_PER_PAGE,
    );

    const activeRefreshNote =
      this.#activeRefresh && !banner
        ? "⏳ 后台正在刷新模型目录（可继续使用现有列表，或按 Esc 返回对话输入）"
        : undefined;

    const bodyLines: string[] = [
      `当前生效：${view.effective.connectionName || view.effective.providerId || "(未配置)"} · ${view.effective.model || "(未配置)"}（${view.effective.sourceLabel ?? "跟随 main"}）`,
      ...(view.effective.paramsSummary ? [`当前参数：${view.effective.paramsSummary}`] : []),
      ...(view.effective.available === false && view.effective.unavailableReason
        ? [`⚠ 当前项不可用：${view.effective.unavailableReason}`]
        : []),
      ...(view.effective.warning ? [`⚠ 回退警示：${view.effective.warning}`] : []),
      ...(view.effective.roles
        ? [
            `用途默认：main=${formatRoleBrief(view.effective.roles.main)} ｜ light=${formatRoleBrief(view.effective.roles.light)} ｜ power=${formatRoleBrief(view.effective.roles.power)}`,
          ]
        : []),
      ...(searchQuery
        ? [`搜索筛选：“${searchQuery}”（匹配 ${filtered.length} / ${view.items.length} 项）`]
        : []),
      ...(banner ? [banner] : activeRefreshNote ? [activeRefreshNote] : []),
    ];

    const options: SelectionOption<string>[] = [];

    if (view.effective.connectionId && view.effective.model) {
      options.push({
        value: "action:tune",
        label: "调整当前模型参数（原位调参）",
        description: view.effective.paramsSummary
          ? `当前：${view.effective.paramsSummary} · 可选仅本会话或写入用途默认`
          : "调整思考档位/预算或输出偏好，可选仅本会话或写入用途默认",
      });
    }

    options.push({
      value: "action:search",
      label: searchQuery ? `修改搜索词（当前：${searchQuery}）` : "搜索模型…",
      description: "按模型 ID、显示名或服务商名称筛选（留空可清除）",
      input: {
        placeholder: "输入关键词（留空清除筛选）",
        allowEmpty: true,
      },
    });

    if (searchQuery) {
      options.push({
        value: "action:clear-search",
        label: "清除搜索筛选",
        description: `显示全部 ${view.items.length} 个模型`,
      });
    }

    if (view.effective.mode === "override") {
      options.push({
        value: "action:follow-default",
        label: "恢复跟随默认",
        description:
          view.defaultRole === "power"
            ? "取消本会话覆盖，重新跟随工作场景默认（power / main）"
            : "取消本会话覆盖，重新跟随主模型默认（main）",
      });
    }

    options.push(
      this.#activeRefresh
        ? {
            value: "action:refresh-progress",
            label: "查看目录刷新进度",
            description: "后台刷新正在进行中（按 Enter 查看等待状态，不会重复发起请求）",
          }
        : {
            value: "action:refresh-catalog",
            label: "刷新模型目录",
            description: `当前目录修订 ${view.catalog.revision}（刷新保留搜索词与焦点）`,
          },
    );

    for (const item of pageItems) {
      const prefix = item.isCurrent ? "● " : item.isRecommended ? "★ " : "";
      options.push({
        value: `model:${item.key}`,
        label: `${prefix}[${item.connectionName}] ${item.modelId}`,
        description: summarizeCandidateCompact(item),
        details: {
          title: `${item.connectionName} · ${item.modelId}`,
          body: buildModelDetailLines(item),
        },
      });
    }

    if (clampedPage > 0) {
      options.push({
        value: "page:prev",
        label: `上一页模型（当前第 ${clampedPage + 1}/${totalPages} 页）`,
        paging: "previous",
      });
    }
    if (clampedPage + 1 < totalPages) {
      options.push({
        value: "page:next",
        label: `下一页模型（当前第 ${clampedPage + 1}/${totalPages} 页）`,
        paging: "next",
      });
    }

    if (view.hidden.length > 0) {
      options.push({
        value: "action:hidden",
        label: `已隐藏型号（${view.hidden.length}）`,
        description: "展开查看已隐藏的供应方型号并一键恢复显示",
      });
    }

    options.push({
      value: "action:close",
      label: "返回输入",
      dismiss: true,
    });

    const mappedFocus =
      focusValue === "action:refresh-catalog" && this.#activeRefresh
        ? "action:refresh-progress"
        : focusValue === "action:refresh-progress" && !this.#activeRefresh
          ? "action:refresh-catalog"
          : focusValue;
    const validInitial =
      mappedFocus && options.some((opt) => opt.value === mappedFocus && !opt.disabled)
        ? mappedFocus
        : undefined;

    return {
      totalPages,
      clampedPage,
      request: {
        id: "terminal-model",
        title: "模型管理（/model）",
        body: bodyLines,
        options,
        ...(validInitial ? { initialValue: validInitial } : {}),
        submitLabel: "应用筛选",
      },
    };
  }

  #startOrAttachRefresh(): {
    readonly hostManaged: boolean;
    readonly promise: Promise<string>;
    readonly abortOffline?: () => void;
  } {
    if (this.#activeRefresh) {
      return this.#activeRefresh;
    }
    const hostManaged = this.options.isHostConnected ? this.options.isHostConnected() : true;
    const offlineAbort = hostManaged ? undefined : new AbortController();
    let activeRef:
      | {
          readonly hostManaged: boolean;
          readonly promise: Promise<string>;
          readonly abortOffline?: () => void;
        }
      | undefined;

    const settle = (text: string, changed: boolean) => {
      if (this.#activeRefresh === activeRef) {
        this.#activeRefresh = undefined;
      }
      if (!offlineAbort?.signal.aborted) {
        this.#completedRefreshBanner = text;
        if (changed) {
          void this.options.onChanged().catch(() => {});
        }
        this.#notifyRefreshSettled();
      }
      return text;
    };

    const promise = Promise.resolve()
      .then(() => this.options.refreshCatalog(offlineAbort?.signal))
      .then((receipt) => {
        if (offlineAbort?.signal.aborted) {
          if (this.#activeRefresh === activeRef) {
            this.#activeRefresh = undefined;
          }
          return "已取消本次模型目录刷新，已保留当前本地目录。";
        }
        const text =
          receipt.status === "updated"
            ? `✓ 目录已更新至修订 ${receipt.activeRevision}${receipt.message ? `（${receipt.message}）` : ""}`
            : receipt.status === "up-to-date"
              ? `✓ 模型目录已是最新（修订 ${receipt.activeRevision}）`
              : receipt.status === "offline"
                ? `⚠ 当前离线，已保留本地目录（修订 ${receipt.activeRevision}）`
                : `⚠ 目录刷新未更新（${receipt.status}）：${receipt.error ?? receipt.message ?? "已保留当前目录"}`;
        return settle(text, Boolean(receipt.changed || receipt.status === "updated"));
      })
      .catch((error) => {
        if (offlineAbort?.signal.aborted) {
          if (this.#activeRefresh === activeRef) {
            this.#activeRefresh = undefined;
          }
          return "已取消本次模型目录刷新，已保留当前本地目录。";
        }
        const text = `⚠ 目录刷新失败（已保留当前目录）：${error instanceof Error ? error.message : String(error)}`;
        return settle(text, false);
      });

    activeRef = {
      hostManaged,
      promise,
      ...(offlineAbort ? { abortOffline: () => offlineAbort.abort() } : {}),
    };
    this.#activeRefresh = activeRef;
    return activeRef;
  }

  async #refreshCatalogFlow(
    searchQuery: string,
    isCurrent: () => boolean,
  ): Promise<{ readonly action: "stay"; readonly banner: string } | { readonly action: "exit" }> {
    const active = this.#startOrAttachRefresh();
    const waitAbort = new AbortController();
    const onParentAbort = () => waitAbort.abort();
    this.options.signal.addEventListener("abort", onParentAbort, { once: true });

    const waitingPage = {
      kind: "selection" as const,
      selectionLayer: "select" as const,
      title: "刷新模型目录",
      busy: true,
      message: [
        "正在从可信目录源检查并刷新模型目录…",
        ...(searchQuery ? [`当前搜索筛选：“${searchQuery}”（刷新完成后将保留）`] : []),
        active.hostManaged
          ? "宿主已接纳刷新请求：按 Esc 或选择下方操作可立即返回，宿主将继续在后台完成刷新。"
          : "按 Esc 或选择下方操作可立即取消本次本地刷新并返回。",
      ].join("\n"),
      choices: [
        {
          id: "back-list",
          label: "返回模型列表",
          detail: active.hostManaged
            ? "继续使用现有列表，宿主在后台完成刷新"
            : "取消本次刷新并返回现有列表",
        },
        {
          id: "exit-model",
          label: "返回对话输入",
          detail: active.hostManaged
            ? "关闭 /model，宿主在后台完成刷新"
            : "取消本次刷新并关闭 /model",
        },
      ],
    };

    try {
      const waitPromise = this.options.choose(waitingPage, waitAbort.signal);
      const raced = await Promise.race([
        active.promise.then((text) => ({ kind: "completed" as const, text })),
        waitPromise.then((response) => ({ kind: "user" as const, response })),
      ]);

      if (raced.kind === "completed") {
        waitAbort.abort();
        await waitPromise.catch(() => undefined);
        if (!isCurrent()) return { action: "exit" };
        this.#completedRefreshBanner = undefined;
        return { action: "stay", banner: raced.text };
      }

      if (!isCurrent() || raced.response?.cancelCause === "aborted") {
        return { action: "exit" };
      }

      if (!active.hostManaged) {
        active.abortOffline?.();
        if (this.#activeRefresh === active) {
          this.#activeRefresh = undefined;
        }
      }

      if (
        raced.response?.itemId === "exit-model" ||
        raced.response?.cancelCause === "ctrl-c" ||
        raced.response?.cancelCause === "ctrl-d"
      ) {
        await this.options
          .publishNotice(
            active.hostManaged
              ? "模型目录刷新已转入后台继续完成。"
              : "已取消本次模型目录刷新，已保留当前本地目录。",
            false,
          )
          .catch(() => {});
        return { action: "exit" };
      }

      return {
        action: "stay",
        banner: active.hostManaged
          ? "⏳ 目录刷新仍在后台进行中（可继续使用现有列表，或再按 Esc 返回对话输入）"
          : "已取消本次模型目录刷新，已保留当前本地目录。",
      };
    } finally {
      this.options.signal.removeEventListener("abort", onParentAbort);
    }
  }

  async #loadView(controller: ModelCommandController): Promise<BuiltModelCatalogView> {
    const [{ config, credentials }, catalog, selectionResult] = await Promise.all([
      this.options.readConfiguration(),
      this.options.readCatalog().catch(() => DEFAULT_MODEL_CATALOG_PORT),
      this.options.conversation
        .getModelSelection(controller.current.conversationId)
        .catch(() => ({ modelSelection: { mode: "follow-default" as const } })),
    ]);

    const sessionMode: "normal" | "workscene" =
      controller.current.mode.kind === "workscene" ? "workscene" : "normal";
    const defaultRole: "main" | "power" = sessionMode === "workscene" ? "power" : "main";
    const modelCredentials = credentials;
    const effective = projectEffectiveModelDisplay({
      config,
      credentials: modelCredentials,
      sessionMode,
      sessionSelection: selectionResult.modelSelection,
      catalog,
    });

    const items: CatalogListItem[] = [];
    const hidden: HiddenModelEntry[] = [];
    const seenKeys = new Set<string>();
    const rawLlm = config.llm as unknown;

    const currentKey =
      effective.connectionId && effective.model
        ? makeModelKey(effective.connectionId, effective.model)
        : undefined;

    if (isLLMConfigV2(rawLlm)) {
      const recForRole = catalog.getCuratedRecommendations(defaultRole);
      const recPairs = new Set(recForRole.map((r) => `${r.presetId}\u0000${r.modelId}`));

      const connEntries = Object.entries(rawLlm.connections);
      const discoverySnapshots = await Promise.all(
        connEntries.map(async ([connectionId, connection]) => {
          const snapshot = this.options.readDiscoveryRecords
            ? await this.options
                .readDiscoveryRecords(connectionId, connection, credentials)
                .catch(() => undefined)
            : undefined;
          return [connectionId, snapshot] as const;
        }),
      );
      const discoveryByConn = new Map(discoverySnapshots);

      const candidateMap = new Map<string, CatalogListItem>();

      for (const [connectionId, connection] of connEntries) {
        const credStatus = connectionCredentialStatus(connection, modelCredentials);
        const adapterOk = catalog.isAdapterImplemented(connection.adapter);
        const connUnavailableReason = !adapterOk
          ? `协议「${connection.adapter}」当前版本不支持`
          : credStatus === "compromised"
            ? "凭据已封禁 · 请打开 /config 替换新密钥"
            : credStatus === "revoked"
              ? "凭据已撤销 · 请打开 /config 重新填写"
              : credStatus === "missing"
                ? "缺少连接凭据 · 请打开 /config 补全"
                : undefined;

        const disc = discoveryByConn.get(connectionId);
        const synth = synthesizeConnectionModels({
          connectionId,
          connection,
          catalog: catalog.bundle,
          discoveredModels: disc?.models,
          discoveredAuthoritative: disc?.authoritativeNativeFacts,
          adapterImplemented: adapterOk,
          includeHidden: false,
          includeOverrideOnlyIds: false,
        });

        for (const h of synth.hiddenModels) {
          hidden.push({
            key: makeModelKey(connectionId, h.id),
            connectionId,
            connectionName: connection.name,
            modelId: h.id,
            displayName: h.displayName,
          });
        }

        for (const c of synth.models) {
          const key = makeModelKey(connectionId, c.id);
          const itemUnavailableReason =
            connUnavailableReason ??
            (c.lifecycle === "retired"
              ? `已停供${c.replacementModelId ? `（建议 ${c.replacementModelId}）` : ""}`
              : c.requiresUpgrade
                ? "需要升级知行客户端"
                : undefined);
          const isRecommended = Boolean(
            connection.presetId &&
              recPairs.has(`${connection.presetId}\u0000${c.id}`) &&
              !itemUnavailableReason,
          );
          candidateMap.set(key, {
            key,
            connectionId,
            connectionName: connection.name,
            connection,
            modelId: c.id,
            displayName: c.displayName,
            isCurrent: key === currentKey,
            isRecommended,
            isAvailable: !itemUnavailableReason,
            ...(itemUnavailableReason ? { unavailableReason: itemUnavailableReason } : {}),
            candidate: c,
            isCustom: c.isCustom,
          });
        }
      }

      // 1. 置顶当前生效项（即使连接缺失、凭据缺失、停供、隐藏或目录未收录也始终保留可见！）
      if (currentKey && effective.connectionId && effective.model) {
        const existing = candidateMap.get(currentKey);
        if (existing) {
          items.push({
            ...existing,
            isCurrent: true,
            isAvailable: effective.available !== false && existing.isAvailable,
            unavailableReason: effective.unavailableReason ?? existing.unavailableReason,
          });
          seenKeys.add(currentKey);
        } else {
          const conn = rawLlm.connections[effective.connectionId];
          items.push({
            key: currentKey,
            connectionId: effective.connectionId,
            connectionName: effective.connectionName ?? effective.connectionId,
            ...(conn ? { connection: conn } : {}),
            modelId: effective.model,
            displayName: effective.model,
            isCurrent: true,
            isRecommended: false,
            isAvailable: effective.available !== false,
            ...(effective.unavailableReason
              ? { unavailableReason: effective.unavailableReason }
              : {}),
            isCustom: Boolean(conn?.customModels?.includes(effective.model)),
          });
          seenKeys.add(currentKey);
        }
      }

      // 1b. 若工作场景原配 power 因不可用而回退到 main，也保留该失效原配置项在列表中可见，便于用户排查与修复
      if (effective.degradedFrom) {
        const deg = effective.degradedFrom;
        const degKey = makeModelKey(deg.connectionId, deg.model);
        if (!seenKeys.has(degKey)) {
          const existing = candidateMap.get(degKey);
          if (existing) {
            items.push({
              ...existing,
              isAvailable: false,
              unavailableReason: `原配 ${deg.role} 不可用（已回退 main）：${deg.reason}`,
            });
          } else {
            const conn = rawLlm.connections[deg.connectionId];
            items.push({
              key: degKey,
              connectionId: deg.connectionId,
              connectionName: deg.connectionName,
              ...(conn ? { connection: conn } : {}),
              modelId: deg.model,
              displayName: deg.model,
              isCurrent: false,
              isRecommended: false,
              isAvailable: false,
              unavailableReason: `原配 ${deg.role} 不可用（已回退 main）：${deg.reason}`,
              isCustom: Boolean(conn?.customModels?.includes(deg.model)),
            });
          }
          seenKeys.add(degKey);
        }
      }

      // 2. 置顶当前用途适用推荐
      for (const item of candidateMap.values()) {
        if (item.isRecommended && !seenKeys.has(item.key)) {
          items.push(item);
          seenKeys.add(item.key);
        }
      }

      // 3. 按连接分组展示其余完整候选列表
      for (const item of candidateMap.values()) {
        if (!seenKeys.has(item.key)) {
          items.push(item);
          seenKeys.add(item.key);
        }
      }
    } else if (currentKey && effective.connectionId && effective.model) {
      items.push({
        key: currentKey,
        connectionId: effective.connectionId,
        connectionName: effective.connectionName ?? effective.connectionId,
        modelId: effective.model,
        displayName: effective.model,
        isCurrent: true,
        isRecommended: false,
        isAvailable: effective.available !== false,
        ...(effective.unavailableReason ? { unavailableReason: effective.unavailableReason } : {}),
        isCustom: false,
      });
    }

    return {
      effective,
      items,
      hidden,
      config,
      credentials,
      catalog,
      sessionSelection: selectionResult.modelSelection,
      defaultRole,
    };
  }

  #filterItems(items: readonly CatalogListItem[], query: string): readonly CatalogListItem[] {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (item) =>
        item.modelId.toLowerCase().includes(q) ||
        item.displayName.toLowerCase().includes(q) ||
        item.connectionName.toLowerCase().includes(q) ||
        item.connectionId.toLowerCase().includes(q),
    );
  }

  async #modelActionFlow(
    conversationId: string,
    view: BuiltModelCatalogView,
    item: CatalogListItem,
    isCurrent: () => boolean,
  ): Promise<string | undefined> {
    const detailLines = buildModelDetailLines(item);
    const options: SelectionOption<string>[] = [
      {
        value: "use-session",
        label: "仅本会话使用",
        description: item.isAvailable
          ? "仅改当前对话主角色，不改变全局 main/light/power 用途默认"
          : `当前不可用：${item.unavailableReason ?? "请先在 /config 修复"}`,
        tone: "primary",
      },
      {
        value: "set-role-default",
        label: "设为用途默认（main / light / power）",
        description: `独立显式写入全局用途默认（默认聚焦 ${view.defaultRole}）`,
      },
      {
        value: "view-details",
        label: "查看完整规格与数据来源",
        description: "窗口容量、输入能力、参考价格与字段来源",
      },
    ];

    if (item.connection && !item.isCustom) {
      options.push({
        value: "hide-model",
        label: "隐藏此型号",
        description: "从列表隐藏此供应方型号（目录刷新不会复活，可在「已隐藏型号」恢复）",
      });
    }

    options.push({ value: "back", label: "返回列表" });

    for (;;) {
      if (!isCurrent()) return undefined;
      const picked = await chooseTerminalSelection(
        {
          id: "terminal-model-action",
          title: `${item.connectionName} · ${item.modelId}`,
          body: detailLines.slice(0, 8),
          options,
        },
        this.options.choose,
      );
      if (!isCurrent() || !picked || picked.kind === "cancelled" || picked.value === "back") {
        return undefined;
      }
      if (picked.value === "view-details") {
        await chooseTerminalSelection(
          {
            title: `规格与来源 · ${item.modelId}`,
            body: detailLines,
            options: [{ value: "back", label: "返回" }],
          },
          this.options.choose,
        );
        continue;
      }
      if (picked.value === "use-session") {
        if (!item.isAvailable) {
          return `⚠ 无法切换到 ${item.modelId}：${item.unavailableReason ?? "当前不可用，请打开 /config 修复"}`;
        }
        const targetControl = item.candidate?.fields.thinkingControl.value;
        const currentThinking = view.effective.params?.thinking;
        const compat = isThinkingCompatible(targetControl, currentThinking);
        let nextParams: ModelSelectionParams | undefined = view.effective.params;

        if (!compat.compatible) {
          const rebuilt = await this.#pickThinkingForModel(
            item.modelId,
            targetControl,
            undefined,
            `旧思考参数与 ${item.modelId} 不兼容（${compat.reason}），请为新型号选择合法参数或采用默认：`,
            isCurrent,
          );
          if (rebuilt === "cancelled") continue;
          nextParams = rebuilt ? { thinking: rebuilt } : undefined;
        }

        const sameEffectiveTarget =
          item.connectionId === view.effective.connectionId && item.modelId === view.effective.model;
        const preservedMaxOutput = sameEffectiveTarget
          ? view.effective.maxOutputPreference
          : undefined;
        const selection: SessionModelSelection = {
          mode: "override",
          connectionId: item.connectionId,
          model: item.modelId,
          ...(nextParams ? { params: nextParams } : {}),
          ...(preservedMaxOutput !== undefined ? { maxOutputPreference: preservedMaxOutput } : {}),
        };
        try {
          await this.options.conversation.setModelSelection(conversationId, selection);
          await this.options.onChanged();
          const paramNote = formatModelParamsSummary(nextParams, preservedMaxOutput);
          return `✓ 本会话已切换至 ${item.connectionName} · ${item.modelId}${paramNote ? `（${paramNote}）` : ""}（全局默认不变）。`;
        } catch (error) {
          return `⚠ 本会话切换被拒绝（已保留原选择）：${error instanceof Error ? error.message : String(error)}`;
        }
      }
      if (picked.value === "set-role-default") {
        if (!item.isAvailable) {
          return `⚠ 无法设为默认：${item.unavailableReason ?? "当前不可用，请打开 /config 修复"}`;
        }
        const roleChoice = await chooseTerminalSelection(
          {
            id: "terminal-model-role",
            title: `设为用途默认 · ${item.modelId}`,
            body: [
              `将 ${item.connectionName} · ${item.modelId} 写入以下用途默认：`,
              "此操作仅更新所选用途默认，不改写其他用途，也不修改连接地址或凭据。",
            ],
            initialValue: view.defaultRole,
            options: [
              ...ROLE_SPECS.map((spec) => ({
                value: spec.id,
                label: `${spec.labelZh}（${spec.id}）`,
                description:
                  spec.id === "main"
                    ? "普通主对话及默认兜底用途"
                    : spec.id === "light"
                      ? "摘要、蒸馏与轻推理辅助用途"
                      : "工作场景主对话用途",
              })),
              { value: "cancel", label: "取消" },
            ],
          },
          this.options.choose,
        );
        if (
          !isCurrent() ||
          !roleChoice ||
          roleChoice.kind === "cancelled" ||
          roleChoice.value === "cancel"
        ) {
          continue;
        }
        const role = roleChoice.value as RoleId;
        const targetControl = item.candidate?.fields.thinkingControl.value;
        const prevRoleThinking = view.effective.roles?.[role]?.params?.thinking;
        const compat = isThinkingCompatible(targetControl, prevRoleThinking);
        let nextParams: ModelSelectionParams | undefined = prevRoleThinking
          ? { thinking: prevRoleThinking }
          : undefined;
        if (!compat.compatible) {
          const rebuilt = await this.#pickThinkingForModel(
            item.modelId,
            targetControl,
            undefined,
            `原 ${role} 思考参数与 ${item.modelId} 不兼容（${compat.reason}），请重新选择：`,
            isCurrent,
          );
          if (rebuilt === "cancelled") continue;
          nextParams = rebuilt ? { thinking: rebuilt } : undefined;
        }
        const result = await this.options.saveModelConfiguration((cfg) => {
          const nextCfg = structuredClone(cfg);
          const raw = nextCfg.llm as unknown;
          if (!isLLMConfigV2(raw)) return nextCfg;
          const nextLlm = raw as {
            schemaVersion: 2;
            connections: Record<string, ModelConnectionConfig>;
            main?: LLMConfigV2["main"];
            light?: LLMConfigV2["light"];
            power?: LLMConfigV2["power"];
          };
          const prevRole = nextLlm[role];
          const preserveMaxOutput =
            prevRole?.connectionId === item.connectionId && prevRole.model === item.modelId
              ? prevRole.maxOutputPreference
              : undefined;
          nextLlm[role] = {
            connectionId: item.connectionId,
            model: item.modelId,
            ...(nextParams ? { params: nextParams } : {}),
            ...(preserveMaxOutput !== undefined ? { maxOutputPreference: preserveMaxOutput } : {}),
          };
          return nextCfg;
        });
        await this.options.onChanged();
        return describeConfigApplyResult(result, `用途默认 ${role}（${item.modelId}）`);
      }
      if (picked.value === "hide-model") {
        const result = await this.options.saveModelConfiguration((cfg) => {
          const nextCfg = structuredClone(cfg);
          const raw = nextCfg.llm as unknown;
          if (!isLLMConfigV2(raw)) return nextCfg;
          const conn = raw.connections[item.connectionId];
          if (!conn) return nextCfg;
          const hiddenList = [...(conn.hiddenModels ?? [])];
          if (!hiddenList.includes(item.modelId)) hiddenList.push(item.modelId);
          (raw.connections as Record<string, ModelConnectionConfig>)[item.connectionId] = {
            ...conn,
            hiddenModels: hiddenList,
          };
          return nextCfg;
        });
        await this.options.onChanged();
        return describeConfigApplyResult(
          result,
          `隐藏型号 ${item.modelId}（可在「已隐藏型号」恢复）`,
        );
      }
    }
  }

  async #tuneCurrentModelFlow(
    conversationId: string,
    view: BuiltModelCatalogView,
    isCurrent: () => boolean,
  ): Promise<string | undefined> {
    const connId = view.effective.connectionId;
    const modelId = view.effective.model;
    if (!connId || !modelId) return undefined;

    const currentItem = view.items.find((i) => i.key === makeModelKey(connId, modelId));
    const catalogInfo = view.catalog.getModelInfo(currentItem?.connection?.presetId, modelId);
    const control =
      currentItem?.candidate?.fields.thinkingControl.value ?? catalogInfo?.thinkingControl;
    const physicalMaxOutput =
      currentItem?.candidate?.fields.maxOutputTokens.value ?? catalogInfo?.maxOutputTokens;
    const recommendedMaxOutput = currentItem?.candidate?.recommendedMaxOutputTokens;
    const currentMaxOutput = view.effective.maxOutputPreference;

    const patch = await this.#pickTuneParameterForModel(
      modelId,
      control,
      view.effective.params?.thinking,
      currentMaxOutput,
      physicalMaxOutput,
      recommendedMaxOutput,
      `当前生效：${view.effective.connectionName ?? connId} · ${modelId}（${view.effective.sourceLabel ?? ""}）。仅修改你选中的那一项，未编辑字段自动保留：`,
      isCurrent,
    );
    if (patch === "cancelled" || !isCurrent()) return undefined;

    const resolveEffectiveSummary = (
      baseParams: ModelSelectionParams | undefined,
      baseMaxOutput: number | undefined,
    ): {
      readonly params?: ModelSelectionParams;
      readonly maxOutputPreference?: number;
      readonly summary: string;
    } => {
      let nextParams: ModelSelectionParams | undefined = baseParams ? { ...baseParams } : undefined;
      let nextMaxOutput: number | undefined = baseMaxOutput;
      if (patch.kind === "thinking") {
        if (patch.thinking) {
          nextParams = { ...(nextParams ?? {}), thinking: patch.thinking };
        } else if (nextParams) {
          const cloned = { ...nextParams };
          delete (cloned as { thinking?: ThinkingConfig }).thinking;
          nextParams = Object.keys(cloned).length > 0 ? cloned : undefined;
        }
      } else {
        nextMaxOutput = patch.maxOutputPreference;
      }
      return {
        ...(nextParams ? { params: nextParams } : {}),
        ...(nextMaxOutput !== undefined ? { maxOutputPreference: nextMaxOutput } : {}),
        summary: formatModelParamsSummary(nextParams, nextMaxOutput) ?? "默认参数",
      };
    };

    const previewMerged = resolveEffectiveSummary(view.effective.params, currentMaxOutput);
    const changeDescription =
      patch.kind === "thinking"
        ? `思考参数调整为：${formatModelParamsSummary(patch.thinking ? { thinking: patch.thinking } : undefined) ?? "采用默认（清除覆盖）"}${currentMaxOutput !== undefined ? `（保留原输出偏好 ${currentMaxOutput} tokens）` : ""}`
        : patch.maxOutputPreference !== undefined
          ? `输出偏好调整为：${patch.maxOutputPreference} tokens${view.effective.params?.thinking ? "（保留原思考参数）" : ""}`
          : `输出偏好已清除（恢复模型默认${view.effective.params?.thinking ? "，保留原思考参数" : ""}）`;

    const scopeChoice = await chooseTerminalSelection(
      {
        id: "terminal-model-tune-scope",
        title: `应用参数作用域 · ${modelId}`,
        body: [
          changeDescription,
          `生效后参数：${previewMerged.summary}`,
          "请明确选择参数生效作用域：",
        ],
        initialValue:
          view.effective.mode === "override"
            ? "session"
            : view.effective.degradedFrom
              ? "main"
              : view.defaultRole,
        options: [
          {
            value: "session",
            label: "仅本会话生效",
            description: "写入当前会话覆盖（不修改全局 main/light/power 默认）",
            tone: "primary",
          },
          {
            value: "main",
            label: "写入主模型默认（main）",
            description: "同步绑定为全局 main 默认并保留未编辑字段",
          },
          {
            value: "power",
            label: "写入强力模型默认（power）",
            description: "同步绑定为工作场景 power 默认并保留未编辑字段",
          },
          {
            value: "light",
            label: "写入轻量模型默认（light）",
            description: "同步绑定为轻量用途 light 默认并保留未编辑字段",
          },
          { value: "cancel", label: "取消" },
        ],
      },
      this.options.choose,
    );

    if (
      !isCurrent() ||
      !scopeChoice ||
      scopeChoice.kind === "cancelled" ||
      scopeChoice.value === "cancel"
    ) {
      return undefined;
    }

    if (scopeChoice.value === "session") {
      try {
        await this.options.conversation.setModelSelection(conversationId, {
          mode: "override",
          connectionId: connId,
          model: modelId,
          ...(previewMerged.params ? { params: previewMerged.params } : {}),
          ...(previewMerged.maxOutputPreference !== undefined
            ? { maxOutputPreference: previewMerged.maxOutputPreference }
            : {}),
        });
        await this.options.onChanged();
        return `✓ 本会话参数已更新：${modelId}（${previewMerged.summary}）。`;
      } catch (error) {
        return `⚠ 参数更新被拒绝：${error instanceof Error ? error.message : String(error)}`;
      }
    }

    const role = scopeChoice.value as RoleId;
    let savedSummary = previewMerged.summary;
    const result = await this.options.saveModelConfiguration((cfg) => {
      const nextCfg = structuredClone(cfg);
      const raw = nextCfg.llm as unknown;
      if (!isLLMConfigV2(raw)) return nextCfg;
      const nextLlm = raw as {
        schemaVersion: 2;
        connections: Record<string, ModelConnectionConfig>;
        main?: LLMConfigV2["main"];
        light?: LLMConfigV2["light"];
        power?: LLMConfigV2["power"];
      };
      const existingRole = nextLlm[role];
      const sameRoleTarget =
        existingRole?.connectionId === connId && existingRole.model === modelId;
      // 保留目标用途自身未被编辑的字段（如仅改思考时绝不丢掉已有 maxOutputPreference，也不把无关会话覆盖串写进全局用途）
      const mergedForRole = resolveEffectiveSummary(
        sameRoleTarget ? existingRole.params : view.effective.params,
        sameRoleTarget ? existingRole.maxOutputPreference : currentMaxOutput,
      );
      savedSummary = mergedForRole.summary;
      nextLlm[role] = {
        connectionId: connId,
        model: modelId,
        ...(mergedForRole.params ? { params: mergedForRole.params } : {}),
        ...(mergedForRole.maxOutputPreference !== undefined
          ? { maxOutputPreference: mergedForRole.maxOutputPreference }
          : {}),
      };
      return nextCfg;
    });
    await this.options.onChanged();
    return describeConfigApplyResult(result, `${role} 默认参数（${modelId} · ${savedSummary}）`);
  }

  async #pickTuneParameterForModel(
    modelId: string,
    control: ThinkingControl | undefined,
    currentThinking: ThinkingConfig | undefined,
    currentMaxOutput: number | undefined,
    physicalMaxOutput: number | undefined,
    recommendedMaxOutput: number | undefined,
    leadMessage: string,
    isCurrent: () => boolean,
  ): Promise<
    | { readonly kind: "thinking"; readonly thinking: ThinkingConfig | undefined }
    | { readonly kind: "max-output"; readonly maxOutputPreference: number | undefined }
    | "cancelled"
  > {
    const options: SelectionOption<string>[] = [
      {
        value: "default",
        label: "采用默认（不显式发送思考覆盖）",
        description: !currentThinking ? "当前已选" : "仅清除思考覆盖（保留输出偏好）",
      },
      {
        value: "off",
        label: "关闭思考（off）",
        description: currentThinking?.mode === "off" ? "当前已选" : "仅关闭思考（保留输出偏好）",
      },
    ];

    if (control?.type === "toggle") {
      options.push({
        value: "on",
        label: "开启思考（on）",
        description: currentThinking?.mode === "on" ? "当前已选" : "开启模型思考（保留输出偏好）",
      });
    } else if (control?.type === "effort") {
      options.push({
        value: "on",
        label: "开启（服务端默认强度）",
        description: currentThinking?.mode === "on" ? "当前已选" : undefined,
      });
      for (const effort of control.efforts) {
        options.push({
          value: `effort:${effort}`,
          label: `思考强度：${effort}`,
          description:
            [
              effort === control.default ? "官方默认档" : undefined,
              currentThinking?.mode === "effort" && currentThinking.effort === effort
                ? "当前已选"
                : undefined,
            ]
              .filter(Boolean)
              .join(" · ") || undefined,
        });
      }
    } else if (control?.type === "budget") {
      options.push({
        value: "on",
        label: "开启（服务端默认预算）",
        description: currentThinking?.mode === "on" ? "当前已选" : undefined,
      });
      options.push({
        value: "budget",
        label: "自定义思考预算（tokens）…",
        description: control.range
          ? `官方建议区间：${control.range[0]}–${control.range[1]} tokens${currentThinking?.mode === "budget" ? `（当前 ${currentThinking.budget}）` : ""}`
          : "输入正整数 token 预算",
        input: {
          placeholder: control.range
            ? `输入 ${control.range[0]}–${control.range[1]} 之间的整数`
            : "输入思考 token 预算（正整数）",
        },
      });
    }

    // 已注册语义 `output.maxTokensPreference`：请求级输出上限偏好（独立于物理 maxOutputTokens 规格覆盖）
    const outputHintParts: string[] = [];
    if (currentMaxOutput !== undefined) outputHintParts.push(`当前 ${currentMaxOutput} tokens`);
    if (physicalMaxOutput !== undefined) outputHintParts.push(`物理上限 ${physicalMaxOutput}`);
    if (recommendedMaxOutput !== undefined) outputHintParts.push(`参考建议 ${recommendedMaxOutput}`);
    options.push({
      value: "output:set",
      label: "设置输出偏好（tokens）…",
      description:
        outputHintParts.length > 0
          ? `${outputHintParts.join(" · ")} · 仅改请求输出偏好（保留思考参数）`
          : "输入正整数设置请求级输出上限偏好（不改物理规格，保留思考参数）",
      input: {
        placeholder:
          physicalMaxOutput !== undefined
            ? `输入 1–${physicalMaxOutput} 之间的正整数`
            : "输入请求输出上限偏好（正整数 tokens）",
      },
    });
    if (currentMaxOutput !== undefined) {
      options.push({
        value: "output:clear",
        label: "清除输出偏好（恢复模型默认）",
        description: `移除当前 ${currentMaxOutput} tokens 输出偏好（保留思考参数）`,
      });
    }

    options.push({ value: "cancel", label: "返回" });

    let errorNote: string | undefined;
    for (;;) {
      if (!isCurrent()) return "cancelled";
      const chosen = await chooseTerminalSelection(
        {
          id: "terminal-model-thinking",
          title: `参数调整 · ${modelId}`,
          body: [
            leadMessage,
            `思考控件形态：${formatThinkingControl(control)}`,
            `当前输出偏好：${currentMaxOutput !== undefined ? `${currentMaxOutput} tokens` : "未设置（使用模型默认）"}${physicalMaxOutput !== undefined ? `（物理上限 ${physicalMaxOutput} tokens）` : ""}`,
            ...(errorNote ? [`⚠ ${errorNote}`] : []),
          ],
          options,
          submitLabel: "确认数值",
        },
        this.options.choose,
      );
      if (!isCurrent() || !chosen || chosen.kind === "cancelled" || chosen.value === "cancel") {
        return "cancelled";
      }
      if (chosen.value === "default") return { kind: "thinking", thinking: undefined };
      if (chosen.value === "off") return { kind: "thinking", thinking: { mode: "off" } };
      if (chosen.value === "on") return { kind: "thinking", thinking: { mode: "on" } };
      if (chosen.value.startsWith("effort:")) {
        return {
          kind: "thinking",
          thinking: {
            mode: "effort",
            effort: chosen.value.slice("effort:".length) as Extract<
              ThinkingConfig,
              { mode: "effort" }
            >["effort"],
          },
        };
      }
      if (chosen.value === "budget") {
        const raw = ("input" in chosen ? chosen.input : "").trim();
        if (!/^\d+$/.test(raw)) {
          errorNote = "请输入有效的正整数 token 预算。";
          continue;
        }
        const budget = Number.parseInt(raw, 10);
        if (
          control?.type === "budget" &&
          control.range &&
          (budget < control.range[0] || budget > control.range[1])
        ) {
          errorNote = `预算 ${budget} 超出合法区间 ${control.range[0]}–${control.range[1]} tokens，请重新输入。`;
          continue;
        }
        return { kind: "thinking", thinking: { mode: "budget", budget } };
      }
      if (chosen.value === "output:clear") {
        return { kind: "max-output", maxOutputPreference: undefined };
      }
      if (chosen.value === "output:set") {
        const raw = ("input" in chosen ? chosen.input : "").trim();
        const check = validateMaxOutputPreferenceInput(raw, physicalMaxOutput);
        if (!check.valid || check.value === undefined) {
          errorNote = check.error ?? "请输入有效的正整数输出偏好。";
          continue;
        }
        return { kind: "max-output", maxOutputPreference: check.value };
      }
    }
  }

  async #pickThinkingForModel(
    modelId: string,
    control: ThinkingControl | undefined,
    current: ThinkingConfig | undefined,
    leadMessage: string,
    isCurrent: () => boolean,
  ): Promise<ThinkingConfig | undefined | "cancelled"> {
    const options: SelectionOption<string>[] = [
      {
        value: "default",
        label: "采用默认（不显式发送思考覆盖）",
        description: !current ? "当前已选" : "移除显式思考参数覆盖",
      },
      {
        value: "off",
        label: "关闭思考（off）",
        description: current?.mode === "off" ? "当前已选" : "显式关闭模型思考",
      },
    ];

    if (control?.type === "toggle") {
      options.push({
        value: "on",
        label: "开启思考（on）",
        description: current?.mode === "on" ? "当前已选" : "开启模型思考",
      });
    } else if (control?.type === "effort") {
      options.push({
        value: "on",
        label: "开启（服务端默认强度）",
        description: current?.mode === "on" ? "当前已选" : undefined,
      });
      for (const effort of control.efforts) {
        options.push({
          value: `effort:${effort}`,
          label: `思考强度：${effort}`,
          description: [
            effort === control.default ? "官方默认档" : undefined,
            current?.mode === "effort" && current.effort === effort ? "当前已选" : undefined,
          ]
            .filter(Boolean)
            .join(" · ") || undefined,
        });
      }
    } else if (control?.type === "budget") {
      options.push({
        value: "on",
        label: "开启（服务端默认预算）",
        description: current?.mode === "on" ? "当前已选" : undefined,
      });
      options.push({
        value: "budget",
        label: "自定义思考预算（tokens）…",
        description: control.range
          ? `官方建议区间：${control.range[0]}–${control.range[1]} tokens${current?.mode === "budget" ? `（当前 ${current.budget}）` : ""}`
          : "输入正整数 token 预算",
        input: {
          placeholder: control.range
            ? `输入 ${control.range[0]}–${control.range[1]} 之间的整数`
            : "输入思考 token 预算（正整数）",
        },
      });
    }

    options.push({ value: "cancel", label: "返回" });

    let errorNote: string | undefined;
    for (;;) {
      if (!isCurrent()) return "cancelled";
      const chosen = await chooseTerminalSelection(
        {
          id: "terminal-model-thinking",
          title: `参数调整 · ${modelId}`,
          body: [
            leadMessage,
            `控件形态：${formatThinkingControl(control)}`,
            ...(errorNote ? [`⚠ ${errorNote}`] : []),
          ],
          options,
          submitLabel: "确认预算",
        },
        this.options.choose,
      );
      if (!isCurrent() || !chosen || chosen.kind === "cancelled" || chosen.value === "cancel") {
        return "cancelled";
      }
      if (chosen.value === "default") return undefined;
      if (chosen.value === "off") return { mode: "off" };
      if (chosen.value === "on") return { mode: "on" };
      if (chosen.value.startsWith("effort:")) {
        return {
          mode: "effort",
          effort: chosen.value.slice("effort:".length) as Extract<
            ThinkingConfig,
            { mode: "effort" }
          >["effort"],
        };
      }
      if (chosen.value === "budget") {
        const raw = ("input" in chosen ? chosen.input : "").trim();
        if (!/^\d+$/.test(raw)) {
          errorNote = "请输入有效的正整数 token 预算。";
          continue;
        }
        const budget = Number.parseInt(raw, 10);
        if (
          control?.type === "budget" &&
          control.range &&
          (budget < control.range[0] || budget > control.range[1])
        ) {
          errorNote = `预算 ${budget} 超出合法区间 ${control.range[0]}–${control.range[1]} tokens，请重新输入。`;
          continue;
        }
        return { mode: "budget", budget };
      }
    }
  }

  async #hiddenModelsFlow(
    view: BuiltModelCatalogView,
    isCurrent: () => boolean,
  ): Promise<string | undefined> {
    let page = 0;
    let hiddenEntries = [...view.hidden];
    let lastNotice: string | undefined;

    for (;;) {
      if (!isCurrent()) return lastNotice;
      const totalPages = Math.max(1, Math.ceil(hiddenEntries.length / HIDDEN_PER_PAGE));
      if (page >= totalPages) page = totalPages - 1;
      const slice = hiddenEntries.slice(page * HIDDEN_PER_PAGE, (page + 1) * HIDDEN_PER_PAGE);

      const options: SelectionOption<string>[] = slice.map((entry) => ({
        value: `unhide:${entry.key}`,
        label: `恢复显示：[${entry.connectionName}] ${entry.modelId}`,
        description:
          entry.displayName !== entry.modelId
            ? `${entry.displayName} · 按 Enter 立即恢复`
            : "按 Enter 立即恢复到可选列表",
      }));
      if (page > 0) options.push({ value: "page:prev", label: "上一页", paging: "previous" });
      if (page + 1 < totalPages) options.push({ value: "page:next", label: "下一页", paging: "next" });
      options.push({ value: "back", label: "返回模型列表", dismiss: true });

      const chosen = await chooseTerminalSelection(
        {
          id: "terminal-model-hidden",
          title: `已隐藏型号（${hiddenEntries.length}）`,
          body: [
            hiddenEntries.length > 0
              ? "以下供应方型号已被您手动隐藏（目录刷新不会自动复活）；选中任意项即可一键恢复显示："
              : "当前已无隐藏型号。",
            ...(lastNotice ? [lastNotice] : []),
          ],
          options,
        },
        this.options.choose,
      );
      if (!isCurrent() || !chosen || chosen.kind === "cancelled" || chosen.value === "back") {
        return lastNotice;
      }
      if (chosen.value === "page:prev") {
        page = Math.max(0, page - 1);
        continue;
      }
      if (chosen.value === "page:next") {
        page = Math.min(totalPages - 1, page + 1);
        continue;
      }
      if (chosen.value.startsWith("unhide:")) {
        const key = chosen.value.slice("unhide:".length);
        const target = hiddenEntries.find((entry) => entry.key === key);
        if (!target) continue;
        const result = await this.options.saveModelConfiguration((cfg) => {
          const nextCfg = structuredClone(cfg);
          const raw = nextCfg.llm as unknown;
          if (!isLLMConfigV2(raw)) return nextCfg;
          const conn = raw.connections[target.connectionId];
          if (!conn?.hiddenModels?.length) return nextCfg;
          const nextHidden = conn.hiddenModels.filter((m) => m !== target.modelId);
          const updatedConn: ModelConnectionConfig = { ...conn };
          if (nextHidden.length > 0) {
            (updatedConn as { hiddenModels?: readonly string[] }).hiddenModels = nextHidden;
          } else {
            delete (updatedConn as { hiddenModels?: readonly string[] }).hiddenModels;
          }
          (raw.connections as Record<string, ModelConnectionConfig>)[target.connectionId] =
            updatedConn;
          return nextCfg;
        });
        await this.options.onChanged();
        hiddenEntries = hiddenEntries.filter((entry) => entry.key !== key);
        lastNotice = describeConfigApplyResult(result, `恢复显示 ${target.modelId}`);
        if (hiddenEntries.length === 0) return lastNotice;
      }
    }
  }
}
