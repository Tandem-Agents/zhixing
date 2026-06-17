import type { WorkflowDecisionRecord, WorkflowInstance } from "@zhixing/core";
import {
  CoreHostConnection,
  defaultCoreHostConnectionDeps,
  type CoreHostLink,
} from "../runtime/core-host-connection.js";
import { createStdoutWriter } from "../screen/index.js";
import { RpcReliableWorkFacade } from "./facade.js";
import {
  formatMissingWork,
  formatWorkSnapshot,
  formatWorkStarted,
} from "./format.js";

export type WorkCommandInput =
  | {
      readonly kind: "start";
      readonly goal: string;
      readonly context?: string;
      readonly watch?: boolean;
    }
  | {
      readonly kind: "status";
      readonly instanceId: string;
      readonly watch?: boolean;
    }
  | {
      readonly kind: "decide";
      readonly instanceId: string;
      readonly optionId: string;
      readonly decisionId?: string;
      readonly rationale?: string;
      readonly watch?: boolean;
    }
  | {
      readonly kind: "resume";
      readonly instanceId: string;
      readonly watch?: boolean;
    }
  | {
      readonly kind: "cancel";
      readonly instanceId: string;
      readonly reason?: string;
    };

export type WorkCommandExitCode = 0 | 1 | 2;

export interface WorkCommandDeps {
  readonly link?: CoreHostLink;
  readonly write?: (text: string) => void;
  readonly error?: (text: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly pollIntervalMs?: number;
  readonly maxWatchPolls?: number;
}

export async function runWorkCommand(
  input: WorkCommandInput,
  deps: WorkCommandDeps = {},
): Promise<WorkCommandExitCode> {
  const stdoutWriter = createStdoutWriter();
  const stderrWriter = createStdoutWriter({ stdout: process.stderr });
  const write = deps.write ?? ((text) => stdoutWriter.line(text));
  const error = deps.error ?? ((text) => stderrWriter.line(text));
  const owned = deps.link
    ? null
    : new CoreHostConnection(defaultCoreHostConnectionDeps());
  const facade = new RpcReliableWorkFacade(deps.link ?? owned!);

  try {
    switch (input.kind) {
      case "start":
        return await startWork(input, facade, { ...deps, write, error });
      case "status":
        return await showStatus(input, facade, { ...deps, write, error });
      case "decide":
        return await decideWork(input, facade, { ...deps, write, error });
      case "resume":
        return await resumeWork(input, facade, { ...deps, write, error });
      case "cancel":
        await facade.cancel(input.instanceId, input.reason);
        write(`复杂任务已取消: ${input.instanceId}`);
        return 0;
    }
    return 1;
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    await owned?.dispose();
  }
}

async function startWork(
  input: Extract<WorkCommandInput, { kind: "start" }>,
  facade: RpcReliableWorkFacade,
  deps: RequiredPick<WorkCommandDeps, "write" | "error"> & WorkCommandDeps,
): Promise<WorkCommandExitCode> {
  const goal = input.goal.trim();
  if (!goal) {
    deps.error("复杂任务目标不能为空");
    return 2;
  }
  const instance = await facade.start({
    goal,
    ...(input.context !== undefined ? { context: input.context } : {}),
  });
  if (input.watch) {
    return watchWork(instance.instanceId, facade, deps, instance);
  }
  deps.write(formatWorkStarted(instance));
  return 0;
}

async function showStatus(
  input: Extract<WorkCommandInput, { kind: "status" }>,
  facade: RpcReliableWorkFacade,
  deps: RequiredPick<WorkCommandDeps, "write" | "error"> & WorkCommandDeps,
): Promise<WorkCommandExitCode> {
  if (input.watch) {
    return watchWork(input.instanceId, facade, deps);
  }
  const instance = await facade.get(input.instanceId);
  if (!instance) {
    deps.error(formatMissingWork(input.instanceId));
    return 1;
  }
  deps.write(formatWorkSnapshot(instance));
  return 0;
}

async function decideWork(
  input: Extract<WorkCommandInput, { kind: "decide" }>,
  facade: RpcReliableWorkFacade,
  deps: RequiredPick<WorkCommandDeps, "write" | "error"> & WorkCommandDeps,
): Promise<WorkCommandExitCode> {
  const instance = await facade.get(input.instanceId);
  if (!instance) {
    deps.error(formatMissingWork(input.instanceId));
    return 1;
  }
  const decision = selectPendingDecision(instance, input.decisionId);
  if (decision.kind === "error") {
    deps.error(decision.message);
    return 1;
  }

  const next = await facade.decide({
    instanceId: input.instanceId,
    decisionId: decision.record.decisionId,
    optionId: input.optionId,
    ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
  });
  if (input.watch) {
    return watchWork(input.instanceId, facade, deps, next);
  }
  deps.write(["裁决已提交", formatWorkSnapshot(next)].join("\n\n"));
  return 0;
}

async function resumeWork(
  input: Extract<WorkCommandInput, { kind: "resume" }>,
  facade: RpcReliableWorkFacade,
  deps: RequiredPick<WorkCommandDeps, "write" | "error"> & WorkCommandDeps,
): Promise<WorkCommandExitCode> {
  const instance = await facade.resume(input.instanceId);
  if (input.watch) {
    return watchWork(input.instanceId, facade, deps, instance);
  }
  deps.write(["复杂任务已恢复", formatWorkSnapshot(instance)].join("\n\n"));
  return 0;
}

async function watchWork(
  instanceId: string,
  facade: RpcReliableWorkFacade,
  deps: RequiredPick<WorkCommandDeps, "write" | "error"> & WorkCommandDeps,
  initial?: WorkflowInstance,
): Promise<WorkCommandExitCode> {
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollIntervalMs = deps.pollIntervalMs ?? 2_000;
  let rendered: string | null = null;
  let snapshot = initial;
  let polls = 0;

  for (;;) {
    snapshot = snapshot ?? (await facade.get(instanceId) ?? undefined);
    if (!snapshot) {
      deps.error(formatMissingWork(instanceId));
      return 1;
    }

    const nextRender = formatWorkSnapshot(snapshot);
    if (nextRender !== rendered) {
      deps.write(nextRender);
      rendered = nextRender;
    }
    if (isWatchStopStatus(snapshot.status)) return 0;

    polls += 1;
    if (deps.maxWatchPolls !== undefined && polls >= deps.maxWatchPolls) {
      return 0;
    }
    snapshot = undefined;
    await sleep(pollIntervalMs);
  }
}

function selectPendingDecision(
  instance: WorkflowInstance,
  decisionId: string | undefined,
):
  | { readonly kind: "ok"; readonly record: WorkflowDecisionRecord }
  | { readonly kind: "error"; readonly message: string } {
  const pending = instance.decisions.filter((decision) => !decision.resolvedAt);
  if (decisionId) {
    const record = pending.find((decision) => decision.decisionId === decisionId);
    return record
      ? { kind: "ok", record }
      : { kind: "error", message: `未找到待裁决项: ${decisionId}` };
  }
  if (pending.length === 0) {
    return { kind: "error", message: "当前没有待裁决项" };
  }
  if (pending.length > 1) {
    return { kind: "error", message: "存在多个待裁决项，请用 --decision 指定" };
  }
  return { kind: "ok", record: pending[0]! };
}

function isWatchStopStatus(status: WorkflowInstance["status"]): boolean {
  return status === "waiting_decision" ||
    status === "succeeded" ||
    status === "failed" ||
    status === "canceled";
}

type RequiredPick<T, K extends keyof T> = T & {
  readonly [P in K]-?: NonNullable<T[P]>;
};
