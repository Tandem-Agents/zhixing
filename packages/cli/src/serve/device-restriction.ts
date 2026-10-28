import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
// 本模块也被终端监督进程 S 引用：S 的启动包只内联小而纯 ESM 的依赖，这里不引入 @zhixing/server/client 等重依赖；
// 非原生平台的出生时间回退由宿主与拉起方按需注入
import { readPlatformProcessBirth, resolvePlatformProcessStartTime, type PlatformProcessBirth } from "../platform/secret-platform.js";
import type { ExecutorRemovalDomainState, ExecutorRemovalLostCleanup } from "./device-removal.js";

/**
 * 本机作为设备成员受限、不能装配普通业务时的状态。由宿主按设备领域结果给出，供前台如实呈现；
 * 它不是普通就绪，普通对话与业务服务保持关闭。
 * - removal-retrieving：本机正被移出，正在联系值班设备取回最后一步；网络恢复后自动继续
 * - removal-domain-state：现任值班设备对这次移除给出领域结论，这次取回停止
 * - removed-lost：值班设备按失联移出了本机；cleanup 只按本机已有记录给出
 * - removed：本机已被移出并完成本机收尾（设备身份已删除）
 * - uninstalled：本机作为值班设备的家庭已永久卸载
 */
export type DeviceRestriction =
  | { readonly kind: "removal-retrieving" }
  | { readonly kind: "removal-domain-state"; readonly state: ExecutorRemovalDomainState }
  | { readonly kind: "removed-lost"; readonly cleanup: ExecutorRemovalLostCleanup }
  | { readonly kind: "removed" }
  | { readonly kind: "uninstalled" }
  /** 重新配对已在值班设备提交，本机还没完成接续（旧移除仍约束本机），重试 zz pair 续做 */
  | { readonly kind: "rejoin-pending" };

/** 设备受限时宿主启动的结果：消息保留原有英文以便日志检索，restriction 供呈现。 */
export class DeviceRestrictedError extends Error {
  constructor(readonly restriction: DeviceRestriction, message: string) {
    super(message);
    this.name = "DeviceRestrictedError";
  }
}

/**
 * 受限状态标记：宿主写、拉起方读的呈现提示，只含状态字段，不含家庭、操作或密钥标识。
 * 它与就绪标记、健康检查分开，不代表服务可用；读不到或形状不对按“没有标记”处理。
 */
export function deviceRestrictionMarkerPath(zhixingHome: string): string {
  return path.join(zhixingHome, "server.restricted.json");
}

/** 写标记的宿主身份：PID 与它自己的出生时间（读不到为 null），加上发布时间，供拉起方核验归属与存活。 */
export interface DeviceRestrictionMarker {
  readonly pid: number;
  readonly startTime: number | null;
  readonly publishedAt: number;
  readonly restriction: DeviceRestriction;
}

let hostStartTime: Promise<number | null> | undefined;
const noFallback = async (): Promise<number | null> => null;
const processAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM"; }
};

/** 宿主写标记时的出生时间：原生平台直接读；非原生平台的回退（如 /proc）由宿主传入。 */
export function deviceRestrictionHostStartTime(fallback: (pid: number) => Promise<number | null> = noFallback): Promise<number | null> {
  return hostStartTime ??= resolvePlatformProcessStartTime(process.pid, fallback).catch(() => null);
}

export async function publishDeviceRestriction(
  zhixingHome: string,
  restriction: DeviceRestriction | undefined,
  startTime: Promise<number | null> = deviceRestrictionHostStartTime(),
): Promise<void> {
  const target = deviceRestrictionMarkerPath(zhixingHome);
  if (!restriction) {
    await rm(target, { force: true });
    return;
  }
  const pending = `${target}.${process.pid}.pending`;
  await writeFile(pending, JSON.stringify({ v: 2, pid: process.pid, startTime: await startTime, publishedAt: Date.now(), restriction }), { mode: 0o600 });
  await rename(pending, target);
}

export async function readDeviceRestriction(zhixingHome: string): Promise<DeviceRestrictionMarker | undefined> {
  let value: unknown;
  try { value = JSON.parse(await readFile(deviceRestrictionMarkerPath(zhixingHome), "utf8")); }
  catch { return undefined; }
  if (!value || typeof value !== "object") return undefined;
  const { v, pid, startTime, publishedAt, restriction } = value as { v?: unknown; pid?: unknown; startTime?: unknown; publishedAt?: unknown; restriction?: unknown };
  if (v !== 2 || !Number.isSafeInteger(pid) || (pid as number) <= 0 || !Number.isSafeInteger(publishedAt) ||
      (startTime !== null && !Number.isSafeInteger(startTime))) return undefined;
  const parsed = parseRestriction(restriction);
  return parsed ? { pid: pid as number, startTime: startTime as number | null, publishedAt: publishedAt as number, restriction: parsed } : undefined;
}

export type ProcessBirthReader = (pid: number) => Promise<PlatformProcessBirth>;
/** 默认读取器只用原生进程身份；没有原生能力时按未知处理（拉起方可注入带回退的读取器）。 */
const readBirth: ProcessBirthReader = pid => readPlatformProcessBirth(pid, noFallback, undefined, processAlive);

/**
 * 正在取回的宿主是否仍是写标记的那个进程：PID 的出生时间与标记一致才算。
 * 读不到出生时间（任一侧）按未知处理，不冒称正在取回，调用方照常拉起或预拉起。
 */
export async function retrievingHostAlive(marker: DeviceRestrictionMarker | undefined, birth: ProcessBirthReader = readBirth): Promise<boolean> {
  if (marker?.restriction.kind !== "removal-retrieving" || marker.startTime === null) return false;
  const current = await birth(marker.pid).catch((): PlatformProcessBirth => ({ kind: "unknown" }));
  return current.kind === "present" && current.startTime === marker.startTime;
}

/** 拉起与宿主之间的时钟采样容差。 */
const LAUNCH_SKEW_MS = 1_000;

/**
 * 标记是否是本次拉起的结果：发布时间不早于本次拉起开始，且写它的是本次子进程，
 * 或出生时间不早于本次拉起开始的宿主（managed 由系统服务另起的真正宿主）。旧标记与归属未知的标记不接收。
 */
export function restrictionOfLaunch(marker: DeviceRestrictionMarker | undefined, launch: { readonly startedAt: number; readonly spawnedPid?: number }): boolean {
  if (!marker || marker.publishedAt < launch.startedAt - LAUNCH_SKEW_MS) return false;
  if (launch.spawnedPid !== undefined && marker.pid === launch.spawnedPid) return true;
  return marker.startTime !== null && marker.startTime >= launch.startedAt - LAUNCH_SKEW_MS;
}

function parseRestriction(value: unknown): DeviceRestriction | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { kind, state, cleanup } = value as { kind?: unknown; state?: unknown; cleanup?: unknown };
  if (kind === "removal-retrieving" || kind === "removed" || kind === "uninstalled" || kind === "rejoin-pending") return { kind };
  if (kind === "removal-domain-state" &&
      (state === "target-suspended" || state === "membership-mismatch" || state === "domain-incompatible" || state === "superseded")) {
    return { kind, state };
  }
  if (kind === "removed-lost" && (cleanup === "not-started" || cleanup === "unconfirmed" || cleanup === "complete")) {
    return { kind, cleanup };
  }
  return undefined;
}

const NOT_NOW = "目前不能在这台设备上开始对话；下次启动时会重新核对。";

/** 前台呈现的白话：只陈述事实与已核实的出口，不用标识符代替名称。 */
export function deviceRestrictionNotice(restriction: DeviceRestriction): string {
  switch (restriction.kind) {
    case "removal-retrieving":
      return "这台设备正在被移出它所在的家庭，正在联系值班设备完成最后一步。网络恢复后会自动继续，期间不能开始新的对话；可以直接退出。";
    case "removal-domain-state":
      switch (restriction.state) {
        case "target-suspended":
          return `值班设备把这台设备记为“待重新配对”，而这次移除缺少原值班设备的撤销凭据，这台设备无法自行完成移除。${NOT_NOW}` +
            "如需继续使用：先退出这台设备上的知行，在值班设备上执行 zz pair 发起配对，再在这台设备上用得到的邀请完成加入（以原设备身份接回）。";
        case "membership-mismatch":
          return `现在的值班设备恢复时依据的家庭记录里没有这台设备（它可能是在那次备份之后才加入的），这次移除不会继续。${NOT_NOW}` +
            "如需继续使用：先退出这台设备上的知行，在值班设备上执行 zz pair 发起配对，再在这台设备上用得到的邀请完成加入（以原设备身份接回，并接续值班设备现在的家庭记录）。";
        case "domain-incompatible":
          return `找到的值班设备无法核对这次移除的接受记录或原授权依据，这次移除无法在那里完成。${NOT_NOW}`;
        case "superseded":
          return `值班设备确认这台设备之后已重新配对，这次移除不再继续；这台设备上还没有完成重新配对的记录。${NOT_NOW}`;
      }
      break;
    case "removed-lost": {
      const data = restriction.cleanup === "complete" ? "本机记录显示这台设备上的资料此前已清理完成。"
        : restriction.cleanup === "unconfirmed" ? "这台设备上的资料清理尚未确认，可能只完成了一部分。"
        : "本机记录显示还没有开始清理这台设备上的资料。";
      return `值班设备已按“失联设备”把这台设备移出家庭，这台设备不再属于该家庭。${data}` +
        "如需继续使用：先退出这台设备上的知行，在值班设备上执行 zz pair 发起配对，再在这台设备上用得到的邀请完成加入（会以新的设备身份加入；重新加入本身不会删除这台设备上的资料）。";
    }
    case "removed":
      return "这台设备已被移出家庭，本机的设备身份已删除。如需重新使用，请重新配对这台设备（zz pair）。";
    case "rejoin-pending":
      return "这台设备的重新配对已在值班设备上提交，但这台设备上的接续还没有完成，目前不能开始对话。请保持值班设备在线，在这台设备上再次执行 zz pair 用原邀请继续完成加入。";
    case "uninstalled":
      return "这台设备上的家庭已被永久卸载。如需恢复，请用完整恢复备份接管值班（zz backup recover）。";
  }
  throw new TypeError("Unknown device restriction");
}
