/**
 * 段切换的覆盖规划 —— 纯函数。
 *
 * 一次切段要回答三件事：移除哪些消息、保留哪些消息、窗口（owner）该折叠几个已接受配对。
 * 运行体的工作消息与 owner 的注意力窗口必须对同一份覆盖达成一致，所以覆盖按结构单元计算：
 *
 *   [首部] [已接受配对 P_1..P_k] [运行部分：输入与步骤]
 *
 *   - 首部：窗口首条目（启动装填、摘要或截断说明，固定两条），身份只来自窗口写出的
 *     windowHead 结构标记（见 createSegmentLedger），正文写什么都不影响判定；
 *   - 已接受配对：首部之后、运行起点之前，每两条一组（用户原文 + 最终回复）；
 *   - 运行部分：本次运行的消息。不含 tool_result 的 user 消息是输入（本次请求及运行中
 *     追加的要求），一律钉在原位置保留；assistant 连同紧随的 tool_result 消息是一个步骤，
 *     工具调用与结果不拆开。
 *
 * 规则：在 [配对…, 步骤…] 上保留末尾 bufferUnits 个单元，之前的全部移除；只要有移除，
 * 首部一并移除（由新首部取代）。没有可移除的单元时，首部承载内容且不是本 run 刚产生的
 * 才单独替换首部（例如启动装填加一对时压缩装填），否则无事可做。
 */

import type { Message, WindowHeadKind } from "../../types/messages.js";

/** 运行内压缩台账 —— 每个 run（或每次手动压缩）一份，随消息一起传递。 */
export interface SegmentLedger {
  /** 首部条目类别；undefined = 没有首部（首部固定两条：说明 + 回执） */
  readonly head: WindowHeadKind | undefined;
  /** 首部由本 run 的切段产生：这种首部不单独再摘要，避免每轮反复摘要同一份新摘要 */
  readonly headFresh: boolean;
  /** 运行部分起点：之前是首部与已接受配对，从这里起是本次运行的输入与步骤 */
  readonly runStart: number;
  /** 本 run 累计实际移除的已接受配对数 —— 窗口折叠的依据（累计值，最后一次即总数） */
  readonly coveredPairs: number;
}

/**
 * 由运行输入建台账。首部只认起始两条：都带同一 windowHead 标记且为 user→assistant；
 * 其他位置的同名字段一律忽略（窗口写出时已剔除，这里不再信任）。
 */
export function createSegmentLedger(
  messages: readonly Message[],
  runStart: number,
): SegmentLedger {
  const first = messages[0];
  const second = messages[1];
  const head =
    first?.windowHead !== undefined &&
    first.role === "user" &&
    second?.role === "assistant" &&
    second.windowHead === first.windowHead &&
    runStart >= 2
      ? first.windowHead
      : undefined;
  return {
    head,
    headFresh: false,
    runStart: Math.max(0, Math.min(runStart, messages.length)),
    coveredPairs: 0,
  };
}

/** 去掉消息上的首部标记 —— 窗口只给首部条目写标记，配对与运行消息都不应带它。 */
export function stripWindowHead(message: Message): Message {
  if (message.windowHead === undefined) return message;
  const { windowHead: _ignored, ...rest } = message;
  return rest;
}

export interface SegmentCoverage {
  /** 本次是否移除（替换）首部 */
  readonly coverHead: boolean;
  /** 本次移除的已接受配对数 */
  readonly coveredPairs: number;
  /** 本次移除的运行步骤数 */
  readonly coveredSteps: number;
  /** 本次移除的消息（首部、配对、步骤，按原顺序） */
  readonly covered: readonly Message[];
  /** 新首部之后保留的消息：剩余配对 + 运行部分（去掉被移除的步骤，输入原位保留） */
  readonly kept: readonly Message[];
  /** 保留下来的已接受配对数 */
  readonly keptPairs: number;
}

export type SegmentCoveragePlan =
  | { readonly kind: "cover"; readonly coverage: SegmentCoverage }
  | { readonly kind: "nothing" }
  | { readonly kind: "invalid"; readonly reason: string };

/** 结构不符时的统一说明：本次不切，原消息原样继续。 */
export const SEGMENT_STRUCTURE_INVALID = "上下文结构与预期不符，本次未压缩";

export function planSegmentCoverage(
  messages: readonly Message[],
  ledger: SegmentLedger,
  bufferUnits: number,
): SegmentCoveragePlan {
  const headLength = ledger.head ? 2 : 0;
  const { runStart } = ledger;
  if (
    runStart < headLength ||
    runStart > messages.length ||
    (runStart - headLength) % 2 !== 0
  ) {
    return { kind: "invalid", reason: SEGMENT_STRUCTURE_INVALID };
  }
  if (
    ledger.head &&
    (messages[0]?.role !== "user" || messages[1]?.role !== "assistant")
  ) {
    return { kind: "invalid", reason: SEGMENT_STRUCTURE_INVALID };
  }
  const pairCount = (runStart - headLength) / 2;
  for (let i = headLength; i < runStart; i += 2) {
    const user = messages[i]!;
    const reply = messages[i + 1]!;
    if (user.role !== "user" || hasToolResult(user) || reply.role !== "assistant") {
      return { kind: "invalid", reason: SEGMENT_STRUCTURE_INVALID };
    }
  }

  // 运行部分：步骤 = assistant + 紧随的 tool_result 消息；输入钉住不进步骤
  const steps: { start: number; end: number }[] = [];
  let open: { start: number; end: number } | undefined;
  for (let i = runStart; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role === "assistant") {
      open = { start: i, end: i + 1 };
      steps.push(open);
    } else if (hasToolResult(message)) {
      if (!open || open.end !== i) {
        return { kind: "invalid", reason: SEGMENT_STRUCTURE_INVALID };
      }
      open.end = i + 1;
    } else {
      open = undefined;
    }
  }

  const coverable = pairCount + steps.length - Math.max(0, bufferUnits);
  if (coverable <= 0) {
    // 只替换首部的前提：首部承载内容（启动装填或摘要）且不是本 run 刚产生的。
    // 截断说明不承载对话内容，换成新的说明或摘要都换不出空间，只会多一次摘要调用。
    if (!ledger.head || ledger.headFresh || ledger.head === "note") return { kind: "nothing" };
    return {
      kind: "cover",
      coverage: {
        coverHead: true,
        coveredPairs: 0,
        coveredSteps: 0,
        covered: messages.slice(0, headLength),
        kept: messages.slice(headLength),
        keptPairs: pairCount,
      },
    };
  }

  const coveredPairs = Math.min(coverable, pairCount);
  const coveredSteps = coverable - coveredPairs;
  const removedStep = new Set<number>();
  for (const step of steps.slice(0, coveredSteps)) {
    for (let i = step.start; i < step.end; i++) removedStep.add(i);
  }
  const pairEnd = headLength + coveredPairs * 2;
  const covered = [
    ...messages.slice(0, pairEnd),
    ...messages.slice(runStart).filter((_, offset) => removedStep.has(runStart + offset)),
  ];
  const kept = [
    ...messages.slice(pairEnd, runStart),
    ...messages.slice(runStart).filter((_, offset) => !removedStep.has(runStart + offset)),
  ];
  return {
    kind: "cover",
    coverage: {
      coverHead: headLength > 0,
      coveredPairs,
      coveredSteps,
      covered,
      kept,
      keptPairs: pairCount - coveredPairs,
    },
  };
}

/** 切段完成后的新台账：新首部占两条，保留的配对仍是原生配对，累计移除数单调增加。 */
export function advanceSegmentLedger(
  ledger: SegmentLedger,
  coverage: SegmentCoverage,
  head: WindowHeadKind,
): SegmentLedger {
  return {
    head,
    headFresh: true,
    runStart: 2 + coverage.keptPairs * 2,
    coveredPairs: ledger.coveredPairs + coverage.coveredPairs,
  };
}

/**
 * 应急地板这一次移除了什么 —— 给模型的截断说明与给用户的提示由同一组事实生成。
 *   - droppedTurns：移除的已接受配对数（一问一答为一轮）
 *   - droppedRunSteps：移除的本次运行步骤数（只在运行中可能非零）
 *   - priorContext：首部的处置。removed = 移除了承载内容的首部（启动装填或摘要）；
 *     already-truncated = 替换的是先前的截断说明（不是新的内容损失）；none = 没有首部
 */
export interface EmergencyFloorFacts {
  readonly droppedTurns: number;
  readonly droppedRunSteps: number;
  readonly priorContext: EmergencyFloorPriorContext;
}

export type EmergencyFloorPriorContext = "none" | "removed" | "already-truncated";

export function emergencyFloorFacts(
  ledger: SegmentLedger,
  coverage: SegmentCoverage,
): EmergencyFloorFacts {
  return {
    droppedTurns: coverage.coveredPairs,
    droppedRunSteps: coverage.coveredSteps,
    priorContext: !coverage.coverHead || !ledger.head
      ? "none"
      : ledger.head === "context"
        ? "removed"
        : "already-truncated",
  };
}

/** 给模型的截断说明（运行体新首部与 owner 窗口折叠用同一段文本）。 */
export function describeEmergencyFloor(facts: EmergencyFloorFacts): string {
  const removed: string[] = [];
  if (facts.droppedTurns > 0) removed.push(`较早的 ${facts.droppedTurns} 轮对话`);
  if (facts.priorContext === "removed") removed.push("此前的摘要或恢复内容");
  if (facts.droppedRunSteps > 0) {
    removed.push(`本次请求中较早的 ${facts.droppedRunSteps} 个执行步骤`);
  }
  const statements: string[] = [];
  if (removed.length > 0) statements.push(`${removed.join("、")}已从上下文移除`);
  if (facts.priorContext === "already-truncated") statements.push("更早的对话此前已被截断");
  if (statements.length === 0) statements.push("没有移除新的内容");
  return `因上下文超限且摘要生成失败，${statements.join("；")}；完整原文保存在对话历史中。`;
}

function hasToolResult(message: Message): boolean {
  return message.content.some((block) => block.type === "tool_result");
}
