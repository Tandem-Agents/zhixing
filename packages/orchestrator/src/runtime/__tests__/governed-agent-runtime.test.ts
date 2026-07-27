import { describe, expect, it, vi } from "vitest";
import type {
  DeviceCapacityArbiterPort,
  DeviceCapacityBudget,
} from "@zhixing/core/resources";
import type { ToolDefinition, ToolExecutionContext } from "@zhixing/core";
import {
  governToolExecution,
  type AgentRuntimeCapacityBinding,
} from "../governed-agent-runtime.js";

const BUDGET: DeviceCapacityBudget = {
  occupancy: {
    memoryReservationBytes: 1,
    temporaryBytes: 0,
    slots: 1,
  },
  quantum: { readBytes: 0, writeBytes: 0, ioOperations: 0 },
};

function grantingArbiter(): {
  readonly arbiter: DeviceCapacityArbiterPort;
  readonly acquire: ReturnType<typeof vi.fn>;
  readonly release: ReturnType<typeof vi.fn>;
  readonly stepComplete: ReturnType<typeof vi.fn>;
} {
  const release = vi.fn();
  const stepComplete = vi.fn();
  const acquire = vi.fn(async () => ({
    kind: "granted" as const,
    permit: {
      granted: BUDGET,
      tryBegin: () => ({ claim: vi.fn(), complete: stepComplete }),
      release,
    },
  }));
  return {
    arbiter: { acquire, snapshot: vi.fn() } as unknown as
      DeviceCapacityArbiterPort,
    acquire,
    release,
    stepComplete,
  };
}

function binding(
  arbiter: DeviceCapacityArbiterPort,
): AgentRuntimeCapacityBinding {
  return {
    arbiter,
    serviceClass: "workload-interactive",
    atomic: BUDGET,
    preferred: BUDGET,
    maxWaitMs: 5_000,
  };
}

const TOOL = { name: "Read" } as unknown as ToolDefinition;
const CONTEXT = {} as unknown as ToolExecutionContext;

describe("governToolExecution", () => {
  it("holds a permit for exactly the tool execution and releases it after", async () => {
    const { arbiter, acquire, release, stepComplete } = grantingArbiter();
    let finish!: (value: { ok: true }) => void;
    const execute = vi.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          finish = resolve;
        }),
    );
    const governed = governToolExecution(
      execute as never,
      binding(arbiter),
    );

    const result = governed(TOOL, {}, CONTEXT);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    // 工具还在跑,容量不得提前归还:那会让别的申请者以为槽位空闲。
    expect(release).not.toHaveBeenCalled();

    finish({ ok: true });
    await result;
    expect(stepComplete).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(acquire).toHaveBeenCalledWith(
      expect.objectContaining({ serviceClass: "workload-interactive" }),
      expect.any(AbortSignal),
    );
  });

  it("releases the permit when the tool throws", async () => {
    const { arbiter, release } = grantingArbiter();
    const execute = vi.fn(() => Promise.reject(new Error("tool boom")));
    const governed = governToolExecution(execute as never, binding(arbiter));

    await expect(governed(TOOL, {}, CONTEXT)).rejects.toThrow("tool boom");
    // 失败路径同样归还,否则一次工具异常就永久扣掉一个槽位。
    expect(release).toHaveBeenCalledOnce();
  });

  it("takes one independent permit per tool call rather than one long-lived permit", async () => {
    const { arbiter, acquire, release } = grantingArbiter();
    const execute = vi.fn(() => Promise.resolve({ ok: true }));
    const governed = governToolExecution(execute as never, binding(arbiter));

    await governed(TOOL, {}, CONTEXT);
    await governed(TOOL, {}, CONTEXT);

    // 逐次取得和释放,而不是一个跨越整轮对话的长 permit——两次工具调用之间的
    // LLM 网络往返期间设备容量必须是空闲的。
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
  });
});
