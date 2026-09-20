import { extensionList, extensionSetEnabled, extensionRefresh, extensionApplyConfiguration, extensionLocalSetup } from "@zhixing/core/extensions/application";
import { RpcErrors, type MethodEntry } from "../handlers.js";

export function buildExtensionMethods(): MethodEntry[] {
  return [
    { name: "extensions.local-setup", requiresAuth: true, async handler(_params, ctx) {
      if (!ctx.connection.loopback) throw RpcErrors.invalidParams("请在目标设备的配置入口完成账号验证");
      const api = ctx.server.productApi;
      if (!api?.supports(extensionLocalSetup)) throw RpcErrors.invalidParams("扩展管理不可用");
      return api.query(extensionLocalSetup, undefined);
    } },
    { name: "extensions.list", requiresAuth: true, async handler(_params, ctx) {
      const api = ctx.server.productApi;
      if (!api?.supports(extensionList)) throw RpcErrors.invalidParams("扩展管理在当前宿主不可用");
      return api.query(extensionList, undefined);
    } },
    ...(["extensions.set-enabled", "extensions.refresh"] as const).map((name): MethodEntry => ({
      name, requiresAuth: true, async handler(params, ctx) {
        const api = ctx.server.productApi;
        if (!api?.supports(extensionSetEnabled)) throw RpcErrors.invalidParams("扩展管理在当前宿主不可用");
        const input = params as { id?: unknown; enabled?: unknown; expectedRevision?: unknown };
        if (!input || typeof input.id !== "string" || !Number.isSafeInteger(input.expectedRevision) ||
            (name === "extensions.set-enabled" && typeof input.enabled !== "boolean")) throw RpcErrors.invalidParams("需要实例标识和当前修订");
        const target = { id: input.id, expectedRevision: input.expectedRevision as number };
        if (name === "extensions.refresh") {
          if (!ctx.connection.loopback) throw RpcErrors.invalidParams("请在目标设备的配置入口刷新本地凭据");
          return (await api.command(extensionRefresh, target)).result;
        }
        return (await api.command(extensionSetEnabled, { ...target, enabled: input.enabled as boolean })).result;
      },
    })),
    { name: "extensions.apply-configuration", requiresAuth: true, async handler(params, ctx) {
      if (!ctx.connection.loopback) throw RpcErrors.invalidParams("请在目标设备的配置入口应用本地配置");
      const api = ctx.server.productApi;
      if (!api?.supports(extensionApplyConfiguration)) throw RpcErrors.invalidParams("扩展管理在当前宿主不可用");
      const ids = (params as { ids?: unknown })?.ids;
      if (!Array.isArray(ids) || ids.length > 128 || ids.some((id) => typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id))) throw RpcErrors.invalidParams("需要有效的目标实例列表");
      return (await api.command(extensionApplyConfiguration, { ids })).result;
    } },
  ];
}
