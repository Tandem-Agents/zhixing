import { describe, expect, it } from "vitest";
import { currentMaintenanceUrgency } from "@zhixing/core/resources";
import { AuthorityCheckpointOwner } from "../checkpoint-owner.js";
import type { AuthorityCheckpointService } from "../checkpoint-service.js";

/** 只记录每一步看到的紧急度：每日义务不应与用户正在做的事争前台资源。 */
function recordingService(gate?: Promise<void>) {
  const seen: string[] = [];
  const service = {
    candidateKey: (request: { kind: string }) => request.kind === "daily" ? "daily:2026-11-02" : "forced",
    recoverPending: async () => { seen.push(`recover:${currentMaintenanceUrgency()}`); },
    createAndReplicate: async () => {
      seen.push(`create:${currentMaintenanceUrgency()}`);
      await gate;
      seen.push(`create-after-wait:${currentMaintenanceUrgency()}`);
      return { envelope: { checkpointId: "checkpoint" } };
    },
    cleanupExpired: async () => { seen.push(`cleanup:${currentMaintenanceUrgency()}`); },
  } as unknown as AuthorityCheckpointService;
  return { seen, service };
}

describe("恢复备份义务的紧急度", () => {
  it("每日备份整段按后台运行，显式强制备份按前台", async () => {
    const daily = recordingService();
    const owner = new AuthorityCheckpointOwner({ service: daily.service, identitySeed: "seed", clock: () => new Date("2026-11-02T00:00:00.000Z") });
    await owner.start(false);
    await owner.ensureDaily();
    expect(daily.seen).toEqual(["recover:background", "create:background", "create-after-wait:background", "cleanup:background"]);

    const forced = recordingService();
    const explicit = new AuthorityCheckpointOwner({ service: forced.service, identitySeed: "seed" });
    await explicit.start(false);
    await explicit.force("setup");
    expect(forced.seen).toEqual(["recover:foreground", "create:foreground", "create-after-wait:foreground", "cleanup:foreground"]);
  });

  it("有人显式等着同一份检查点时，进行中的义务提到前台", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const shared = recordingService(gate);
    // 两种请求取同一候选键，模拟显式等待者并入正在进行的同一份检查点
    (shared.service as unknown as { candidateKey: () => string }).candidateKey = () => "same";
    const owner = new AuthorityCheckpointOwner({ service: shared.service, identitySeed: "seed", clock: () => new Date("2026-11-02T00:00:00.000Z") });
    await owner.start(false);
    const running = owner.ensureDaily();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const joined = owner.force("waiting-user");
    release();
    await Promise.all([running, joined]);
    expect(shared.seen).toContain("create:background");
    expect(shared.seen).toContain("create-after-wait:foreground");
  });
});
