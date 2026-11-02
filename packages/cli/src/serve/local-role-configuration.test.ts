import { describe, expect, it } from "vitest";
import { createTempDir } from "@zhixing/test-utils";
import { loadConfig } from "@zhixing/providers";
import { resolveHostLaunchPlan } from "@zhixing/mesh/bootstrap";
import {
  continuedLocalInitialization,
  writeInitializedLocalRoles,
  type LocalInitializationTrust,
} from "./local-role-configuration.js";

const LOCAL = "device-local";

/** 本机初始化留下的链：创世（seq 0）＋一次角色授予（seq 1），唯一成员是本机。 */
function initializedTrust(overrides: Partial<LocalInitializationTrust> = {}): LocalInitializationTrust {
  return {
    chainHead: { seq: 1 },
    issuer: { deviceId: LOCAL },
    members: [{ state: "active", roles: ["executor", "anchor"], device: { deviceId: LOCAL } }],
    ...overrides,
  };
}

describe("有链本机的角色启动配置", () => {
  it("被打断的本机初始化启动计划如实拒绝；接续写下初始化选定的配置后落在仅本机拓扑，按需启动不托管", async () => {
    const home = await createTempDir("local-role-configuration-plan");
    const before = loadConfig({ homeDir: home });
    const trust = initializedTrust();
    expect(before.mesh).toBeUndefined();
    expect(() => resolveHostLaunchPlan({ localDeviceId: LOCAL, trust: trust as never }))
      .toThrow("Trusted-home mesh startup requires role configuration");
    const continued = continuedLocalInitialization({ config: before, trust, deviceId: LOCAL });
    expect(continued?.mesh).toEqual({ enabledRoles: ["anchor", "executor"] });
    // 判定本身不写盘：查看状态只按接续结果投影
    expect(loadConfig({ homeDir: home }).mesh).toBeUndefined();
    expect(resolveHostLaunchPlan({ localDeviceId: LOCAL, configuration: continued!.mesh as never, trust: trust as never }))
      .toEqual({ mode: "on-demand", roles: ["anchor", "executor"] });
  });

  it("只认链上的本机初始化形状：远端成员、配对过的链、角色改过、已有根或配置都不自动启用", async () => {
    const config = loadConfig({ homeDir: await createTempDir("local-role-configuration-shape") });
    const refused: readonly [string, LocalInitializationTrust][] = [
      ["本机不是签发者", initializedTrust({ issuer: { deviceId: "device-anchor" } })],
      ["链在初始化之后还有事件", initializedTrust({ chainHead: { seq: 2 } })],
      ["曾有其他成员（已撤销也算）", initializedTrust({ members: [
        { state: "active", roles: ["anchor", "executor"], device: { deviceId: LOCAL } },
        { state: "revoked", roles: ["executor"], device: { deviceId: "device-other" } },
      ] })],
      ["唯一成员不是本机", initializedTrust({ members: [{ state: "active", roles: ["anchor", "executor"], device: { deviceId: "device-other" } }] })],
      ["本机已不是有效成员", initializedTrust({ members: [{ state: "revoked", roles: ["anchor", "executor"], device: { deviceId: LOCAL } }] })],
      ["角色不是初始化授予的那组", initializedTrust({ members: [{ state: "active", roles: ["executor"], device: { deviceId: LOCAL } }] })],
      ["已建立恢复根", initializedTrust({ recoveryRootPublicKey: "root", recoveryBackupPublicKey: "backup" })],
      ["只剩一把根公钥", initializedTrust({ recoveryBackupPublicKey: "backup" })],
      ["有待定重置", initializedTrust({ pendingResetEvent: {} })],
    ];
    for (const [label, trust] of refused) {
      expect(continuedLocalInitialization({ config, trust, deviceId: LOCAL }), label).toBeUndefined();
    }
    const configured = { ...config, mesh: { enabledRoles: ["executor"] } } as typeof config;
    expect(continuedLocalInitialization({ config: configured, trust: initializedTrust(), deviceId: LOCAL })).toBeUndefined();
  });

  it("初始化方写下选定配置；已有配置不覆盖", async () => {
    const home = await createTempDir("local-role-configuration-kept");
    const written = await writeInitializedLocalRoles({ homeDir: home, config: loadConfig({ homeDir: home }) });
    expect(loadConfig({ homeDir: home }).mesh).toEqual({ enabledRoles: ["anchor", "executor"] });
    const custom = { ...written, mesh: { enabledRoles: ["anchor"] as const, executorAutoStart: true } } as unknown as typeof written;
    expect(await writeInitializedLocalRoles({ homeDir: home, config: custom })).toBe(custom);
    expect(loadConfig({ homeDir: home }).mesh).toEqual({ enabledRoles: ["anchor", "executor"] });
  });
});
