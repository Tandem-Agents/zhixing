/**
 * 追加式发送视图投影与前缀代际状态（设计 §5.6）
 *
 * 仅供声明 `appendOnlyTurnContext === true` 的前缀敏感协议（如 `openai-responses`）使用：
 * - `state.messages` 仍是唯一事实链，绝不写入 `<turn-context>`；
 * - 锚定的 `<turn-context>` 与本次实时生成的尾段 `<turn-context>` 均以普通 `user` 角色消息
 *   进入发送视图（绝不提权写入 `developer` 或 `instructions`）；
 * - `project()` 严格无副作用纯读取，因此 `runTurnBegin` / `runTurnEnd` 反复调用不会重复叠加；
 * - 仅当模型调用真正产出助手消息进入 `state.messages` 时调用 `commitTurnContext()` 锚定；
 * - 压缩、窗口重建、冷重启、连接/协议或工具集变更时调用 `reset()` 开启新前缀代际并清空锚点表。
 */

import type { Message } from "../types/messages.js";
import { userMessage } from "../types/messages.js";

export interface AppendOnlyProjectionResult {
  readonly messagesForLLM: readonly Message[];
  /** 本次实时附加在尾部的临时上下文原文（null = 无活跃 provider，未追加空块）。 */
  readonly ephemeralTailText: string | null;
  /** 本次实时附加在尾部的临时上下文消息对象（用于锚点增量 token 估算）。 */
  readonly ephemeralTailMessage?: Message;
  /**
   * 针对给定的 `anchorBaselineMessageCount`，返回**仅在锚点之后**新出现的临时上下文消息列表
   * （已包含在锚点真值中的 `slot <= anchorBaselineMessageCount` 的旧 `C_0..` 绝不重复计入）。
   */
  readonly ephemeralMessagesAfterAnchor: (anchorBaselineMessageCount: number) => readonly Message[];
  /**
   * 将当前前缀代际起点映射到 `providerMessages`（含 `messagePrefix`）坐标的索引：
   * 小于该索引的已结算旧轮次推理载荷已知因前缀变化失效，适配层应诚实省略。
   */
  readonly invalidatedPrefixBeforeIndex: (messagePrefixLength: number) => number | undefined;
}

export class AppendOnlyTurnContextState {
  #generation = 1;
  #validFromStateIndex: number;
  /**
   * 键 = 被锚定的 `C_k` 紧邻其后的助手消息在 `state.messages` 中的索引（即调用前 `state.messages.length`）。
   * 值 = 当次实际送出的 `<turn-context>` 文本。
   */
  #anchoredByNextAssistantIndex = new Map<number, string>();
  /** 仅用于跨 run 复用时校验前序消息谱系未被外部替换（例如 /resume、/clear、切源）。 */
  #committedLineageLength = 0;
  /** 上轮存在跨轮不保留的瞬态发送项变化，需在下一 run 入口开启新代际。 */
  #pendingTransientReset = false;

  constructor(initialMessages: readonly Message[] = []) {
    // 若冷重启/新建实例时已带有既有历史助手消息，则旧内存态 C0 刻意未持久化，
    // 这些既有已结算轮次属于上一代前缀，当前新代际从现有历史之后诚实起步。
    const hasPriorAssistant = initialMessages.some((m) => m.role === "assistant");
    this.#validFromStateIndex = hasPriorAssistant ? initialMessages.length : 0;
    this.#committedLineageLength = initialMessages.length;
  }

  get generation(): number {
    return this.#generation;
  }

  get validFromStateIndex(): number {
    return this.#validFromStateIndex;
  }

  get anchoredCount(): number {
    return this.#anchoredByNextAssistantIndex.size;
  }

  /**
   * 标记存在仅作用于当次 run 的瞬态发送视图项变化，下一 `run` 入口须调用
   * `reset(loopMessages.length)` 开启新前缀代际。
   */
  markTransientSendViewChange(): void {
    this.#pendingTransientReset = true;
  }

  /**
   * 若存在待消费的瞬态发送视图变化，则在下一 `run` 入口推进代际并返回 true。
   */
  resetIfTransient(nextValidFromStateIndex = 0): boolean {
    if (!this.#pendingTransientReset) return false;
    this.reset(nextValidFromStateIndex);
    return true;
  }

  /**
   * 开启新前缀代际：清空旧内存临时上下文锚点表，记录新代际在 `state.messages` 中的起点。
   * 压缩、窗口重建、冷重启、协议/连接切换或工具集变更时调用。
   */
  reset(nextValidFromStateIndex = 0): void {
    this.#generation += 1;
    this.#anchoredByNextAssistantIndex.clear();
    this.#validFromStateIndex = Math.max(0, nextValidFromStateIndex);
    this.#committedLineageLength = this.#validFromStateIndex;
    this.#pendingTransientReset = false;
  }

  /**
   * 仅当一次模型调用真正产出助手消息进入 `state.messages`（位置 = `stateLengthBeforeAssistant`）时，
   * 将当次实际附尾的 `<turn-context>` 原文锚定到该槽位。
   */
  commitTurnContext(
    stateLengthBeforeAssistant: number,
    turnContextText: string | null,
  ): void {
    if (!turnContextText) return;
    if (stateLengthBeforeAssistant < this.#validFromStateIndex) return;
    this.#anchoredByNextAssistantIndex.set(stateLengthBeforeAssistant, turnContextText);
    this.#committedLineageLength = Math.max(
      this.#committedLineageLength,
      stateLengthBeforeAssistant + 1,
    );
  }

  /**
   * 无副作用纯读取：按当前已锚定的前序 `C_0..C_{k-1}` 叠加本次现取的 `liveTurnContext` 构造发送视图。
   * 反复调用不修改任何内部状态，不会重复叠加 `<turn-context>`。
   */
  project(
    stateMessages: readonly Message[],
    liveTurnContext: string | null,
  ): AppendOnlyProjectionResult {
    // 防御性只读检查：若传入消息短于已锚定最大槽位，说明调用方拿的是已被重写/截断的临时视图，
    // 仅应用落在该视图范围内的锚点，绝不在 project() 中产生写副作用。
    const projected: Message[] = [];
    const anchoredEntries: Array<{ readonly stateSlot: number; readonly message: Message }> = [];
    let validStartProjectedIndex: number | undefined =
      this.#validFromStateIndex > 0 ? 0 : undefined;

    for (let i = 0; i < stateMessages.length; i++) {
      const anchored = this.#anchoredByNextAssistantIndex.get(i);
      if (anchored !== undefined && i >= this.#validFromStateIndex) {
        const msg = userMessage(anchored);
        projected.push(msg);
        anchoredEntries.push({ stateSlot: i, message: msg });
      }
      if (this.#validFromStateIndex > 0 && i === this.#validFromStateIndex) {
        validStartProjectedIndex = projected.length;
      }
      projected.push(stateMessages[i]!);
    }

    if (
      this.#validFromStateIndex > 0 &&
      this.#validFromStateIndex >= stateMessages.length
    ) {
      validStartProjectedIndex = projected.length;
    }

    // 若 tail 尚未有已锚定槽位且 liveTurnContext 非空，则作为普通 user 消息追加到尾部
    const tailMessage = liveTurnContext ? userMessage(liveTurnContext) : undefined;
    if (tailMessage) {
      projected.push(tailMessage);
    }

    return {
      messagesForLLM: projected,
      ephemeralTailText: liveTurnContext,
      ...(tailMessage ? { ephemeralTailMessage: tailMessage } : {}),
      ephemeralMessagesAfterAnchor: (anchorBaselineMessageCount: number): readonly Message[] => {
        const extra: Message[] = [];
        // anchorBaselineMessageCount 是写入真值锚点那次调用前的 state.messages.length：
        // 该次调用的 C_k（槽位 == anchorBaselineMessageCount）已完整计入 anchor.totalInputTokens，
        // 故仅累加槽位严格大于 anchorBaselineMessageCount 的后续新锚定上下文 + 当前未锚定尾部 live C。
        for (const entry of anchoredEntries) {
          if (entry.stateSlot > anchorBaselineMessageCount) {
            extra.push(entry.message);
          }
        }
        if (tailMessage) {
          // 仅当 stateMessages 已推进到锚点之后（或锚点尚未覆盖当前末尾实时上下文）才计入新尾部；
          // 若仍在同一锚点点位重复快照（stateMessages.length === anchorBaselineMessageCount），
          // 当前 C_0 已含在锚点中，不重复计入。
          if (stateMessages.length > anchorBaselineMessageCount) {
            extra.push(tailMessage);
          }
        }
        return extra;
      },
      invalidatedPrefixBeforeIndex: (messagePrefixLength: number): number | undefined => {
        if (validStartProjectedIndex === undefined || validStartProjectedIndex <= 0) {
          return undefined;
        }
        return messagePrefixLength + validStartProjectedIndex;
      },
    };
  }
}

export function createAppendOnlyTurnContextState(
  initialMessages: readonly Message[] = [],
): AppendOnlyTurnContextState {
  return new AppendOnlyTurnContextState(initialMessages);
}
