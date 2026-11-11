import { expect, it } from "vitest";
import { SerialTaskQueue } from "@zhixing-ai/core/persistence";
import {
  DefaultDeviceCapacityArbiter,
  DefaultStorageMaintenanceGovernor,
  ForegroundActivity,
  claimDeviceCapacity,
  createDefaultDeviceCapacityPolicy,
  runStorageMaintenanceStep,
  runWithMaintenanceForegroundYield,
  runWithMaintenanceUrgency,
  storageMaintenanceRequest,
} from "@zhixing-ai/core/resources";
import { projectionReadCapacity } from "../artifact-read-capacity.js";
import { retryControlAdmission } from "../conversation-admission-retry.js";

// 与宿主相同的生产策略与真实仲裁器；时钟可以先冻结再放行，让“桶已见底”的时刻确定
function capacity(now: () => number) {
  const arbiter = new DefaultDeviceCapacityArbiter({
    policy: createDefaultDeviceCapacityPolicy(),
    now,
    probe: () => ({ cpuBusyRatio: 0, availableMemoryBytes: 1024 ** 3, processRssBytes: 0, temporaryBytesAvailable: 8 * 1024 ** 3 }),
  });
  return { arbiter, governor: new DefaultStorageMaintenanceGovernor({ capacity: arbiter }) };
}

// 前台的一次必要读：与票据接纳相同，在串行区内经投影读叶准入（零等待），读到即产生一次效果
function foregroundRead(arbiter: DefaultDeviceCapacityArbiter, effects: { count: number }) {
  const queue = new SerialTaskQueue();
  const leaf = projectionReadCapacity(arbiter)!;
  return () => queue.run(() => leaf("segment-entry", async () => {
    claimDeviceCapacity("ioOperations", 3);
    effects.count += 1;
    return "read";
  }));
}

// 后台把桶用到见底：最后一步恰好取走余下的全部 IO
async function drain(arbiter: DefaultDeviceCapacityArbiter, governor: DefaultStorageMaintenanceGovernor) {
  const remaining = arbiter.snapshot().quantumAvailable.ioOperations;
  const request = storageMaintenanceRequest("authority-checkpoint", "home", { drain: true }, { obligation: "committed" });
  const bound = { occupancy: request.atomic.occupancy, quantum: { readBytes: 0, writeBytes: 0, ioOperations: remaining } };
  await runWithMaintenanceUrgency(() => "background", new AbortController().signal, () =>
    runStorageMaintenanceStep(governor, { ...request, atomic: bound, preferred: bound }, async () => {
      claimDeviceCapacity("ioOperations", remaining);
    }));
  expect(arbiter.snapshot().quantumAvailable.ioOperations).toBe(0);
}

it("后台先耗空、用户再到：前台读叶第一次被拒后在区外按短退避接续，同一工作只生效一次", async () => {
  let frozen = true;
  const base = performance.now();
  let released = 0;
  const now = () => (frozen ? base : base + (performance.now() - released));
  const { arbiter, governor } = capacity(now);
  await drain(arbiter, governor);
  const effects = { count: 0 };
  const read = foregroundRead(arbiter, effects);

  // 不在区外接续：桶见底时第一次准入即失败
  await expect(read()).rejects.toThrow(/backpressured:ioOperations/);
  expect(effects.count).toBe(0);

  // 在区外接续：第一次同样被拒；时钟放行后按回填几毫秒内补足，第二次成功
  const started = performance.now();
  const pending = retryControlAdmission(read, async () => {});
  setTimeout(() => { released = performance.now(); frozen = false; }, 0);
  await expect(pending).resolves.toBe("read");
  expect(effects.count).toBe(1);
  expect(performance.now() - started).toBeLessThan(1_000);
}, 30_000);

it("用户到时后台一步仍在飞：后台至多完成在飞的一步就让路，前台完成；前台结束后后台继续并完成，中止可退出", async () => {
  const { arbiter, governor } = capacity(() => performance.now());
  const foreground = new ForegroundActivity();
  const quietMs = 20;
  const yieldToForeground = (signal: AbortSignal) => foreground.whenQuiet(quietMs, signal);
  const steps = { done: 0, total: 160 };
  // 每日义务：后台紧急度、带让路语境；每步用满单步上界 256 次 IO，突发 128 步之后按回填节奏推进
  const daily = (abort: AbortController) => runWithMaintenanceForegroundYield(yieldToForeground, () =>
    runWithMaintenanceUrgency(() => "background", abort.signal, async () => {
      for (let index = steps.done; index < steps.total; index += 1) {
        await runStorageMaintenanceStep(
          governor,
          storageMaintenanceRequest("authority-checkpoint", "home", { index }, { obligation: "pre-commit", maxWaitMs: 5_000 }),
          async () => { claimDeviceCapacity("ioOperations", 256); steps.done += 1; },
        );
      }
    }));
  const abort = new AbortController();
  const running = daily(abort);
  // 等后台把突发额度用完、开始按回填节奏一步一步推进
  while (steps.done < 130) await new Promise((resolve) => setTimeout(resolve, 5));

  const effects = { count: 0 };
  const read = foregroundRead(arbiter, effects);
  const leave = foreground.enter();
  const atArrival = steps.done;
  const started = performance.now();
  await expect(retryControlAdmission(read, async () => {})).resolves.toBe("read");
  const elapsed = performance.now() - started;
  expect(effects.count).toBe(1);
  expect(elapsed).toBeLessThan(1_000);
  // 前台在途：后台不再推进（至多完成到达时在飞的那一步）
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(steps.done - atArrival).toBeLessThanOrEqual(1);
  leave();
  // 前台结束后后台继续并完成
  await running;
  expect(steps.done).toBe(steps.total);

  // 前台在途时中止后台：让路中的后台及时以取消退出，不挂住
  steps.done = 0;
  const leaveAgain = foreground.enter();
  const second = new AbortController();
  const stopped = daily(second);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const abortedAt = performance.now();
  second.abort();
  await expect(stopped).rejects.toThrow(/cancelled/);
  expect(performance.now() - abortedAt).toBeLessThan(500);
  leaveAgain();
}, 60_000);
