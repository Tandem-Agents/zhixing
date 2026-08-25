import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import {
  claimDeviceCapacity,
  createNodeDeviceCapacityProbe,
  DEVICE_CAPACITY_CLASSES,
  DefaultDeviceCapacityArbiter,
  DeviceCapacityStepError,
  emptyDeviceCapacityBudget,
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
