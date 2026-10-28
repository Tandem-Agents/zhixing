import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createTempDir } from "@zhixing/test-utils";
import {
  deviceRestrictionMarkerPath,
  deviceRestrictionNotice,
  publishDeviceRestriction,
  readDeviceRestriction,
  restrictionOfLaunch,
  retrievingHostAlive,
  type DeviceRestriction,
} from "./device-restriction.js";

const ALL: readonly DeviceRestriction[] = [
  { kind: "removal-retrieving" },
  { kind: "removal-domain-state", state: "target-suspended" },
  { kind: "removal-domain-state", state: "membership-mismatch" },
  { kind: "removal-domain-state", state: "domain-incompatible" },
  { kind: "removal-domain-state", state: "superseded" },
  { kind: "removed-lost", cleanup: "not-started" },
  { kind: "removed-lost", cleanup: "unconfirmed" },
  { kind: "removed-lost", cleanup: "complete" },
  { kind: "removed" },
  { kind: "uninstalled" },
  { kind: "rejoin-pending" },
];

describe("device restriction presentation", () => {
  it("gives every state its own plain notice without identifiers or unverified exits", () => {
    const notices = ALL.map(deviceRestrictionNotice);
    expect(new Set(notices).size).toBe(ALL.length);
    for (const notice of notices) {
      expect(notice).toMatch(/[一-鿿]/u);
      // 不拿家庭、操作或密钥标识代替名称
      expect(notice).not.toMatch(/home|operation|key|[0-9a-f]{16}/iu);
    }
    // lost 不承诺“资料完整保留”，也不把未确认说成已清理
    expect(deviceRestrictionNotice({ kind: "removed-lost", cleanup: "unconfirmed" })).toContain("尚未确认");
    // 领域结论不推荐未经真实路径证实的出口；lost 给出已证实的出口：值班设备发起配对、这台设备完成加入
    for (const restriction of ALL.slice(3, 5)) expect(deviceRestrictionNotice(restriction)).not.toMatch(/zz |重新配对这台设备/u);
    for (const restriction of [...ALL.slice(1, 3), ...ALL.slice(5, 8)]) {
      expect(deviceRestrictionNotice(restriction)).toMatch(/值班设备上执行 zz pair 发起配对.*这台设备上.*完成加入/u);
    }
    expect(deviceRestrictionNotice({ kind: "removed" })).toContain("zz pair");
  });

  it("round-trips the marker with the publishing host identity, clears it, and ignores unknown shapes", async () => {
    const home = await createTempDir("device-restriction");
    expect(await readDeviceRestriction(home)).toBeUndefined();
    const before = Date.now();
    await publishDeviceRestriction(home, { kind: "removed-lost", cleanup: "complete" }, Promise.resolve(1234));
    const marker = await readDeviceRestriction(home);
    expect(marker).toMatchObject({ pid: process.pid, startTime: 1234, restriction: { kind: "removed-lost", cleanup: "complete" } });
    expect(marker!.publishedAt).toBeGreaterThanOrEqual(before);
    await publishDeviceRestriction(home, undefined);
    expect(await readDeviceRestriction(home)).toBeUndefined();
    // 没有宿主身份的前一版标记、未知状态、坏文件都按没有标记
    await writeFile(deviceRestrictionMarkerPath(home), JSON.stringify({ v: 1, pid: 7, restriction: { kind: "removed" } }));
    expect(await readDeviceRestriction(home)).toBeUndefined();
    await writeFile(deviceRestrictionMarkerPath(home), JSON.stringify({ v: 2, pid: 7, startTime: null, publishedAt: 1, restriction: { kind: "removed-lost", cleanup: "all-gone" } }));
    expect(await readDeviceRestriction(home)).toBeUndefined();
    await writeFile(deviceRestrictionMarkerPath(home), "{not json");
    expect(await readDeviceRestriction(home)).toBeUndefined();
  });
});

describe("device restriction host identity", () => {
  const retrieving = { pid: 2222, startTime: 77, publishedAt: 100, restriction: { kind: "removal-retrieving" } } as const;
  it("treats a retrieving host as alive only when the same process identity is still present", async () => {
    expect(await retrievingHostAlive(retrieving, async () => ({ kind: "present", startTime: 77 }))).toBe(true);
    // PID 被复用、进程已不在、身份读不到、标记没有出生时间：都不冒称正在取回
    expect(await retrievingHostAlive(retrieving, async () => ({ kind: "present", startTime: 78 }))).toBe(false);
    expect(await retrievingHostAlive(retrieving, async () => ({ kind: "absent" }))).toBe(false);
    expect(await retrievingHostAlive(retrieving, async () => ({ kind: "unknown" }))).toBe(false);
    expect(await retrievingHostAlive(retrieving, async () => { throw Error("probe failed"); })).toBe(false);
    expect(await retrievingHostAlive({ ...retrieving, startTime: null }, async () => ({ kind: "present", startTime: 77 }))).toBe(false);
    expect(await retrievingHostAlive({ ...retrieving, restriction: { kind: "removed" } }, async () => ({ kind: "present", startTime: 77 }))).toBe(false);
  });

  it("attributes a marker to this launch by its publish time and the host's spawn or birth", () => {
    const launch = { startedAt: 10_000, spawnedPid: 4321 };
    expect(restrictionOfLaunch({ ...retrieving, pid: 4321, startTime: null, publishedAt: 10_200 }, launch)).toBe(true);
    // managed 由系统服务另起的真正宿主：出生在本次拉起之后
    expect(restrictionOfLaunch({ ...retrieving, pid: 9002, startTime: 10_100, publishedAt: 10_200 }, launch)).toBe(true);
    expect(restrictionOfLaunch({ ...retrieving, pid: 9002, startTime: null, publishedAt: 10_200 }, launch)).toBe(false);
    expect(restrictionOfLaunch({ ...retrieving, pid: 9002, startTime: 2_000, publishedAt: 10_200 }, launch)).toBe(false);
    expect(restrictionOfLaunch({ ...retrieving, pid: 4321, startTime: null, publishedAt: 3_000 }, launch)).toBe(false);
    expect(restrictionOfLaunch(undefined, launch)).toBe(false);
  });
});
