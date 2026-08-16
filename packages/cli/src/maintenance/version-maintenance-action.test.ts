import { describe, expect, it } from "vitest";
import {
  formatVersionMaintenanceAction,
  type VersionMaintenanceActionTarget,
} from "./version-maintenance-action.js";

describe("formatVersionMaintenanceAction", () => {
  const steps =
    "先运行 zz stop --maintenance；成功后运行 npm install -g @zhixing/cli@latest；再运行 zz，然后重试原操作";

  it("formats the complete action for this device", () => {
    expect(formatVersionMaintenanceAction({ kind: "local-device" })).toBe(
      `请在这台设备完成以下步骤：${steps}`,
    );
  });

  it("preserves peer order and duplicate public names", () => {
    expect(formatVersionMaintenanceAction({
      kind: "peer-devices",
      displayNames: ["书房电脑", "书房电脑", "客厅电脑"],
    })).toBe(`请分别在 书房电脑、书房电脑、客厅电脑 完成以下步骤：${steps}`);
  });

  it("rejects an empty peer target at runtime", () => {
    const invalid = {
      kind: "peer-devices",
      displayNames: [],
    } as unknown as VersionMaintenanceActionTarget;
    expect(() => formatVersionMaintenanceAction(invalid)).toThrow("维护目标设备不能为空");
  });
});
