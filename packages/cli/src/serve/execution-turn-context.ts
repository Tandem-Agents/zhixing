import type { ConversationDispatch, IngressContext } from "@zhixing-ai/core/contracts";
import { isProgramOrigin } from "@zhixing-ai/core/conversation";
import type { TurnContext } from "@zhixing-ai/core/types";
import { readAdvancementExecutionContext } from "@zhixing-ai/core/advancement/execution-context";
import { readWorksceneTaskContext } from "@zhixing-ai/core/workscene/application";

function sanitizeProgramOriginTurnOrigin(
  origin: NonNullable<IngressContext["turnOrigin"]>,
): NonNullable<IngressContext["turnOrigin"]> {
  const base = withoutRecoveredSurfaceCapabilities(origin);
  const filteredControls = base.enabledControls?.filter(
    (control) => control !== "propose_advancement",
  );
  if (filteredControls === undefined) return base;
  const { enabledControls: _dropped, ...withoutControls } = base;
  return filteredControls.length > 0
    ? { ...withoutControls, enabledControls: filteredControls }
    : withoutControls;
}

/**
 * 执行体的运行上下文（本地执行与远端指派工人同一规则）：turnId 与来源取指派里的耐久 ingress，
 * 重放、恢复或接入面执行的调用方不能替换（执行标记、启用的控制、发起者等）；调用方带了来源时，
 * 只能把界面能力 postTurnControl 从真降为假。指派投影里的委托与推进材料一并读出，带执行标记
 * 却没有可用材料时在这里失败，运行体不启动。
 */
export function executionTurnContext(
  work: Pick<ConversationDispatch, "ingress" | "controlContext">,
  caller?: TurnContext,
): TurnContext {
  const ingress = work.ingress;
  const { turnOrigin: callerOrigin, ...rest } = caller ?? {};
  const durable = ingress.turnOrigin;
  const programOrigin = isProgramOrigin(ingress);
  const reduced =
    programOrigin ||
    (durable?.surface?.capabilities?.postTurnControl === true &&
      callerOrigin !== undefined &&
      callerOrigin.surface?.capabilities?.postTurnControl !== true);
  const effectiveOrigin = durable
    ? programOrigin
      ? sanitizeProgramOriginTurnOrigin(durable)
      : reduced
        ? withoutRecoveredSurfaceCapabilities(durable)
        : durable
    : undefined;
  const requiredUserContext = programOrigin
    ? undefined
    : readAdvancementExecutionContext(work.controlContext, {
        turnId: ingress.ingressId,
        ...(effectiveOrigin ? { turnOrigin: effectiveOrigin } : {}),
      });
  return {
    ...rest,
    turnId: ingress.ingressId,
    ...(ingress.kind === "channel" ? { emissionTarget: ingress.replyTarget } : {}),
    ...(effectiveOrigin ? { turnOrigin: effectiveOrigin } : {}),
    worksceneTasks: readWorksceneTaskContext(work.controlContext),
    ...(requiredUserContext ? { requiredUserContext } : {}),
  };
}

/** 恢复与断开时的界面能力削减：只把 postTurnControl 从真降为假，其余来源字段不动。 */
export function withoutRecoveredSurfaceCapabilities(
  origin: NonNullable<IngressContext["turnOrigin"]>,
): NonNullable<IngressContext["turnOrigin"]> {
  if (origin.surface?.capabilities?.postTurnControl !== true) return origin;
  return {
    ...origin,
    surface: {
      ...origin.surface,
      capabilities: {
        ...origin.surface.capabilities,
        postTurnControl: false,
      },
    },
  };
}
