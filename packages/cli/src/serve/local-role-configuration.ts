import type { DeviceRole } from "@zhixing-ai/core/contracts";
import { loadConfig, writeConfig } from "@zhixing-ai/providers";

type LoadedConfig = ReturnType<typeof loadConfig>;

/** 本机初始化（备份设置或配对发起方建链）授予并启用的角色：一台单机同时承担 anchor 与 executor。 */
export const LOCAL_INITIALIZATION_ROLES: readonly DeviceRole[] = Object.freeze(["anchor", "executor"]);

/**
 * 判定接续所需的信任事实：链头位置、签发者、全部成员（含已撤销）与恢复根。
 * 只看有效成员不够，曾经配对过、后来撤掉对端的 home 不是本机初始化。
 */
export interface LocalInitializationTrust {
  readonly chainHead: { readonly seq: number };
  readonly issuer: { readonly deviceId: string };
  readonly members: readonly {
    readonly state: string;
    readonly roles: readonly string[];
    readonly device: { readonly deviceId: string };
  }[];
  readonly recoveryRootPublicKey?: string;
  readonly recoveryBackupPublicKey?: string;
  readonly pendingResetEvent?: unknown;
}

/**
 * 初始化方在本次初始化责任内写下选定的启动配置：只启用初始化授予的角色、不写任何跨设备传输，
 * 单机因此落在“仅本机运行”拓扑里（零监听、按需启动）。已有配置一律不覆盖。
 */
export async function writeInitializedLocalRoles(input: {
  readonly homeDir: string;
  readonly config: LoadedConfig;
}): Promise<LoadedConfig> {
  if (input.config.mesh !== undefined) return input.config;
  const next = { ...input.config, mesh: { enabledRoles: [...LOCAL_INITIALIZATION_ROLES] } } as LoadedConfig;
  await writeConfig(next, { homeDir: input.homeDir, expected: input.config });
  return next;
}

/**
 * 被打断的本机初始化（信任已落盘、启动配置还没写）的接续结果；不是这种情形时返回 undefined。
 * 只认链上留下的初始化形状：本机是签发者、链只有创世与一次角色授予、唯一成员是本机且角色恰为初始化授予的那组、
 * 没有恢复根也没有待定重置。远端成员、配对过的 home、角色被改过的链都不在此列，交给启动校验如实报告。
 * 授权角色集合不等于启用意图，所以写入的是初始化方会写的那份选定配置，而不是照抄链上授权。
 */
export function continuedLocalInitialization(input: {
  readonly config: LoadedConfig;
  readonly trust: LocalInitializationTrust;
  readonly deviceId: string;
}): LoadedConfig | undefined {
  const { config, trust, deviceId } = input;
  if (config.mesh !== undefined) return undefined;
  if (trust.issuer.deviceId !== deviceId || trust.chainHead.seq !== 1) return undefined;
  if (trust.recoveryRootPublicKey || trust.recoveryBackupPublicKey || trust.pendingResetEvent) return undefined;
  if (trust.members.length !== 1) return undefined;
  const member = trust.members[0]!;
  if (member.state !== "active" || member.device.deviceId !== deviceId) return undefined;
  if (member.roles.length !== LOCAL_INITIALIZATION_ROLES.length ||
      !LOCAL_INITIALIZATION_ROLES.every((role) => member.roles.includes(role))) return undefined;
  return { ...config, mesh: { enabledRoles: [...LOCAL_INITIALIZATION_ROLES] } } as LoadedConfig;
}
