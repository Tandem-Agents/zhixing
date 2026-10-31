/**
 * 推进执行运行的必需材料：确认或降级后执行原任务的那次运行，所需的原任务、提议阶段补充与确认的契约，
 * 由宿主按执行意向冻结的身份裁决，随指派投影（controlContext）交给任意执行体。执行体只核对材料与本次
 * 运行耐久身份的绑定，不再读推进状态；缺失或不符就在输入准备时失败，模型与业务工具都不启动。
 */
import type { ImageSource } from "../types/messages.js";
import type { RequiredUserContext, TurnOrigin, TurnOriginAdvancementExecution } from "../types/tools.js";
import { renderAcceptanceConditions } from "./attribution.js";
import { renderAdvancementOriginalTask } from "./proposal-messages.js";
import type { AdvancementSession } from "./types.js";

/** 指派投影里推进材料的来源标识。 */
export const ADVANCEMENT_EXECUTION_CONTEXT_SOURCE = "advancement-execution";

/** 宿主对一次执行运行的裁决：可用时给出必需上下文，不可用时给出原因（执行体据此失败）。 */
export type AdvancementExecutionMaterial = Readonly<{
  turnId: string;
  binding: TurnOriginAdvancementExecution;
}> & (
  | Readonly<{ status: "ready"; context: readonly RequiredUserContext[] }>
  | Readonly<{ status: "unavailable"; reason: string }>
);

/** 执行运行缺少可用的推进材料，或材料与本次运行身份不符。 */
export class AdvancementExecutionInputError extends Error {
  constructor(message: string) {
    super(`推进执行运行缺少必需的原任务材料：${message}`);
    this.name = "AdvancementExecutionInputError";
  }
}

/**
 * 宿主侧裁决：会话按标记里的会话 id 精确取得；冻结的执行意向与本次运行的 turnId、模式、执行标记逐项一致，
 * 原任务、补充与契约都取自这同一会话——确认执行带该会话确认的契约，降级执行不带契约。
 */
export function adjudicateAdvancementExecution(
  session: AdvancementSession | null,
  binding: TurnOriginAdvancementExecution,
  turnId: string,
): AdvancementExecutionMaterial {
  const unavailable = (reason: string): AdvancementExecutionMaterial =>
    Object.freeze({ status: "unavailable", turnId, binding, reason });
  if (!session || session.id !== binding.sessionId) return unavailable(`推进会话 ${binding.sessionId} 不存在`);
  const admission = session.originalTaskAdmission;
  if (!admission) return unavailable(`推进会话 ${session.id} 没有执行意向`);
  if (admission.mode !== binding.mode) return unavailable(`执行意向的模式 ${admission.mode ?? "（无）"} 与标记的模式 ${binding.mode} 不符`);
  if (admission.intent.turnId !== turnId) return unavailable(`执行意向的 turnId ${admission.intent.turnId} 与本次运行的 turnId ${turnId} 不符`);
  if (!sameBinding(admission.intent.turnOrigin.advancementExecution, binding)) return unavailable("执行意向冻结的执行标记与本次运行的执行标记不符");
  const context: RequiredUserContext[] = [];
  if (binding.mode === "advancement") {
    if (!session.confirmedRubric) return unavailable(`推进会话 ${session.id} 没有已确认的契约`);
    context.push(Object.freeze({ text: renderAcceptanceConditions(session.confirmedRubric.content) }));
  }
  // 来自提议的会话，执行输入是推进控制消息，原任务与补充由材料给出；其余会话的执行输入本身就是原任务
  if (session.proposal) {
    const original = renderAdvancementOriginalTask(session.originalUserTask, session.proposal.supplements);
    context.push(Object.freeze({ text: original.text, images: Object.freeze([...original.images]) }));
  }
  return Object.freeze({ status: "ready", turnId, binding, context: Object.freeze(context) });
}

/** 材料编码为指派投影的一块。 */
export function advancementExecutionContextBlock(material: AdvancementExecutionMaterial): { source: string; block: string } {
  return { source: ADVANCEMENT_EXECUTION_CONTEXT_SOURCE, block: JSON.stringify(material) };
}

/**
 * 执行体侧读取：本次运行耐久来源不带执行标记时返回 undefined；带标记时必须有且只有一块、绑定与 turnId 一致、
 * 状态可用，否则抛出 AdvancementExecutionInputError。
 */
export function readAdvancementExecutionContext(
  controlContext: readonly { source: string; block: string }[],
  run: Readonly<{ turnId: string; turnOrigin?: TurnOrigin }>,
): readonly RequiredUserContext[] | undefined {
  const binding = run.turnOrigin?.advancementExecution;
  const blocks = controlContext.filter((item) => item.source === ADVANCEMENT_EXECUTION_CONTEXT_SOURCE);
  if (!binding) {
    if (blocks.length > 0) throw new AdvancementExecutionInputError("本次运行没有执行标记，却收到推进材料");
    return undefined;
  }
  if (blocks.length !== 1) throw new AdvancementExecutionInputError(blocks.length === 0 ? "指派里没有推进材料" : "指派里有多份推进材料");
  let material: unknown;
  try { material = JSON.parse(blocks[0]!.block); } catch { throw new AdvancementExecutionInputError("推进材料无法解析"); }
  if (!isRecord(material) || !isRecord(material.binding) || typeof material.turnId !== "string") {
    throw new AdvancementExecutionInputError("推进材料形状不合法");
  }
  if (material.turnId !== run.turnId || !sameBinding(material.binding as unknown as TurnOriginAdvancementExecution, binding)) {
    throw new AdvancementExecutionInputError("推进材料与本次运行的身份不符");
  }
  if (material.status === "unavailable") {
    throw new AdvancementExecutionInputError(typeof material.reason === "string" ? material.reason : "宿主裁决为不可用");
  }
  if (material.status !== "ready" || !Array.isArray(material.context) || !material.context.every(isRequiredUserContext)) {
    throw new AdvancementExecutionInputError("推进材料形状不合法");
  }
  return Object.freeze(material.context.map((item) => Object.freeze({ ...item })));
}

function sameBinding(left: TurnOriginAdvancementExecution | undefined, right: TurnOriginAdvancementExecution): boolean {
  return left?.sessionId === right.sessionId && left.mode === right.mode && left.draftId === right.draftId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isRequiredUserContext(value: unknown): value is RequiredUserContext {
  if (!isRecord(value) || typeof value.text !== "string") return false;
  return value.images === undefined || (Array.isArray(value.images) && value.images.every(isImageSource));
}

function isImageSource(value: unknown): value is ImageSource {
  if (!isRecord(value)) return false;
  return value.type === "base64"
    ? typeof value.mediaType === "string" && typeof value.data === "string"
    : value.type === "url" && typeof value.url === "string";
}
