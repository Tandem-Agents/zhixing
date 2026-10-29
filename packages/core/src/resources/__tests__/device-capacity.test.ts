import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import {
  claimDeviceCapacity,
  createNodeDeviceCapacityProbe,
  DEVICE_CAPACITY_CLASSES,
  DefaultDeviceCapacityArbiter,
  DeviceCapacityStepError,
  emptyDeviceCapacityBudget,
  runWithDeviceCapacity,
  runDetachedDeviceCapacity,
  currentDeviceCapacityStep,
  withDeviceCapacityStep,
  type DeviceCapacityBudget,
  type DeviceCapacityPolicy,
  type DeviceCapacityPressure,
} from "../device-capacity.js";

const MIB = 1024 * 1024;

function budget(
  slots: number,
  overrides: Partial<{
    memoryReservationBytes: number;
    temporaryBytes: number;
    readBytes: number;
    writeBytes: number;
    ioOperations: number;
  }> = {},
): DeviceCapacityBudget {
  return {
    occupancy: {
      memoryReservationBytes: overrides.memoryReservationBytes ?? MIB,
      temporaryBytes: overrides.temporaryBytes ?? 0,
      slots,
    },
    quantum: {
      readBytes: overrides.readBytes ?? 0,
      writeBytes: overrides.writeBytes ?? 0,
      ioOperations: overrides.ioOperations ?? 0,
    },
  };
}

function policy(slots = 1): DeviceCapacityPolicy {
  return {
    version: 1,
    occupancy: {
      memoryReservationBytes: 16 * MIB,
      temporaryBytes: 16 * MIB,
      slots,
      memorySafetyReserveBytes: 0,
      temporarySafetyReserveBytes: 0,
    },
    quantum: {
      readBytes: 100,
      writeBytes: 100,
      ioOperations: 100,
    },
    quantumRefillPerSecond: {
      readBytes: 100,
      writeBytes: 100,
      ioOperations: 100,
    },
    pressure: {
      maxCpuBusyRatio: 0.9,
      minimumAvailableMemoryBytes: 0,
    },
    retryAfterMs: 1,
    classWeights: Object.fromEntries(
      DEVICE_CAPACITY_CLASSES.map((serviceClass) => [serviceClass, 1]),
    ) as DeviceCapacityPolicy["classWeights"],
  };
}

function pressure(): DeviceCapacityPressure {
  return {
    cpuBusyRatio: 0,
    availableMemoryBytes: 64 * MIB,
    processRssBytes: MIB,
    temporaryBytesAvailable: 64 * MIB,
  };
}

function request(
  admissionId: string,
  atomic: DeviceCapacityBudget,
  maxWaitMs = 0,
) {
  return {
    admissionId,
    serviceClass: "workload-interactive" as const,
    atomic,
    preferred: atomic,
    maxWaitMs,
  };
}

describe("DefaultDeviceCapacityArbiter", () => {
  it("separates durable work from the caller permit without releasing or extending it", async () => {
    const arbiter = new DefaultDeviceCapacityArbiter({ policy: policy(), probe: pressure });
    const signal = new AbortController().signal;
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    let detached!: Promise<void>;
    await runWithDeviceCapacity(arbiter, request("caller", budget(1)), signal, async () => {
      const owner = currentDeviceCapacityStep();
      detached = runDetachedDeviceCapacity(async () => {
        expect(currentDeviceCapacityStep()).toBeUndefined();
        expect(arbiter.snapshot().occupancyInUse.slots).toBe(1);
        await gate;
        expect(currentDeviceCapacityStep()).toBeUndefined();
        await runWithDeviceCapacity(arbiter, request("job", budget(1, { readBytes: 10 })), signal,
          async () => { claimDeviceCapacity("readBytes", 10); });
      });
      expect(currentDeviceCapacityStep()).toBe(owner);
    });
    resume();
    await detached;
    expect(arbiter.snapshot().occupancyInUse.slots).toBe(0);
    expect(arbiter.snapshot().quantumAvailable.readBytes).toBe(90);
  });

  it("requires an authentic current workload step for a nonwaiting borrowed slot", async () => {
    const arbiter = new DefaultDeviceCapacityArbiter({ policy: policy(), probe: pressure });
    const other = new DefaultDeviceCapacityArbiter({ policy: policy(), probe: pressure });
    const leaf = request("leaf", budget(0, { readBytes: 10, ioOperations: 1 }));
    const signal = new AbortController().signal;
    expect(() => arbiter.acquire(leaf, signal)).toThrow("reserve a slot");
    await runWithDeviceCapacity(arbiter, request("parent", budget(1)), signal, async () => {
      expect(() => other.acquire(leaf, signal)).toThrow("reserve a slot");
      expect(() => arbiter.acquire({ ...leaf, maxWaitMs: 1 }, signal)).toThrow("reserve a slot");
      expect(() => arbiter.acquire({ ...leaf, serviceClass: "storage-foreground" }, signal)).toThrow("reserve a slot");
      expect(() => arbiter.acquire({ ...leaf, preferred: budget(1) }, signal)).toThrow();
      const admitted = await arbiter.acquire(leaf, signal);
      if (admitted.kind !== "granted") throw Error("first physical read must fit");
      expect(await arbiter.acquire(leaf, signal)).toMatchObject({ kind: "backpressured", blockedBy: "slots" });
      admitted.permit.release();
      const next = await arbiter.acquire(leaf, signal);
      if (next.kind !== "granted") throw Error("released read must allow next read");
      next.permit.release();
    });
    expect(arbiter.snapshot().occupancyInUse.slots).toBe(0);
  });

  it("retains the parent occupancy until its physical child releases, including wrapped permits", async () => {
    const underlying = new DefaultDeviceCapacityArbiter({ policy: policy(), probe: pressure });
    const wrapper = {
      snapshot: () => underlying.snapshot(),
      acquire: async (...args: Parameters<typeof underlying.acquire>) => {
        const result = await underlying.acquire(...args);
        if (result.kind !== "granted") return result;
        return { kind: "granted" as const, permit: { granted: result.permit.granted,
          tryBegin: (bound: DeviceCapacityBudget) => result.permit.tryBegin(bound), release: () => result.permit.release() } };
      },
    };
    const signal = new AbortController().signal;
    const child = await runWithDeviceCapacity(wrapper, request("parent", budget(1)), signal,
      () => wrapper.acquire(request("read", budget(0, { readBytes: 10 })), signal));
    if (child.kind !== "granted") throw Error("wrapped read must fit");
    expect(underlying.snapshot().occupancyInUse.slots).toBe(1);
    expect(await underlying.acquire(request("next", budget(1)), signal)).toMatchObject({ kind: "backpressured", blockedBy: "slots" });
    await withDeviceCapacityStep(child.permit, budget(0, { readBytes: 10 }), async () => claimDeviceCapacity("readBytes", 10));
    child.permit.release(); child.permit.release();
    expect(underlying.snapshot().occupancyInUse).toEqual(emptyDeviceCapacityBudget().occupancy);
    expect(underlying.snapshot().lastViolation).toBeUndefined();
  });

  it("returns borrowed-slot ownership on cancelled, gap, blocked and failed-step admissions", async () => {
    let current = pressure();
    const arbiter = new DefaultDeviceCapacityArbiter({ policy: policy(), probe: () => current });
    const signal = new AbortController().signal, cancelled = new AbortController(); cancelled.abort();
    await runWithDeviceCapacity(arbiter, request("parent", budget(1)), signal, async () => {
      const leaf = request("leaf", budget(0, { readBytes: 10 }));
      expect(await arbiter.acquire(leaf, cancelled.signal)).toEqual({ kind: "cancelled" });
      expect(await arbiter.acquire(request("gap", budget(0, { readBytes: 101 })), signal)).toMatchObject({ kind: "capacity-gap" });
      current = { ...pressure(), availableMemoryBytes: MIB };
      expect(await arbiter.acquire(leaf, signal)).toMatchObject({ kind: "backpressured", blockedBy: "memoryReservationBytes" });
      current = pressure();
      const admitted = await arbiter.acquire(leaf, signal);
      if (admitted.kind !== "granted") throw Error("backpressure must release borrowed slot");
      await expect(withDeviceCapacityStep(admitted.permit, budget(0, { readBytes: 11 }), async () => {})).rejects.toThrow("cannot cover");
      admitted.permit.release();
      const next = await arbiter.acquire(leaf, signal);
      if (next.kind !== "granted") throw Error("failed step must release borrowed slot");
      next.permit.release();
    });
    expect(arbiter.snapshot().occupancyInUse.slots).toBe(0);
  });

  it("distinguishes an unavailable pressure probe from real memory and disk pressure", async () => {
    let current: DeviceCapacityPressure | undefined;
    const arbiter = new DefaultDeviceCapacityArbiter({ policy: policy(), probe: () => { if (!current) throw Error("disk probe not ready"); return current; } });
    const acquire = () => arbiter.acquire(request("probe-state", budget(1, { temporaryBytes: 1 })), new AbortController().signal);
    expect(await acquire()).toMatchObject({ kind: "backpressured", blockedBy: "probe-unavailable" });
    expect(arbiter.snapshot()).toMatchObject({ devicePressure: null, blockedBy: "probe-unavailable" });
    current = { ...pressure(), availableMemoryBytes: 0 };
    expect(await acquire()).toMatchObject({ kind: "backpressured", blockedBy: "memoryReservationBytes" });
    current = { ...pressure(), temporaryBytesAvailable: 0 };
    expect(await acquire()).toMatchObject({ kind: "backpressured", blockedBy: "temporaryBytes" });
    current = { ...pressure(), temporaryBytesAvailable: NaN };
    expect(await acquire()).toMatchObject({ kind: "backpressured", blockedBy: "probe-unavailable" });
    current = pressure();
    const admitted = await acquire();
    expect(admitted.kind).toBe("granted");
    if (admitted.kind === "granted") admitted.permit.release();
  });

  it("blocks only temporary-space reservations while the disk sample is unavailable", async () => {
    // 磁盘样本缺失（过期或探测失败）不是零，也不能推给其他维度：只读、只占内存与槽位的请求照常裁决
    const { temporaryBytesAvailable: _disk, ...withoutDisk } = pressure();
    let current: DeviceCapacityPressure = pressure();
    const arbiter = new DefaultDeviceCapacityArbiter({ policy: policy(3), probe: () => current });
    const signal = new AbortController().signal;
    // 样本还在时已有请求占着临时空间；随后样本不可用
    const holder = await arbiter.acquire(request("holds-disk", budget(1, { temporaryBytes: MIB })), signal);
    if (holder.kind !== "granted") throw Error("the holder is admitted on a fresh sample");
    current = withoutDisk;
    const disk = await arbiter.acquire(request("needs-disk", budget(1, { temporaryBytes: 1 })), signal);
    expect(disk).toMatchObject({ kind: "backpressured", blockedBy: "probe-unavailable" });
    const read = await arbiter.acquire({ ...request("read-only", budget(1, { readBytes: 10 })),
      preferred: budget(1, { readBytes: 10, temporaryBytes: 8 * MIB }) }, signal);
    if (read.kind !== "granted") throw Error("a read-only request does not depend on the disk sample");
    expect(read.permit.granted.occupancy.temporaryBytes).toBe(0);
    expect(arbiter.snapshot()).toMatchObject({ occupancyCapacity: { temporaryBytes: 0 }, devicePressure: { availableMemoryBytes: 64 * MIB } });
    // 其他维度仍按各自的样本：内存不足照样受阻
    current = { ...withoutDisk, availableMemoryBytes: 0 };
    expect(await arbiter.acquire(request("memory", budget(1)), signal)).toMatchObject({ kind: "backpressured", blockedBy: "memoryReservationBytes" });
    read.permit.release();
    holder.permit.release();
    // 样本恢复后临时空间照常放出
    current = pressure();
    const restored = await arbiter.acquire(request("needs-disk-again", budget(1, { temporaryBytes: 1 })), signal);
    expect(restored.kind).toBe("granted");
    if (restored.kind === "granted") restored.permit.release();
  });

  it("keeps the other pressure dimensions when the disk sample cannot be read", () => {
    const probe = createNodeDeviceCapacityProbe("unused-root", { readFilesystem: () => { throw Error("disk sample is stale"); } });
    const sample = probe();
    expect(sample.temporaryBytesAvailable).toBeUndefined();
    expect(sample.availableMemoryBytes).toBeGreaterThan(0);
  });

  it("uses a stable CPU sampling window instead of treating an immature sample as saturation", async () => {
    const temporaryRoot = await createTempDir("device-capacity-probe");
    let now = 0;
    let cpu = { total: 1_000, idle: 500 };
    const probe = createNodeDeviceCapacityProbe(temporaryRoot, {
      now: () => now,
      readCpuTimes: () => cpu,
    });

    cpu = { total: 1_001, idle: 500 };
    expect(probe().cpuBusyRatio).toBe(0);
    now = 249;
    cpu = { total: 2_000, idle: 500 };
    expect(probe().cpuBusyRatio).toBe(0);

    now = 250;
    cpu = { total: 2_000, idle: 1_000 };
    expect(probe().cpuBusyRatio).toBe(0.5);
    now = 300;
    cpu = { total: 3_000, idle: 1_000 };
    expect(probe().cpuBusyRatio).toBe(0.5);
  });

  it("distinguishes an impossible capacity gap from temporary backpressure", async () => {
    const arbiter = new DefaultDeviceCapacityArbiter({
      policy: policy(),
      probe: pressure,
    });
    const impossible = await arbiter.acquire(
      request("gap", budget(2)),
      new AbortController().signal,
    );
    expect(impossible).toMatchObject({
      kind: "capacity-gap",
      blockedBy: "slots",
      required: 2,
      available: 1,
    });

    const first = await arbiter.acquire(
      request("first", budget(1)),
      new AbortController().signal,
    );
    expect(first.kind).toBe("granted");
    const blocked = await arbiter.acquire(
      request("blocked", budget(1)),
      new AbortController().signal,
    );
    expect(blocked).toMatchObject({
      kind: "backpressured",
      blockedBy: "slots",
    });
    if (first.kind === "granted") first.permit.release();
  });

  it("reports saturated CPU without rewriting the versioned slot capacity", async () => {
    let currentPressure: DeviceCapacityPressure = {
      ...pressure(),
      cpuBusyRatio: 1,
    };
    const arbiter = new DefaultDeviceCapacityArbiter({
      policy: policy(4),
      probe: () => currentPressure,
    });

    const first = await arbiter.acquire(
      request("cpu-progress", budget(1)),
      new AbortController().signal,
    );
    expect(first.kind).toBe("granted");

    const second = await arbiter.acquire(
      request("cpu-progress-adjacent", budget(1)),
      new AbortController().signal,
    );
    expect(second.kind).toBe("granted");

    const third = await arbiter.acquire(
      request("cpu-progress-third", budget(1)),
      new AbortController().signal,
    );
    expect(third.kind).toBe("granted");
    const fourth = await arbiter.acquire(
      request("cpu-progress-fourth", budget(1)),
      new AbortController().signal,
    );
    expect(fourth.kind).toBe("granted");
    expect(arbiter.snapshot()).toMatchObject({
      occupancyCapacity: { slots: 4 },
      occupancyInUse: { slots: 4 },
      devicePressure: { cpuBusyRatio: 1 },
    });
    const slotBlocked = await arbiter.acquire(
      request("slot-backpressure", budget(1)),
      new AbortController().signal,
    );
    expect(slotBlocked).toMatchObject({
      kind: "backpressured",
      blockedBy: "slots",
    });
    for (const admission of [first, second, third, fourth]) {
      if (admission.kind === "granted") admission.permit.release();
    }

    currentPressure = {
      ...pressure(),
      availableMemoryBytes: 0,
    };
    const memoryBlocked = await arbiter.acquire(
      request("memory-backpressure", budget(1)),
      new AbortController().signal,
    );
    expect(memoryBlocked).toMatchObject({
      kind: "backpressured",
      blockedBy: "memoryReservationBytes",
    });
  });

  it("pre-reserves each step, seals a violating permit, and reports the violation", async () => {
    const arbiter = new DefaultDeviceCapacityArbiter({
      policy: policy(),
      probe: pressure,
    });
    const atomic = budget(1, { readBytes: 10 });
    const preferred = budget(1, { readBytes: 20 });
    const admission = await arbiter.acquire(
      {
        ...request("bounded-step", atomic),
        preferred,
      },
      new AbortController().signal,
    );
    expect(admission.kind).toBe("granted");
    if (admission.kind !== "granted") return;

    expect(
      admission.permit.tryBegin(budget(1, { readBytes: 11 })),
    ).toBeUndefined();
    expect(admission.permit.tryBegin(atomic)).toBeUndefined();
    admission.permit.release();
    expect(arbiter.snapshot().lastViolation).toEqual({
      admissionId: "bounded-step",
      dimension: "readBytes",
      limit: 10,
      requested: 11,
    });
  });

  it("rejects cumulative resource requests before the exceeding operation", async () => {
    const arbiter = new DefaultDeviceCapacityArbiter({
      policy: policy(),
      probe: pressure,
    });
    const atomic = budget(1, { readBytes: 10, ioOperations: 2 });
    const admission = await arbiter.acquire(
      request("cumulative-step", atomic),
      new AbortController().signal,
    );
    expect(admission.kind).toBe("granted");
    if (admission.kind !== "granted") return;

    const effects: string[] = [];
    await expect(
      withDeviceCapacityStep(admission.permit, atomic, async () => {
        claimDeviceCapacity("readBytes", 6);
        effects.push("first");
        claimDeviceCapacity("readBytes", 5);
        effects.push("second");
      }),
    ).rejects.toBeInstanceOf(DeviceCapacityStepError);
    expect(effects).toEqual(["first"]);
    admission.permit.release();
    expect(arbiter.snapshot().lastViolation).toEqual({
      admissionId: "cumulative-step",
      dimension: "readBytes",
      limit: 10,
      requested: 11,
    });
  });

  it("admits every service class under sustained contention", async () => {
    const arbiter = new DefaultDeviceCapacityArbiter({
      policy: policy(),
      probe: pressure,
    });
    const holder = await arbiter.acquire(
      request("holder", budget(1)),
      new AbortController().signal,
    );
    expect(holder.kind).toBe("granted");
    if (holder.kind !== "granted") return;

    const completed: string[] = [];
    const queued = DEVICE_CAPACITY_CLASSES.map(async (serviceClass) => {
      const admission = await arbiter.acquire(
        {
          ...request(`queued-${serviceClass}`, budget(1), 1_000),
          serviceClass,
        },
        new AbortController().signal,
      );
      expect(admission.kind).toBe("granted");
      if (admission.kind === "granted") {
        completed.push(serviceClass);
        admission.permit.release();
      }
    });
    holder.permit.release();
    await Promise.all(queued);
    expect(new Set(completed)).toEqual(new Set(DEVICE_CAPACITY_CLASSES));
  });

  it("returns cancelled without consuming capacity", async () => {
    const arbiter = new DefaultDeviceCapacityArbiter({
      policy: policy(),
      probe: pressure,
    });
    const abort = new AbortController();
    abort.abort();
    await expect(
      arbiter.acquire(request("cancelled", budget(1)), abort.signal),
    ).resolves.toEqual({ kind: "cancelled" });
    expect(arbiter.snapshot().occupancyInUse).toEqual(
      emptyDeviceCapacityBudget().occupancy,
    );
  });
});

describe('explicit separate read admission', () => {
  it('borrows a genuine write workload slot and settles each ledger independently', async () => {
    const arbiter = new DefaultDeviceCapacityArbiter({ policy: policy(), probe: pressure, now: () => 0 });
    const signal = new AbortController().signal, write = budget(1, { writeBytes: 40, ioOperations: 8 });
    await runWithDeviceCapacity(arbiter, { ...request('writer', write), separateReadAdmission: true }, signal, async () => {
      const owner = currentDeviceCapacityStep();
      expect(owner).toMatchObject({ kind: 'workload', separateReadAdmission: true }); expect(Object.isFrozen(owner)).toBe(true);
      claimDeviceCapacity('writeBytes', 10); claimDeviceCapacity('ioOperations', 2);
      const read = budget(0, { readBytes: 20, ioOperations: 3 });
      const leaf = await arbiter.acquire(request('leaf', read), signal);
      if (leaf.kind !== 'granted') throw Error('Owned read leaf must fit');
      try { await withDeviceCapacityStep(leaf.permit, read, async () => {
        expect(currentDeviceCapacityStep()).toEqual({ kind: 'physical' });
        claimDeviceCapacity('readBytes', 20); claimDeviceCapacity('ioOperations', 3);
      }); } finally { leaf.permit.release(); }
      expect(currentDeviceCapacityStep()).toBe(owner); expect(arbiter.snapshot().occupancyInUse).toEqual(write.occupancy);
    });
    expect(arbiter.snapshot().quantumAvailable).toEqual({ readBytes: 80, writeBytes: 90, ioOperations: 95 });
    expect(arbiter.snapshot().occupancyInUse).toEqual(emptyDeviceCapacityBudget().occupancy);
    expect(arbiter.snapshot().lastViolation).toBeUndefined();
  });

  it.each([{ atomic: 1, preferred: 1 }, { atomic: 0, preferred: 1 }])('rejects simultaneous aggregate and independent read plans: %j', async reads => {
    const arbiter = new DefaultDeviceCapacityArbiter({ policy: policy(), probe: pressure, now: () => 0 }); let entered = false;
    await expect(runWithDeviceCapacity(arbiter, { ...request('invalid', budget(1, { readBytes: reads.atomic, writeBytes: 40 })),
      preferred: budget(1, { readBytes: reads.preferred, writeBytes: 40 }), separateReadAdmission: true,
    }, new AbortController().signal, async () => { entered = true; })).rejects.toThrow('zero read budgets');
    expect(entered).toBe(false); expect(arbiter.snapshot().occupancyInUse.slots).toBe(0);
    expect(arbiter.snapshot().quantumAvailable).toEqual({ readBytes: 100, writeBytes: 100, ioOperations: 100 });
  });

  it('does not grant the opt-in to a default plan, a forged owner or a different arbiter', async () => {
    const arbiter = new DefaultDeviceCapacityArbiter({ policy: policy(), probe: pressure }), other = new DefaultDeviceCapacityArbiter({ policy: policy(), probe: pressure });
    const write = budget(1, { writeBytes: 40, ioOperations: 8 }), signal = new AbortController().signal;
    const leaf = request('read', budget(0, { readBytes: 10 }));
    await runWithDeviceCapacity(arbiter, request('default', write), signal, async () => {
      expect(() => Object.assign(currentDeviceCapacityStep()!, { separateReadAdmission: true })).toThrow();
      expect(() => arbiter.acquire(leaf, signal)).toThrow();
    });
    await runWithDeviceCapacity(arbiter, { ...request('separate', write), separateReadAdmission: true }, signal, async () => {
      expect(() => other.acquire(leaf, signal)).toThrow();
      expect(() => arbiter.acquire(request('not-a-read', budget(0, { writeBytes: 1 })), signal)).toThrow();
      expect(() => arbiter.acquire({ ...leaf, preferred: budget(0, { readBytes: 10, writeBytes: 1 }) }, signal)).toThrow();
      expect(() => arbiter.acquire(request('not-read-storage', budget(0, { temporaryBytes: 1 })), signal)).toThrow();
    });
    expect(arbiter.snapshot().occupancyInUse.slots).toBe(0); expect(other.snapshot().occupancyInUse.slots).toBe(0);
  });
});

