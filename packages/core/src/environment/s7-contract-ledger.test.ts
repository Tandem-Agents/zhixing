import { describe, expect, it } from "vitest";
import {
  runInMaintenanceContext,
  storageMaintenanceRequest,
} from "../resources/index.js";
import { S7_DURABLE_CONTRACT_LEDGER } from "./s7-contract-ledger.js";

describe("S7 durable contract ledger", () => {
  it("is a finite one-owner inventory with executable recovery classifications", () => {
    const expected = [
      "legacy-workscene-migration",
      "session-activity",
      "workscene-activity-projection",
      "workscene-registry",
      "workspace-binding",
      "workspace-binding-root",
      "workspace-probe",
    ];
    expect(
      S7_DURABLE_CONTRACT_LEDGER.map(({ recordFamily }) => recordFamily).sort(),
    ).toEqual(expected);
    for (const entry of S7_DURABLE_CONTRACT_LEDGER) {
      expect(entry.producer).not.toBe("");
      expect(entry.recoveryOwner).not.toBe("");
      expect(entry.resourceIdentity).not.toBe("");
      expect(entry.variants.length).toBeGreaterThan(0);
      expect(entry.rejectionBranches.length).toBeGreaterThan(0);
      expect(entry.corruptionVectors.length).toBeGreaterThan(0);
    }
    expect(
      S7_DURABLE_CONTRACT_LEDGER.filter(
        ({ recordFamily }) => recordFamily === "workspace-binding-root",
      ),
    ).toHaveLength(1);
  });

  it("binds catalog reset to its dedicated committed storage class", () => {
    const request = runInMaintenanceContext("foreground", () =>
      storageMaintenanceRequest(
        "workspace-catalog-reset",
        "device-root",
        {
          previousCatalogGeneration: "catalog-a",
          catalogGeneration: "catalog-b",
        },
        { obligation: "committed" },
      ),
    );
    expect(request).toMatchObject({
      kind: "workspace-catalog-reset",
      obligation: "committed",
      urgency: "foreground",
    });
  });

  it("freezes every reset and activity state that must remain mutation-sensitive", () => {
    const byFamily = new Map(
      S7_DURABLE_CONTRACT_LEDGER.map((entry) => [
        entry.recordFamily,
        entry,
      ]),
    );
    expect(byFamily.get("workspace-binding")?.variants).toContain(
      "catalog-reset",
    );
    expect(byFamily.get("workspace-binding-root")?.variants).toEqual([
      "healthy",
      "degraded",
      "pending-reset",
    ]);
    expect(byFamily.get("session-activity")?.variants).toEqual([
      "put",
      "tombstone",
    ]);
    expect(
      byFamily.get("legacy-workscene-migration")?.variants,
    ).toEqual(["open", "activated", "abandoned"]);
    expect(byFamily.get("workscene-activity-projection")?.variants).toEqual([
      "put",
      "tombstone",
    ]);
    expect(byFamily.get("session-activity")?.producer).toBe(
      "ConversationRunJournal",
    );
  });
});
