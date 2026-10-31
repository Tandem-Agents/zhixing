import { expect, it } from "vitest";
import { currentLogPhaseRefs, observeLogPhase } from "../../logging/phase.js";
import { runDetachedMaintenanceContext } from "../maintenance-context.js";

// 转交后台续跑的工作不记在发起它的前台阶段名下；退出后调用者自己的阶段照旧
it("runs detached maintenance outside the caller's log phase", async () => {
  const records = { record: () => {} };
  await observeLogPhase(records, "caller", async () => {
    expect(currentLogPhaseRefs().some((ref) => ref.kind === "phase")).toBe(true);
    const inside = await runDetachedMaintenanceContext("background", async () => currentLogPhaseRefs());
    expect(inside).toEqual([]);
    expect(currentLogPhaseRefs().some((ref) => ref.kind === "phase")).toBe(true);
  });
});
