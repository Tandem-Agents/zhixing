import { describe, expect, it } from "vitest";
import { createTempDir } from "@zhixing/test-utils";
import {
  TrustAdministrationExecutionApplicationService,
} from "../../trust-administration/application.js";
import { PermissionStore } from "../permission-store.js";
import { createPermissionStoreTrustAdministrationRepository } from "../trust-administration-adapter.js";

describe("PermissionStore Trust Administration final mechanism", () => {
  it("persists context/global rules, keeps session rules in-memory, and supports management revoke", async () => {
    const rootDir = await createTempDir("trust-final-mechanism");
    const store = new PermissionStore({ rootDir });
    const repository = createPermissionStoreTrustAdministrationRepository(
      () => store,
    );
    let id = 0;
    const application = new TrustAdministrationExecutionApplicationService({
      repository,
      workspacePath: "/workspace",
      createRuleId: () => `rule-${++id}`,
      now: () => 100 + id,
    });
    const pattern = application.suggest({
      tool: "bash",
      arguments: { command: "npm install package" },
    })[1]!;

    application.recordApproval({ kind: "allow-session", pattern });
    application.recordApproval({ kind: "allow-context", pattern });
    application.recordApproval({ kind: "allow-global", pattern });
    expect(application.securitySnapshot().userRules.map((rule) => rule.scope)).toEqual([
      "session",
      "context",
      "global",
    ]);

    const restartedStore = new PermissionStore({ rootDir });
    const restartedRepository = createPermissionStoreTrustAdministrationRepository(
      () => restartedStore,
    );
    const restarted = new TrustAdministrationExecutionApplicationService({
      repository: restartedRepository,
      workspacePath: "/workspace",
    });
    expect(restarted.securitySnapshot().userRules.map((rule) => rule.scope)).toEqual([
      "context",
      "global",
    ]);
    expect(restarted.securitySnapshot().userRules[0]).toMatchObject({
      contextId: restarted.context,
      contextPath: "/workspace",
      contributors: [{ origin: "user" }],
    });

    await expect(
      restartedRepository.revoke(restarted.context, "rule-2"),
    ).resolves.toBe(true);
    const afterRevoke = new TrustAdministrationExecutionApplicationService({
      repository: createPermissionStoreTrustAdministrationRepository(
        () => new PermissionStore({ rootDir }),
      ),
      workspacePath: "/workspace",
    });
    expect(afterRevoke.securitySnapshot().userRules).toMatchObject([
      { id: "rule-3", scope: "global" },
    ]);
  });
});
