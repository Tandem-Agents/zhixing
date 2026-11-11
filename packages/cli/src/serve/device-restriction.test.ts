import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createTempDir } from "@zhixing-ai/test-utils";
import { readPlatformProcessBirth } from "../platform/secret-platform.js";
import {
  deviceRestrictionMarkerPath,
  deviceRestrictionNotice,
  publishDeviceRestriction,
  readDeviceRestriction,
  requestRestrictedHostStop,
  restrictedStopRequestPath,
  restrictionOfLaunch,
  retrievingHostAlive,
  watchRestrictedHostStop,
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
  { kind: "recovery-root-pending" },
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

  it("等配对设备协助建恢复根的宿主同样算长等待：存活核验与移除取回同一规则", async () => {
    const waiting = { ...retrieving, restriction: { kind: "recovery-root-pending" as const } };
    expect(await retrievingHostAlive(waiting, async () => ({ kind: "present", startTime: 77 }))).toBe(true);
    expect(await retrievingHostAlive(waiting, async () => ({ kind: "absent" }))).toBe(false);
  });

  it("清除受限提示时不删另一个仍存活宿主的标记，本进程或已退出宿主的标记照常清掉", async () => {
    const home = await createTempDir("restricted-marker-owner");
    const other = { v: 2, pid: process.pid + 100000, startTime: 1, publishedAt: 1, restriction: { kind: "recovery-root-pending" } };
    await writeFile(deviceRestrictionMarkerPath(home), JSON.stringify(other));
    // 另一个 PID 的进程在本机不存在：已退出宿主留下的标记，照常清掉
    await publishDeviceRestriction(home, undefined);
    expect(await readDeviceRestriction(home)).toBeUndefined();
    // 本进程自己的标记
    await publishDeviceRestriction(home, { kind: "recovery-root-pending" }, Promise.resolve(123));
    await publishDeviceRestriction(home, undefined);
    expect(await readDeviceRestriction(home)).toBeUndefined();
    // 另一个仍存活的进程（测试进程的父进程，按平台读出它的出生时间）写的标记留着
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const parent = await readPlatformProcessBirth(process.ppid, async () => null, undefined, alive);
    if (parent.kind === "present") {
      await writeFile(deviceRestrictionMarkerPath(home), JSON.stringify({ ...other, pid: process.ppid, startTime: parent.startTime }));
      await publishDeviceRestriction(home, undefined);
      expect((await readDeviceRestriction(home))?.pid).toBe(process.ppid);
    }
    // 外来标记没有出生时间、PID 仍在：身份不可证，留着
    await writeFile(deviceRestrictionMarkerPath(home), JSON.stringify({ ...other, pid: process.ppid, startTime: null }));
    await publishDeviceRestriction(home, undefined);
    expect((await readDeviceRestriction(home))?.pid).toBe(process.ppid);
    // 外来标记没有出生时间、PID 已不在：确证已退出，清掉
    await writeFile(deviceRestrictionMarkerPath(home), JSON.stringify({ ...other, startTime: null }));
    await publishDeviceRestriction(home, undefined);
    expect(await readDeviceRestriction(home)).toBeUndefined();
  });

  it("处理过的停止请求若已换成发给继任宿主的请求，不被旧宿主清掉", async () => {
    const home = await createTempDir("restricted-stop-successor");
    const self = watchRestrictedHostStop(home, Promise.resolve(123), 5);
    await requestRestrictedHostStop(home, { pid: process.pid, startTime: 123, publishedAt: 1, restriction: { kind: "recovery-root-pending" } });
    for (let i = 0; i < 40 && !self.signal.aborted; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(self.signal.aborted).toBe(true);
    await requestRestrictedHostStop(home, { pid: process.pid + 100000, startTime: 456, publishedAt: 2, restriction: { kind: "recovery-root-pending" } });
    self.dispose();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(JSON.parse(await readFile(restrictedStopRequestPath(home), "utf8"))).toMatchObject({ pid: process.pid + 100000, startTime: 456 });
  });

  it("受限宿主只响应与自己进程身份相符的停止请求，处理后清掉请求", async () => {
    const home = await createTempDir("restricted-stop-request");
    const other = watchRestrictedHostStop(home, Promise.resolve(123), 5);
    await requestRestrictedHostStop(home, { pid: process.pid, startTime: 999, publishedAt: 1, restriction: { kind: "recovery-root-pending" } });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(other.signal.aborted).toBe(false);
    other.dispose();
    const self = watchRestrictedHostStop(home, Promise.resolve(123), 5);
    await requestRestrictedHostStop(home, { pid: process.pid, startTime: 123, publishedAt: 1, restriction: { kind: "recovery-root-pending" } });
    for (let i = 0; i < 40 && !self.signal.aborted; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(self.signal.aborted).toBe(true);
    self.dispose();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(readFile(restrictedStopRequestPath(home), "utf8")).rejects.toThrow();
  });
});
