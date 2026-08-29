import { describe, expect, it } from "vitest";
import {
  UnsupportedServeRoleConfigurationError,
  planServeTopology,
} from "../role-topology.js";

describe("serve role topology", () => {
  it("derives topology from the role set without a second mode flag", () => {
    expect(planServeTopology({ roles: [] })).toEqual({
      host: "disabled",
      loadExecutor: false,
      activeCleanupOwners: [],
    });
    expect(planServeTopology({ roles: ["surface"] })).toEqual({
      host: "disabled",
      loadExecutor: false,
      activeCleanupOwners: [],
    });
    expect(planServeTopology({ roles: ["anchor", "executor"] })).toEqual({
      host: "anchor-host",
      loadExecutor: true,
      activeCleanupOwners: ["anchor-host", "anchor-local-executor"],
    });
    expect(planServeTopology({ roles: ["executor", "anchor"] })).toEqual({
      host: "anchor-host",
      loadExecutor: true,
      activeCleanupOwners: ["anchor-host", "anchor-local-executor"],
    });
    expect(planServeTopology({ roles: ["anchor"] })).toEqual({
      host: "anchor-host",
      loadExecutor: false,
      activeCleanupOwners: ["anchor-host"],
    });
    expect(planServeTopology({ roles: ["executor"] })).toEqual({
      host: "executor-host",
      loadExecutor: true,
      activeCleanupOwners: [],
    });
  });

  it.each([
    { roles: [], host: "disabled", localOwner: "none", cleanup: [] },
    { roles: ["surface"], host: "disabled", localOwner: "none", cleanup: [] },
    { roles: ["anchor"], host: "anchor-host", localOwner: "none", cleanup: ["anchor-host"] },
    { roles: ["anchor", "surface"], host: "anchor-host", localOwner: "none", cleanup: ["anchor-host"] },
    { roles: ["executor"], host: "executor-host", localOwner: "executor-role-runtime", cleanup: [] },
    { roles: ["executor", "surface"], host: "executor-host", localOwner: "executor-role-runtime", cleanup: [] },
    { roles: ["anchor", "executor"], host: "anchor-host", localOwner: "access-surfaces", cleanup: ["anchor-host", "anchor-local-executor"] },
    { roles: ["anchor", "executor", "surface"], host: "anchor-host", localOwner: "access-surfaces", cleanup: ["anchor-host", "anchor-local-executor"] },
  ] as const)(
    "binds local owner and cleanup exact-set for $roles",
    ({ roles, host, localOwner, cleanup }) => {
      const plan = planServeTopology({ roles });
      expect(plan.host).toBe(host);
      expect(plan.activeCleanupOwners).toEqual(cleanup);
      expect(
        plan.host === "executor-host"
          ? "executor-role-runtime"
          : plan.host === "anchor-host" && plan.loadExecutor
            ? "access-surfaces"
            : "none",
      ).toBe(localOwner);
    },
  );

  it.each([
    { roles: ["anchor", "anchor"] as const },
    { roles: ["unknown"] as never },
  ])("rejects unsupported role set $roles", ({ roles }) => {
    expect(() => planServeTopology({ roles })).toThrow(
      UnsupportedServeRoleConfigurationError,
    );
  });
});
