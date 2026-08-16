export type VersionMaintenanceActionTarget =
  | { readonly kind: "local-device" }
  | {
      readonly kind: "peer-devices";
      readonly displayNames: readonly [string, ...string[]];
    };

const MAINTENANCE_STEPS =
  "先运行 zz stop --maintenance；成功后运行 npm install -g @zhixing/cli@latest；再运行 zz，然后重试原操作";

export function formatVersionMaintenanceAction(
  target: VersionMaintenanceActionTarget,
): string {
  if (target.kind === "local-device") {
    return `请在这台设备完成以下步骤：${MAINTENANCE_STEPS}`;
  }
  if (target.displayNames.length === 0) {
    throw new TypeError("维护目标设备不能为空");
  }
  return `请分别在 ${target.displayNames.join("、")} 完成以下步骤：${MAINTENANCE_STEPS}`;
}
