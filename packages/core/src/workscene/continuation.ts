import type {
  PostTurnControlOutcome,
  WorksceneTaskHandoff,
} from "../types/agent-events.js";
import type { TurnOrigin } from "../types/tools.js";
import {
  parseConversationId,
  worksceneConversationId,
} from "../conversation/scope-id.js";
import { protocolDigest } from "../protocol/canonical.js";
import type { RunRecordAdvancementMetadata } from "../transcript/types.js";
import type { ConversationDispatch } from "../contracts/protocol.js";

/** The proposal is persisted with the successful source run, not in UI state. */
export interface WorksceneContinuationSource {
  readonly conversationId: string;
  readonly runId: string;
  readonly ingressId: string;
  readonly current: boolean;
  readonly state:
    | "committed"
    | "failed"
    | "expired"
    | "cancelled"
    | "uncertain"
    | "queued"
    | "dispatched"
    | "running"
    | "cancel-requested";
  readonly control?: PostTurnControlOutcome;
  readonly result: string;
  readonly origin?: TurnOrigin;
  readonly surfacePrincipal: string;
  readonly advancement?: RunRecordAdvancementMetadata;
  readonly advancementSessionId?: string;
}

export interface WorksceneContinuationPort {
  read(conversationId: string): Promise<readonly WorksceneContinuationSource[]>;
  inspect(
    conversationId: string,
    turnId: string,
  ): Promise<"missing" | "open" | "closed">;
  hasActiveAdvancement(conversationId: string): Promise<boolean>;
  enter(sceneId: string, requestId: string): Promise<void>;
  workspaceMatches(
    sceneId: string,
    workspace: { deviceId: string; bindingRef: string } | null,
  ): Promise<boolean>;
  cancelAdvancement(conversationId: string, sessionId: string): Promise<void>;
  admit(
    input: Readonly<{
      conversationId: string;
      turnId: string;
      input: string;
      origin: TurnOrigin;
      surfacePrincipal: string;
      advancement?: RunRecordAdvancementMetadata;
    }>,
  ): Promise<void | { rejected: string }>;
  cancel(conversationId: string, turnId: string): Promise<void>;
  stop?(
    conversationId: string,
    runId: string,
    requestId: string,
  ): Promise<void>;
}

export interface WorksceneTaskReference {
  readonly conversationId: string;
  readonly runId: string;
  readonly goal: string;
}

export function worksceneTaskContext(
  tasks: readonly WorksceneTaskReference[],
): { source: string; block: string }[] {
  return tasks.length
    ? [{ source: "workscene-tasks", block: JSON.stringify(tasks.slice(-64)) }]
    : [];
}

export function readWorksceneTaskContext(
  context: readonly { source: string; block: string }[],
): readonly WorksceneTaskReference[] {
  const block = context.find((item) => item.source === "workscene-tasks");
  if (!block) return [];
  const tasks = JSON.parse(block.block);
  if (
    !Array.isArray(tasks) ||
    tasks.length > 64 ||
    tasks.some(
      (task) =>
        !task ||
        Object.keys(task).sort().join(",") !== "conversationId,goal,runId" ||
        [task.conversationId, task.runId, task.goal].some(
          (value) => typeof value !== "string" || !value.trim(),
        ),
    )
  )
    throw new Error("Invalid workscene task context");
  return tasks;
}

/** Bind executor proposals to the task references and origin issued by the owner. */
export function validateWorksceneContinuationCommit(
  record: {
    postTurnControl?: PostTurnControlOutcome;
    worksceneContinuation?: TurnOrigin["worksceneContinuation"];
  },
  work: Pick<ConversationDispatch, "controlContext" | "ingress">,
): void {
  if (
    record.worksceneContinuation &&
    protocolDigest("WorksceneOrigin", 1, record.worksceneContinuation) !==
      protocolDigest(
        "WorksceneOrigin",
        1,
        work.ingress.turnOrigin?.worksceneContinuation ?? null,
      )
  ) {
    throw new Error(
      "Workscene result origin differs from its durable assignment",
    );
  }
  const issued = readWorksceneTaskContext(work.controlContext);
  for (const target of record.postTurnControl?.stops ?? []) {
    if (
      !issued.some(
        (task) =>
          task.conversationId === target.conversationId &&
          task.runId === target.runId,
      )
    )
      throw new Error(
        "Workscene stop target was not issued to this assignment",
      );
  }
}

/** Workscene-owned continuation; Conversation admission is the only consumption receipt. */
export class WorksceneContinuationApplication {
  private readonly pending = new Map<string, Promise<void>>();
  constructor(private readonly port: WorksceneContinuationPort) {}

  /** A read projection of existing run lineage; no independent task state is stored. */
  async tasks(
    conversationId: string,
  ): Promise<readonly WorksceneTaskReference[]> {
    return WorksceneContinuationApplication.tasks(
      this.port.read,
      conversationId,
    );
  }

  static async tasks(
    read: WorksceneContinuationPort["read"],
    conversationId: string,
  ): Promise<readonly WorksceneTaskReference[]> {
    const roots = new Map<string, WorksceneContinuationSource>();
    for (const source of await read(conversationId)) {
      let root = source;
      const seen = new Set<string>();
      while (root.origin?.worksceneContinuation) {
        const parent = root.origin.worksceneContinuation;
        const key = `${parent.conversationId}/${parent.runId}`;
        if (seen.has(key)) break;
        seen.add(key);
        const found = (await read(parent.conversationId)).find(
          (item) => item.runId === parent.runId,
        );
        if (!found) break;
        root = found;
      }
      if (root.control?.intent.handoff?.remaining.length)
        roots.set(`${root.conversationId}/${root.runId}`, root);
    }
    const tasks: WorksceneTaskReference[] = [];
    for (const root of roots.values()) {
      if (
        await WorksceneContinuationApplication.isPending(read, root, new Set())
      )
        tasks.push({
          conversationId: root.conversationId,
          runId: root.runId,
          goal: root.control!.intent.handoff!.goal,
        });
    }
    return tasks;
  }

  async stop(input: {
    conversationId: string;
    target: { conversationId: string; runId: string };
    requestId: string;
  }): Promise<void> {
    // Resolve related lineage even after a previous stop, so retries remain idempotent.
    const related = await this.port.read(input.conversationId);
    let authorized =
      input.conversationId === input.target.conversationId &&
      related.some(
        (item) =>
          item.runId === input.target.runId &&
          item.control?.intent.handoff?.remaining.length,
      );
    for (const source of related) {
      if (authorized) break;
      authorized = Boolean(
        await this.originalTask(
          source,
          input.target.conversationId,
          input.target.runId,
        ).then((root) => root?.runId === input.target.runId),
      );
    }
    if (!authorized) throw new Error("停止目标不属于当前对话的委托");
    if (!this.port.stop) throw new Error("委托停止入口未装配");
    await this.port.stop(
      input.target.conversationId,
      input.target.runId,
      input.requestId,
    );
    const root = (await this.port.read(input.target.conversationId)).find(
      (item) => item.runId === input.target.runId,
    );
    if (root?.advancementSessionId)
      await this.port.cancelAdvancement(
        root.conversationId,
        root.advancementSessionId,
      );
  }

  private static async isPending(
    read: WorksceneContinuationPort["read"],
    source: WorksceneContinuationSource,
    seen: Set<string>,
  ): Promise<boolean> {
    const key = `${source.conversationId}/${source.runId}`;
    if (
      seen.has(key) ||
      !source.current ||
      source.state === "cancelled" ||
      source.state === "cancel-requested"
    )
      return false;
    seen.add(key);
    if (["queued", "dispatched", "running", "uncertain"].includes(source.state))
      return true;
    const target = worksceneContinuationTarget(source);
    const returning = worksceneResultReturnTarget(
      source.origin,
      source.conversationId,
    );
    if (
      !hasPendingWorksceneTask({ postTurnControl: source.control }) &&
      !returning
    )
      return false;
    const candidates = new Set(
      [target, returning, source.conversationId].filter((id): id is string =>
        Boolean(id),
      ),
    );
    let found = false;
    for (const id of candidates) {
      for (const child of await read(id)) {
        const parent = child.origin?.worksceneContinuation;
        if (
          parent?.conversationId !== source.conversationId ||
          parent.runId !== source.runId
        )
          continue;
        found = true;
        if (
          await WorksceneContinuationApplication.isPending(
            read,
            child,
            new Set(seen),
          )
        )
          return true;
      }
    }
    return !found;
  }

  recover(conversationId: string): Promise<void> {
    const previous = this.pending.get(conversationId);
    if (previous) return previous;
    const task = this.consume(conversationId).finally(() => {
      if (this.pending.get(conversationId) === task)
        this.pending.delete(conversationId);
    });
    this.pending.set(conversationId, task);
    return task;
  }

  private async consume(conversationId: string): Promise<void> {
    for (const source of await this.port.read(conversationId)) {
      if (source.current && source.state === "committed") {
        for (const target of source.control?.stops ?? []) {
          await this.stop({
            conversationId,
            target,
            requestId: `stop:${worksceneContinuationTurnId(source)}:${target.runId}`,
          });
        }
      }
    }
    for (const source of await this.port.read(conversationId)) {
      if (source.control?.intent.kind === "stop_task") continue;
      const handoff = source.control?.intent.handoff;
      const parent = source.origin?.worksceneContinuation;
      if (
        [
          "queued",
          "dispatched",
          "running",
          "cancel-requested",
          "uncertain",
        ].includes(source.state)
      ) {
        if (!source.current)
          await this.port.cancel(source.conversationId, source.ingressId);
        continue;
      }
      if (source.state === "cancelled") {
        const original =
          parent &&
          (await this.originalTask(
            source,
            parent.returnConversationId ?? parent.conversationId,
          ));
        if (original?.advancementSessionId)
          await this.port.cancelAdvancement(
            original.conversationId,
            original.advancementSessionId,
          );
        continue;
      }
      if (
        (!handoff || handoff.remaining.length === 0) &&
        parent &&
        parent.kind !== "result"
      ) {
        const target = worksceneResultReturnTarget(
          source.origin,
          source.conversationId,
        );
        if (target) await this.returnResult(source, target, source.result);
        continue;
      }
      // Navigation never creates work. A completed task needs no additional model turn.
      if (!handoff || handoff.remaining.length === 0) continue;
      const target = worksceneContinuationTarget(source);
      const returnTarget =
        worksceneResultReturnTarget(source.origin, source.conversationId) ??
        source.conversationId;
      if (!target) {
        await this.returnResult(
          source,
          returnTarget,
          "交接目标与当前对话归属不匹配，未启动续接。请核对原任务与场景。",
        );
        continue;
      }
      const turnId = worksceneContinuationTurnId(source);
      const claim = await this.port.inspect(target, turnId);
      if (!source.current) {
        if (claim === "open") await this.port.cancel(target, turnId);
        continue;
      }
      if (claim !== "missing") continue;
      if (
        (await this.port.inspect(returnTarget, `${turnId}:result`)) !==
        "missing"
      )
        continue;
      if (source.control?.intent.kind === "enter") {
        try {
          if (await this.port.hasActiveAdvancement(target))
            throw new Error("目标场景已有独立验收中的任务，不能混入另一项委托");
          await this.port.enter(source.control.intent.sceneId, turnId);
        } catch (error) {
          await this.returnResult(
            source,
            returnTarget,
            `交接未能进入目标场景：${error instanceof Error ? error.message : String(error)}。原任务尚未完成。`,
          );
          continue;
        }
      }
      if (
        source.control?.intent.kind === "set_workdir" &&
        !(await this.port.workspaceMatches(
          source.control.intent.sceneId,
          source.control.intent.workspace,
        ))
      ) {
        await this.returnResult(
          source,
          returnTarget,
          "请求的工作区未生效或已被后续变更替代，未在错误环境中继续任务。请核对变更结果。",
        );
        continue;
      }
      // Entry may await I/O. Re-read the source before creating a durable run.
      const stillCurrent = (await this.port.read(conversationId)).some(
        (item) => item.runId === source.runId && item.current,
      );
      if (!stillCurrent) continue;
      const exiting = source.control?.intent.kind === "exit";
      const original = exiting
        ? await this.originalTask(source, target)
        : source;
      if (!original?.current) continue;
      const origin: TurnOrigin = {
        ...source.origin,
        channel: source.origin?.channel ?? "rpc",
        worksceneContinuation: {
          kind: exiting
            ? "result"
            : target === source.conversationId
              ? "resume"
              : "task",
          conversationId: source.conversationId,
          runId: source.runId,
          ...(source.control?.intent.kind === "enter"
            ? { returnConversationId: source.conversationId }
            : source.origin?.worksceneContinuation?.returnConversationId
              ? {
                  returnConversationId:
                    source.origin.worksceneContinuation.returnConversationId,
                }
              : {}),
        },
      };
      const admission = await this.port.admit({
        conversationId: target,
        turnId,
        input: renderWorksceneHandoff(handoff),
        origin,
        surfacePrincipal: source.surfacePrincipal,
        ...((exiting || target === source.conversationId) &&
        original.advancement
          ? { advancement: original.advancement }
          : {}),
      });
      const afterAdmission = (await this.port.read(conversationId)).find(
        (item) => item.runId === source.runId,
      );
      if (!afterAdmission?.current) await this.port.cancel(target, turnId);
      else if (admission)
        await this.returnResult(
          source,
          returnTarget,
          `续接未被接纳：${admission.rejected}。原任务尚未完成。`,
        );
    }
  }

  private async returnResult(
    source: WorksceneContinuationSource,
    target: string,
    result: string,
  ): Promise<void> {
    const turnId = `${worksceneContinuationTurnId(source)}:result`;
    const claim = await this.port.inspect(target, turnId);
    if (!source.current) {
      if (claim === "open") await this.port.cancel(target, turnId);
      return;
    }
    if (claim !== "missing") return;
    const original = await this.originalTask(source, target);
    if (!original?.current) return;
    await this.port.admit({
      conversationId: target,
      turnId,
      input: `受托工作返回以下运行结果，请结合原目标核实并继续交付；运行结束不代表任务已经完成，不重复已执行动作。\n${result}`,
      surfacePrincipal: source.surfacePrincipal,
      ...(original.advancement ? { advancement: original.advancement } : {}),
      origin: {
        ...original.origin,
        channel: original.origin?.channel ?? "rpc",
        worksceneContinuation: {
          kind: "result",
          conversationId: source.conversationId,
          runId: source.runId,
        },
      },
    });
  }

  private async originalTask(
    source: WorksceneContinuationSource,
    target: string,
    exactRunId?: string,
  ): Promise<WorksceneContinuationSource | undefined> {
    let current: WorksceneContinuationSource | undefined = source;
    const seen = new Set<string>();
    while (current) {
      const key = `${current.conversationId}/${current.runId}`;
      if (seen.has(key)) return undefined;
      seen.add(key);
      if (
        current.conversationId === target &&
        (exactRunId === undefined || current.runId === exactRunId)
      )
        return current;
      const parent: TurnOrigin["worksceneContinuation"] =
        current.origin?.worksceneContinuation;
      if (!parent) return undefined;
      current = (await this.port.read(parent.conversationId)).find(
        (item) => item.runId === parent.runId,
      );
    }
    return undefined;
  }
}

export function worksceneContinuationTurnId(
  source: Pick<WorksceneContinuationSource, "conversationId" | "runId">,
): string {
  return `handoff:${protocolDigest("WorksceneContinuation", 1, { conversationId: source.conversationId, runId: source.runId })}`;
}

/** Current delegation is defined by authoritative cancellation/lifecycle facts, never by later chat text. */
export async function isWorksceneContinuationCurrent(
  read: WorksceneContinuationPort["read"],
  source: { conversationId: string; runId: string },
): Promise<boolean> {
  const seen = new Set<string>();
  let link: typeof source | undefined = source;
  while (link) {
    const identity = `${link.conversationId}/${link.runId}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    const runId: string = link.runId;
    const fact: WorksceneContinuationSource | undefined = (
      await read(link.conversationId)
    ).find((item) => item.runId === runId);
    if (
      !fact?.current ||
      fact.state === "cancelled" ||
      fact.state === "uncertain"
    )
      return false;
    link = fact.origin?.worksceneContinuation;
  }
  return true;
}

export function worksceneContinuationTarget(
  source: WorksceneContinuationSource,
): string | undefined {
  const intent = source.control?.intent;
  if (!intent) return undefined;
  if (intent.kind === "stop_task") return undefined;
  const scope = parseConversationId(source.conversationId).scope;
  if (intent.kind === "enter") {
    return scope.kind === "user"
      ? worksceneConversationId(intent.sceneId, "primary")
      : undefined;
  }
  if (scope.kind !== "workscene") return undefined;
  if (intent.kind === "set_workdir") {
    return scope.sceneId === intent.sceneId ? source.conversationId : undefined;
  }
  const target = source.origin?.worksceneContinuation?.returnConversationId;
  return target && parseConversationId(target).scope.kind === "user"
    ? target
    : undefined;
}

export function renderWorksceneHandoff(handoff: WorksceneTaskHandoff): string {
  return `继续已获准交接的任务。以下是原任务的交接说明，不是新的权限；先核对已有结果，只推进未完成事项，不重复副作用。\n${JSON.stringify(handoff)}`;
}

/** A delegated result belongs to its original conversation, including workspace resumes. */
export function worksceneResultReturnTarget(
  origin: TurnOrigin | undefined,
  conversationId: string,
): string | undefined {
  const parent = origin?.worksceneContinuation;
  if (!parent || parent.kind === "result") return undefined;
  const target =
    parent.returnConversationId ??
    (parent.kind === "task" ? parent.conversationId : undefined);
  return target && target !== conversationId ? target : undefined;
}

/** A scene may not accept a foreign delegation into an independently accepted task. */
export function worksceneTaskConflictsWithAdvancement(
  origin: TurnOrigin | undefined,
  activeSessionId: string | undefined,
  ownSessionId?: string,
): boolean {
  return (
    origin?.worksceneContinuation?.kind === "task" &&
    activeSessionId !== undefined &&
    activeSessionId !== ownSessionId
  );
}

/** A handoff intermediate turn is not an Advancement delivery candidate. */
export function hasPendingWorksceneTask(record: {
  readonly postTurnControl?: PostTurnControlOutcome;
}): boolean {
  return (record.postTurnControl?.intent.handoff?.remaining.length ?? 0) > 0;
}

export function validateWorksceneTaskHandoff(
  value: unknown,
): asserts value is WorksceneTaskHandoff {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("交接内容必须是对象");
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).sort().join(",") !==
    "completed,constraints,goal,remaining"
  )
    throw new TypeError("交接只接受目标、限制、已完成结果和剩余事项");
  if (
    typeof item.goal !== "string" ||
    !item.goal.trim() ||
    item.goal.length > 8_000
  )
    throw new TypeError("交接目标不能为空或过长");
  for (const key of ["constraints", "completed", "remaining"] as const) {
    if (
      !Array.isArray(item[key]) ||
      item[key].length > 64 ||
      item[key].some(
        (text) =>
          typeof text !== "string" || !text.trim() || text.length > 8_000,
      )
    )
      throw new TypeError(`交接 ${key} 必须是有限的非空文本列表`);
  }
  if (JSON.stringify(item).length > 32_000)
    throw new TypeError("交接说明过长，请仅保留任务必需的获准材料");
}

export function validateWorksceneControl(
  value: unknown,
): asserts value is PostTurnControlOutcome {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Invalid workscene control");
  const outcome = value as Record<string, unknown>;
  if (
    Object.keys(outcome).some(
      (key) => key !== "intent" && key !== "conflict" && key !== "stops",
    )
  )
    throw new TypeError("Unknown workscene control field");
  const intent = outcome.intent as Record<string, unknown> | undefined;
  if (!intent || typeof intent !== "object" || Array.isArray(intent))
    throw new TypeError("Invalid workscene intent");
  const keys =
    intent.kind === "stop_task"
      ? ["kind", "conversationId", "runId"]
      : intent.kind === "enter"
        ? ["kind", "sceneId", "handoff"]
        : intent.kind === "exit"
          ? ["kind", "handoff"]
          : intent.kind === "set_workdir"
            ? ["kind", "sceneId", "workspace", "handoff"]
            : [];
  if (
    keys.length === 0 ||
    Object.keys(intent).some((key) => !keys.includes(key))
  )
    throw new TypeError("Invalid workscene intent kind/fields");
  if (
    intent.kind !== "exit" &&
    intent.kind !== "stop_task" &&
    (typeof intent.sceneId !== "string" ||
      !/^[a-zA-Z0-9_-]+$/.test(intent.sceneId))
  )
    throw new TypeError("Invalid workscene scene id");
  if (intent.kind === "set_workdir" && intent.workspace !== null) {
    const workspace = intent.workspace as Record<string, unknown> | undefined;
    if (
      !workspace ||
      Object.keys(workspace).sort().join(",") !== "bindingRef,deviceId" ||
      [workspace.deviceId, workspace.bindingRef].some(
        (id) => typeof id !== "string" || !id.trim(),
      )
    )
      throw new TypeError("Invalid workscene workspace");
  }
  if (intent.handoff !== undefined)
    validateWorksceneTaskHandoff(intent.handoff);
  const stops = outcome.stops;
  if (stops !== undefined) {
    if (!Array.isArray(stops) || stops.length > 64)
      throw new TypeError("Invalid workscene stops");
    for (const stop of stops) {
      if (
        !stop ||
        Object.keys(stop).sort().join(",") !== "conversationId,runId" ||
        [stop.conversationId, stop.runId].some(
          (id) => typeof id !== "string" || !id.trim(),
        )
      )
        throw new TypeError("Invalid workscene stop target");
    }
  }
  if (
    intent.kind === "stop_task" &&
    (!Array.isArray(stops) ||
      !stops.some(
        (stop) =>
          stop.conversationId === intent.conversationId &&
          stop.runId === intent.runId,
      ))
  )
    throw new TypeError("Stop intent requires its independent receipt");
  if (outcome.conflict !== undefined) {
    const conflict = outcome.conflict as Record<string, unknown>;
    if (
      !conflict ||
      Object.keys(conflict).join(",") !== "kindsSeen" ||
      !Array.isArray(conflict.kindsSeen) ||
      conflict.kindsSeen.length > 3 ||
      conflict.kindsSeen.some(
        (kind) => !["enter", "exit", "set_workdir"].includes(kind),
      )
    )
      throw new TypeError("Invalid workscene conflict");
  }
}
