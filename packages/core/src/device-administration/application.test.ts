import { describe, expect, it, vi } from "vitest";
import { ProductApiDispatcher } from "../product-api/catalog.js";
import {
  createDeviceAdministrationProductApiContribution,
  DEVICE_ADMINISTRATION_BEGIN_CURRENT_REMOVAL_COMMAND,
  DEVICE_ADMINISTRATION_BEGIN_REMOVAL_COMMAND,
  DEVICE_ADMINISTRATION_CANCEL_CURRENT_REMOVAL_COMMAND,
  DEVICE_ADMINISTRATION_CANCEL_DUTY_MIGRATION_COMMAND,
  DEVICE_ADMINISTRATION_COMMIT_DUTY_MIGRATION_COMMAND,
  DEVICE_ADMINISTRATION_CONTINUE_CURRENT_REMOVAL_COMMAND,
  DEVICE_ADMINISTRATION_CONTINUE_REMOVAL_COMMAND,
  DEVICE_ADMINISTRATION_CURRENT_REMOVAL_PREFLIGHT_QUERY,
  DEVICE_ADMINISTRATION_CURRENT_REMOVAL_STATUS_QUERY,
  DEVICE_ADMINISTRATION_DUTY_MIGRATION_TARGETS_QUERY,
  DEVICE_ADMINISTRATION_LIST_QUERY,
  DEVICE_ADMINISTRATION_PREPARE_DUTY_MIGRATION_COMMAND,
  DEVICE_ADMINISTRATION_PRODUCT_API_EXACT_SET,
  DEVICE_ADMINISTRATION_STATUS_QUERY,
  DeviceAdministrationApplicationService,
  DeviceAdministrationCurrentRemovalMigrationApplicationService,
  DeviceAdministrationCurrentRemovalRecoveryApplicationService,
} from "./application.js";

function fixture() {
  const relationships = {
    list: vi.fn(async () => [
      { displayName: "书房设备", reachable: true },
    ]),
  };
  const removalState = {
    read: vi.fn(async () => ({
      phase: "moving-conversations" as const,
      conversations: ["conv-main"],
      localData: "known" as const,
      credentialActions: ["等待设备完成清理"],
    })),
  };
  const dutyMigrationTargets = {
    list: vi.fn(async () => [
      { deviceId: "device-2", displayName: "客厅主机", ready: false, code: "unavailable" as const },
    ]),
  };
  const removalContext = {
    read: vi.fn(() => ({
      localDeviceId: "device-duty",
      currentDutyDeviceId: "device-duty",
      members: [
        { deviceId: "device-duty", displayName: "值班设备", state: "active" as const },
        { deviceId: "device-target", displayName: "书房设备", state: "active" as const },
      ],
    })),
  };
  const removalAuthority = {
    acceptForTarget: vi.fn(async () => "accepted-token"),
    operation: vi.fn(async () => ({
      operationId: "operation-1",
      targetDeviceId: "device-target",
    })),
    operationForTarget: vi.fn(async () => ({
      operationId: "operation-1",
      targetDeviceId: "device-target",
    })),
    abort: vi.fn(async () => "abort-token"),
    commitLost: vi.fn(async () => undefined),
  };
  const removalEffects = {
    isConnected: vi.fn(() => true),
    accept: vi.fn(async () => ({ conversations: ["conv-main"], hasAcceptedWork: true })),
    abort: vi.fn(async () => removalPublicState("cancelled")),
    decide: vi.fn(async () => removalPublicState("moving-conversations")),
  };
  const dutyMigrationContext = {
    read: vi.fn(() => ({
      localDeviceId: "device-duty",
      currentDutyDeviceId: "device-duty",
      currentOwnerReady: true,
      deviceRemovalInProgress: false,
      members: [
        { deviceId: "device-duty", state: "active" as const, dutyCapable: true },
        { deviceId: "device-target", state: "active" as const, dutyCapable: true },
      ],
    })),
  };
  const dutyMigration = {
    prepare: vi.fn(async () => undefined),
    commit: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
  };
  const currentRemovalContext = {
    read: vi.fn(async () => ({
      localDeviceId: "device-duty",
      currentDutyDeviceId: "device-duty",
      localIssuerKeyId: "key-duty",
      currentDutyIssuerKeyId: "key-duty",
      currentDeviceName: "当前设备",
      executorRemovalInProgress: false,
    })),
  };
  const currentRemovalMigrationTargets = {
    list: vi.fn(async () => [
      { deviceId: "device-backup", displayName: "备用设备", ready: true },
    ]),
  };
  const currentRemovalRecovery = {
    readiness: vi.fn(async () => ({
      state: "pending-verification" as const,
      fullBackupReady: false,
    })),
    begin: vi.fn(async () => ({
      kind: "current-device-removal" as const,
      path: "recovery-backup" as const,
      phase: "checkpoint-verified" as const,
    })),
    confirm: vi.fn(async () => ({
      kind: "current-device-removal" as const,
      path: "recovery-backup" as const,
      phase: "retirement-decided" as const,
    })),
    resumeActive: vi.fn(async () => []),
  };
  const currentRemovalMigration = {
    begin: vi.fn(async () => ({
      kind: "current-device-removal" as const,
      path: "migration" as const,
      phase: "gate-frozen" as const,
    })),
    resumeActive: vi.fn(async () => []),
  };
  const currentDeviceRemoval = {
    abort: vi.fn(async () => ({
      kind: "current-device-removal" as const,
      path: "recovery-backup" as const,
      phase: "aborted" as const,
    })),
    read: vi.fn(async () => ({
      kind: "current-device-removal" as const,
      path: "recovery-backup" as const,
      phase: "accepted" as const,
    })),
  };
  const application = new DeviceAdministrationApplicationService({
    relationships,
    removalState,
    dutyMigrationTargets,
    removalContext,
    removalAuthority,
    removalEffects,
    dutyMigrationContext,
    dutyMigration,
    currentRemovalContext,
    currentRemovalMigrationTargets,
    currentRemovalRecovery,
    currentRemovalMigration,
    currentDeviceRemoval,
  });
  return {
    application,
    relationships,
    removalState,
    dutyMigrationTargets,
    removalContext,
    removalAuthority,
    removalEffects,
    dutyMigrationContext,
    dutyMigration,
    currentRemovalContext,
    currentRemovalMigrationTargets,
    currentRemovalRecovery,
    currentRemovalMigration,
    currentDeviceRemoval,
  };
}

describe("DeviceAdministrationCurrentRemovalMigrationApplicationService", () => {
  it("owns the complete migration phase order for both first execution and durable replay", async () => {
    const events: string[] = [];
    const lifecycle = migrationLifecycle(events);
    const effects = migrationEffects(events);
    const application = new DeviceAdministrationCurrentRemovalMigrationApplicationService({
      lifecycle,
      effects,
    });

    await expect(application.begin({
      requestId: "request:migration",
      operationId: "operation:migration",
      transferId: "transfer:migration",
      targetDeviceId: "device:successor",
    })).resolves.toEqual({
      kind: "current-device-removal",
      path: "migration",
      phase: "terminal",
    });
    expect(events).toEqual([
      "accept",
      "close-admission",
      "close-accepted-work",
      "freeze",
      "advance:gate-frozen",
      "settle:drain:30000",
      "flush",
      "physical",
      "commit",
      "verify",
      "advance:transfer-committed",
      "retire",
      "advance:cleanup-complete",
      "terminal",
    ]);
    expect(lifecycle.advance).toHaveBeenNthCalledWith(1, {
      operationId: "operation:migration",
      phase: "gate-frozen",
      evidence: ["frozen-evidence"],
    });
    expect(lifecycle.advance).toHaveBeenNthCalledWith(2, {
      operationId: "operation:migration",
      phase: "transfer-committed",
      evidence: ["flush-evidence", "transfer-evidence"],
    });
    expect(lifecycle.advance).toHaveBeenNthCalledWith(3, {
      operationId: "operation:migration",
      phase: "cleanup-complete",
      evidence: ["cleanup-evidence"],
    });
  });

  it("resumes every durable phase without repeating effects that the phase already proves", async () => {
    const cases = [
      ["gate-frozen", [
        "settle:drain:30000",
        "flush",
        "physical",
        "commit",
        "verify",
        "advance:transfer-committed",
        "retire",
        "advance:cleanup-complete",
        "terminal",
      ]],
      ["transfer-committed", ["retire", "advance:cleanup-complete", "terminal"]],
      ["cleanup-complete", ["terminal"]],
      ["terminal", []],
      ["aborted", []],
    ] as const;

    for (const [phase, expected] of cases) {
      const events: string[] = [];
      const lifecycle = migrationLifecycle(events, phase);
      const application = new DeviceAdministrationCurrentRemovalMigrationApplicationService({
        lifecycle,
        effects: migrationEffects(events),
      });
      await expect(application.resumeActive()).resolves.toEqual([{
        kind: "current-device-removal",
        path: "migration",
        phase: phase === "aborted" ? "aborted" : "terminal",
      }]);
      expect(events).toEqual(["active", ...expected]);
      expect(events).not.toContain("close-admission");
      expect(events).not.toContain("freeze");
    }
  });
});

function migrationOperation(
  phase: "accepted" | "gate-frozen" | "transfer-committed" | "cleanup-complete" |
    "terminal" | "aborted",
) {
  return {
    kind: "current-device-removal" as const,
    path: "migration" as const,
    requestId: "request:migration",
    operationId: "operation:migration",
    transferId: "transfer:migration",
    targetDeviceId: "device:successor",
    phase,
  };
}

function migrationLifecycle(
  events: string[],
  activePhase: Parameters<typeof migrationOperation>[0] = "accepted",
) {
  return {
    accept: vi.fn(async () => {
      events.push("accept");
      return migrationOperation("accepted");
    }),
    active: vi.fn(async () => {
      events.push("active");
      return [migrationOperation(activePhase)];
    }),
    advance: vi.fn(async (input: {
      readonly phase: "gate-frozen" | "transfer-committed" | "cleanup-complete";
    }) => {
      events.push(`advance:${input.phase}`);
      return migrationOperation(input.phase);
    }),
    terminal: vi.fn(async () => {
      events.push("terminal");
      return migrationOperation("terminal");
    }),
  };
}

function migrationEffects(events: string[]) {
  return {
    closeAdmission: vi.fn(async () => {
      events.push("close-admission");
    }),
    closeAcceptedWorkAdmission: vi.fn(async () => {
      events.push("close-accepted-work");
    }),
    freezeAcceptedWork: vi.fn(async () => {
      events.push("freeze");
      return "frozen-evidence";
    }),
    settleAcceptedWork: vi.fn(async (input: {
      readonly strategy: "drain";
      readonly timeoutMs: 30_000;
    }) => {
      events.push(`settle:${input.strategy}:${input.timeoutMs}`);
    }),
    flushDurableState: vi.fn(async () => {
      events.push("flush");
      return ["flush-evidence"];
    }),
    settlePhysicalSteps: vi.fn(async () => {
      events.push("physical");
    }),
    commitTransfer: vi.fn(async () => {
      events.push("commit");
    }),
    verifyTransfer: vi.fn(async () => {
      events.push("verify");
      return "transfer-evidence";
    }),
    retireLocalDevice: vi.fn(async () => {
      events.push("retire");
      return "cleanup-evidence";
    }),
  };
}

describe("DeviceAdministrationCurrentRemovalRecoveryApplicationService", () => {
  it("owns begin, confirmation and the complete recovery-removal phase order", async () => {
    const events: string[] = [];
    const fixture = recoveryFixture(events);

    await expect(fixture.application.begin({
      requestId: "request:recovery",
      operationId: "operation:recovery",
      recoveryPackage: "package",
    })).resolves.toEqual({
      kind: "current-device-removal",
      path: "recovery-backup",
      phase: "checkpoint-verified",
    });
    expect(events).toEqual([
      "assert-begin",
      "backup-begin",
      "accept",
      "close-admission",
      "advance:gate-frozen",
      "checkpoint:operation:recovery:pre-retirement:initial",
      "advance:checkpoint-verified",
    ]);

    events.length = 0;
    await expect(fixture.application.confirm({
      operationId: "operation:recovery",
      recoveryPackage: "package",
    })).resolves.toEqual({
      kind: "current-device-removal",
      path: "recovery-backup",
      phase: "terminal",
    });
    expect(events).toEqual([
      "state",
      "assert-authority",
      "backup-confirm",
      "close-accepted-work",
      "freeze",
      "retirement",
      "restore",
      "advance:gate-closed",
      "settle:immediate:30000",
      "advance:work-settled",
      "flush",
      "physical",
      "advance:flushed",
      "phase-lsn",
      "checkpoint:operation:recovery:final-retirement:17",
      "advance:final-checkpoint-verified",
      "cleanup",
      "advance:cleanup-complete",
      "terminal",
      "retired",
    ]);
    expect(fixture.lifecycle.commitRetirement).toHaveBeenCalledWith({
      operationId: "operation:recovery",
      acceptedWork: "accepted-work",
    });
  });

  it("restores gates at every durable phase but only resumes automatic cleanup terminals", async () => {
    const cases = [
      ["accepted", ["active", "close-admission", "advance:gate-frozen"]],
      ["gate-frozen", ["active", "close-admission"]],
      ["checkpoint-verified", ["active", "close-admission"]],
      ["retirement-decided", [
        "active", "close-admission", "close-accepted-work", "restore",
      ]],
      ["gate-closed", ["active", "close-admission", "close-accepted-work", "restore"]],
      ["work-settled", ["active", "close-admission", "close-accepted-work", "restore"]],
      ["flushed", ["active", "close-admission", "close-accepted-work", "restore"]],
      ["final-checkpoint-verified", [
        "active",
        "close-admission",
        "close-accepted-work",
        "restore",
        "cleanup",
        "advance:cleanup-complete",
        "terminal",
        "retired",
      ]],
      ["cleanup-complete", [
        "active",
        "close-admission",
        "close-accepted-work",
        "restore",
        "terminal",
        "retired",
      ]],
    ] as const;
    for (const [phase, expected] of cases) {
      const events: string[] = [];
      const fixture = recoveryFixture(events, phase);
      await fixture.application.resumeActive();
      expect(events).toEqual(expected);
      expect(events.some((event) => event.startsWith("checkpoint:"))).toBe(false);
    }
  });
});

type RecoveryPhase = ReturnType<typeof recoveryOperation>["phase"];

function recoveryOperation(phase:
  | "accepted"
  | "gate-frozen"
  | "checkpoint-verified"
  | "retirement-decided"
  | "gate-closed"
  | "work-settled"
  | "flushed"
  | "final-checkpoint-verified"
  | "cleanup-complete"
  | "terminal"
  | "aborted") {
  return {
    kind: "current-device-removal" as const,
    path: "recovery-backup" as const,
    requestId: "request:recovery",
    operationId: "operation:recovery",
    binding: {
      homeId: "home",
      anchorEpoch: 1,
      trustHeadDigest: "trust",
      checkpointTargetId: "target",
      checkpointGeneration: "generation",
    },
    phase,
  };
}

function recoveryFixture(events: string[], initial: RecoveryPhase = "accepted") {
  let operation = recoveryOperation(initial);
  const permit = {
    binding: operation.binding,
    verifyCheckpoint: vi.fn(async (input: {
      readonly requestId: string;
      readonly minimumUpToLsn?: number;
    }) => {
      events.push(`checkpoint:${input.requestId}:${input.minimumUpToLsn ?? "initial"}`);
      return "checkpoint-evidence";
    }),
  };
  const backup = {
    readiness: vi.fn(async () => ({
      state: "recoverable" as const,
      fullBackupReady: true,
    })),
    prepareBegin: vi.fn(async () => {
      events.push("backup-begin");
      return permit;
    }),
    prepareConfirm: vi.fn(async () => {
      events.push("backup-confirm");
      return permit;
    }),
  };
  const lifecycle = {
    assertBeginAdmission: vi.fn(async () => {
      events.push("assert-begin");
    }),
    assertCurrentAuthority: vi.fn(async () => {
      events.push("assert-authority");
    }),
    accept: vi.fn(async () => {
      events.push("accept");
      operation = recoveryOperation("accepted");
      return operation;
    }),
    state: vi.fn(async () => {
      events.push("state");
      return operation;
    }),
    active: vi.fn(async () => {
      events.push("active");
      return [operation];
    }),
    advance: vi.fn(async (input: { readonly phase: RecoveryPhase }) => {
      events.push(`advance:${input.phase}`);
      operation = recoveryOperation(input.phase);
      return operation;
    }),
    commitRetirement: vi.fn(async () => {
      events.push("retirement");
      operation = recoveryOperation("retirement-decided");
      return operation;
    }),
    phaseLsn: vi.fn(async () => {
      events.push("phase-lsn");
      return 17;
    }),
    terminal: vi.fn(async () => {
      events.push("terminal");
      operation = recoveryOperation("terminal");
      return operation;
    }),
  };
  const effects = {
    closeAdmission: vi.fn(async () => {
      events.push("close-admission");
      return "admission-evidence";
    }),
    closeAcceptedWorkAdmission: vi.fn(async () => {
      events.push("close-accepted-work");
    }),
    freezeAcceptedWork: vi.fn(async () => {
      events.push("freeze");
      return "accepted-work";
    }),
    restoreAcceptedWork: vi.fn(async () => {
      events.push("restore");
    }),
    settleAcceptedWork: vi.fn(async (input: {
      readonly strategy: "immediate";
      readonly timeoutMs: 30_000;
    }) => {
      events.push(`settle:${input.strategy}:${input.timeoutMs}`);
      return "settlement-evidence";
    }),
    flushDurableState: vi.fn(async () => {
      events.push("flush");
      return ["flush-evidence"];
    }),
    settlePhysicalSteps: vi.fn(async () => {
      events.push("physical");
    }),
    cleanup: vi.fn(async () => {
      events.push("cleanup");
      return ["cleanup-evidence"];
    }),
    onRetired: vi.fn(async () => {
      events.push("retired");
    }),
  };
  return {
    application: new DeviceAdministrationCurrentRemovalRecoveryApplicationService({
      backup,
      lifecycle,
      effects,
    }),
    lifecycle,
  };
}

describe("DeviceAdministrationApplicationService", () => {
  it("owns the finite user-visible read projections and freezes returned values", async () => {
    const f = fixture();

    const devices = await f.application.query({ kind: "list-device-relationships" });
    const state = await f.application.query({
      kind: "read-device-removal-state",
      targetName: "书房设备",
    });
    const targets = await f.application.query({ kind: "list-duty-migration-targets" });

    expect(devices).toEqual({ devices: [{ displayName: "书房设备", reachable: true }] });
    expect(state).toEqual({
      state: {
        phase: "moving-conversations",
        conversations: ["conv-main"],
        localData: "known",
        credentialActions: ["等待设备完成清理"],
      },
    });
    expect(targets).toEqual({
      devices: [{
        deviceId: "device-2",
        displayName: "客厅主机",
        ready: false,
        code: "unavailable",
      }],
    });
    expect(Object.isFrozen(devices.devices)).toBe(true);
    expect(Object.isFrozen(state.state?.conversations)).toBe(true);
    expect(Object.isFrozen(targets.devices[0])).toBe(true);
    expect(f.removalState.read).toHaveBeenCalledWith("书房设备");
  });

  it("projects missing durable removal state as null and rejects an invalid identity", async () => {
    const f = fixture();
    f.removalState.read.mockResolvedValueOnce(undefined);
    await expect(f.application.query({
      kind: "read-device-removal-state",
      targetName: "书房设备",
    })).resolves.toEqual({ state: null });
    await expect(f.application.query({
      kind: "read-device-removal-state",
      targetName: "",
    })).rejects.toThrow("Device name must be a non-empty string");
  });

  it("contributes exactly five Query and eight Command operations with no Fact event", async () => {
    const f = fixture();
    const dispatcher = new ProductApiDispatcher(
      DEVICE_ADMINISTRATION_PRODUCT_API_EXACT_SET,
      [createDeviceAdministrationProductApiContribution(f.application)],
    );

    await expect(dispatcher.query(DEVICE_ADMINISTRATION_LIST_QUERY, {
      kind: "list-device-relationships",
    })).resolves.toEqual({ devices: [{ displayName: "书房设备", reachable: true }] });
    await expect(dispatcher.query(DEVICE_ADMINISTRATION_STATUS_QUERY, {
      kind: "read-device-removal-state",
      targetName: "书房设备",
    })).resolves.toMatchObject({ state: { phase: "moving-conversations" } });
    await expect(dispatcher.query(DEVICE_ADMINISTRATION_DUTY_MIGRATION_TARGETS_QUERY, {
      kind: "list-duty-migration-targets",
    })).resolves.toMatchObject({ devices: [{ deviceId: "device-2" }] });
    await expect(dispatcher.query(DEVICE_ADMINISTRATION_CURRENT_REMOVAL_PREFLIGHT_QUERY, {
      kind: "preflight-current-device-removal",
    })).resolves.toMatchObject({ currentDeviceName: "当前设备" });
    await expect(dispatcher.query(DEVICE_ADMINISTRATION_CURRENT_REMOVAL_STATUS_QUERY, {
      kind: "read-current-device-removal-status",
      operationId: "uninstall-1",
    })).resolves.toMatchObject({ state: { phase: "choose-safe-path" } });
    await expect(dispatcher.command(DEVICE_ADMINISTRATION_BEGIN_REMOVAL_COMMAND, {
      kind: "begin-device-removal",
      requestId: "request-1",
      operationId: "operation-1",
      targetName: "书房设备",
    })).resolves.toMatchObject({ result: { conversations: ["conv-main"] }, facts: [] });
    await expect(dispatcher.command(DEVICE_ADMINISTRATION_CONTINUE_REMOVAL_COMMAND, {
      kind: "continue-device-removal",
      targetName: "书房设备",
      mode: "transfer",
    })).resolves.toMatchObject({ result: { phase: "moving-conversations" }, facts: [] });
    await expect(dispatcher.command(DEVICE_ADMINISTRATION_PREPARE_DUTY_MIGRATION_COMMAND, {
      kind: "prepare-duty-migration",
      requestId: "request:migration-1",
      transferId: "transfer-1",
      targetDeviceId: "device-target",
    })).resolves.toEqual({ result: { stage: "ready" }, facts: [] });
    await expect(dispatcher.command(DEVICE_ADMINISTRATION_COMMIT_DUTY_MIGRATION_COMMAND, {
      kind: "commit-duty-migration",
      requestId: "request:migration-1",
      transferId: "transfer-1",
    })).resolves.toEqual({ result: { stage: "completed" }, facts: [] });
    await expect(dispatcher.command(DEVICE_ADMINISTRATION_CANCEL_DUTY_MIGRATION_COMMAND, {
      kind: "cancel-duty-migration",
      requestId: "request:migration-1",
      transferId: "transfer-1",
    })).resolves.toEqual({ result: { stage: "cancelled" }, facts: [] });
    await expect(dispatcher.command(DEVICE_ADMINISTRATION_BEGIN_CURRENT_REMOVAL_COMMAND, {
      kind: "begin-current-device-removal",
      path: "migration",
      requestId: "request:uninstall-1",
      operationId: "uninstall-1",
      transferId: "transfer-1",
      targetName: "备用设备",
    })).resolves.toMatchObject({ result: { phase: "moving-duty-device" }, facts: [] });
    await expect(dispatcher.command(DEVICE_ADMINISTRATION_CONTINUE_CURRENT_REMOVAL_COMMAND, {
      kind: "continue-current-device-removal",
      operationId: "uninstall-1",
      confirmBackup: true,
      recoveryPackage: "recovery-package",
    })).resolves.toEqual({
      result: { phase: "retiring-device", nextAction: "continue" },
      facts: [],
    });
    await expect(dispatcher.command(DEVICE_ADMINISTRATION_CANCEL_CURRENT_REMOVAL_COMMAND, {
      kind: "cancel-current-device-removal",
      operationId: "uninstall-1",
    })).resolves.toEqual({ result: { phase: "cancelled" }, facts: [] });
    expect(DEVICE_ADMINISTRATION_PRODUCT_API_EXACT_SET.factEvents).toEqual([]);
    expect(DEVICE_ADMINISTRATION_PRODUCT_API_EXACT_SET.operations.map(({ identity }) => identity))
      .toEqual([
        "device-administration.query.list",
        "device-administration.query.removal-status",
        "device-administration.query.duty-migration-targets",
        "device-administration.query.current-removal-preflight",
        "device-administration.query.current-removal-status",
        "device-administration.command.begin-removal",
        "device-administration.command.continue-removal",
        "device-administration.command.prepare-duty-migration",
        "device-administration.command.commit-duty-migration",
        "device-administration.command.cancel-duty-migration",
        "device-administration.command.begin-current-removal",
        "device-administration.command.continue-current-removal",
        "device-administration.command.cancel-current-removal",
      ]);
  });

  it("owns both current-device removal paths and returns frozen mechanism projections", async () => {
    const f = fixture();

    const preflight = await f.application.query({ kind: "preflight-current-device-removal" });
    const status = await f.application.query({
      kind: "read-current-device-removal-status",
      operationId: "uninstall-1",
    });
    expect(Object.isFrozen(preflight)).toBe(true);
    expect(preflight).toEqual({
      currentDeviceName: "当前设备",
      migrationTargets: [{ displayName: "备用设备", ready: true }],
      recoveryBackupReady: false,
    });
    expect(Object.isFrozen(preflight.migrationTargets)).toBe(true);
    expect(Object.isFrozen(preflight.migrationTargets[0])).toBe(true);
    expect(Object.isFrozen(status.state)).toBe(true);
    f.currentDeviceRemoval.read.mockResolvedValueOnce(undefined);
    await expect(f.application.query({
      kind: "read-current-device-removal-status",
      operationId: "uninstall-missing",
    })).resolves.toEqual({ state: null });

    await f.application.execute({
      kind: "begin-current-device-removal",
      path: "migration",
      requestId: "request:uninstall-migration",
      operationId: "uninstall-migration",
      transferId: "transfer-1",
      targetName: "备用设备",
    });
    await f.application.execute({
      kind: "begin-current-device-removal",
      path: "recovery-backup",
      requestId: "request:uninstall-backup",
      operationId: "uninstall-backup",
      recoveryPackage: "recovery-package",
    });
    expect(f.currentRemovalMigration.begin).toHaveBeenCalledWith({
      requestId: "request:uninstall-migration",
      operationId: "uninstall-migration",
      transferId: "transfer-1",
      targetDeviceId: "device-backup",
    });
    expect(f.currentRemovalRecovery.begin).toHaveBeenCalledWith({
      requestId: "request:uninstall-backup",
      operationId: "uninstall-backup",
      recoveryPackage: "recovery-package",
    });
  });

  it("owns every current-removal lifecycle projection for both safe paths", async () => {
    const f = fixture();
    const cases = [
      ["migration", "accepted", { phase: "moving-duty-device", nextAction: "continue" }],
      ["migration", "gate-frozen", { phase: "moving-duty-device", nextAction: "continue" }],
      ["migration", "transfer-committed", {
        phase: "moving-duty-device",
        nextAction: "continue",
      }],
      ["migration", "cleanup-complete", {
        phase: "ready-to-uninstall",
        nextAction: "continue",
      }],
      ["migration", "terminal", { phase: "uninstalled" }],
      ["migration", "aborted", { phase: "cancelled" }],
      ["recovery-backup", "accepted", {
        phase: "choose-safe-path",
        nextAction: "continue",
      }],
      ["recovery-backup", "gate-frozen", {
        phase: "choose-safe-path",
        nextAction: "continue",
      }],
      ["recovery-backup", "checkpoint-verified", {
        phase: "backup-verified",
        nextAction: "confirm-backup",
      }],
      ["recovery-backup", "retirement-decided", {
        phase: "retiring-device",
        nextAction: "continue",
      }],
      ["recovery-backup", "gate-closed", {
        phase: "retiring-device",
        nextAction: "continue",
      }],
      ["recovery-backup", "work-settled", {
        phase: "retiring-device",
        nextAction: "continue",
      }],
      ["recovery-backup", "flushed", {
        phase: "retiring-device",
        nextAction: "continue",
      }],
      ["recovery-backup", "final-checkpoint-verified", {
        phase: "ready-to-uninstall",
        nextAction: "continue",
      }],
      ["recovery-backup", "cleanup-complete", {
        phase: "ready-to-uninstall",
        nextAction: "continue",
      }],
      ["recovery-backup", "terminal", { phase: "uninstalled" }],
      ["recovery-backup", "aborted", { phase: "cancelled" }],
    ] as const;

    for (const [path, phase, expected] of cases) {
      f.currentDeviceRemoval.read.mockResolvedValueOnce({
        kind: "current-device-removal",
        path,
        phase,
      });
      await expect(f.application.query({
        kind: "read-current-device-removal-status",
        operationId: `uninstall:${path}:${phase}`,
      })).resolves.toEqual({ state: expected });
    }

    f.currentDeviceRemoval.read.mockResolvedValueOnce({
      kind: "current-device-removal",
      path: "recovery-backup",
      phase: "transfer-committed",
    });
    await expect(f.application.query({
      kind: "read-current-device-removal-status",
      operationId: "uninstall:invalid-path-phase",
    })).rejects.toThrow("Current removal lifecycle phase does not match its path");
  });

  it("owns cancellation eligibility before invoking the durable abort mechanism", async () => {
    const f = fixture();
    f.currentDeviceRemoval.read.mockResolvedValueOnce(undefined);
    await expect(f.application.execute({
      kind: "cancel-current-device-removal",
      operationId: "uninstall-unknown",
    })).rejects.toThrow("Anchor uninstall operation is unknown");

    for (const [path, phase, message] of [
      ["migration", "aborted", "Lifecycle aborted conflicts with replay"],
      ["migration", "terminal", "Terminal lifecycle operation cannot advance"],
      ["migration", "transfer-committed", "Irreversible lifecycle operation cannot be aborted"],
      ["recovery-backup", "retirement-decided", "Irreversible lifecycle operation cannot be aborted"],
    ] as const) {
      f.currentDeviceRemoval.read.mockResolvedValueOnce({
        kind: "current-device-removal",
        path,
        phase,
      });
      await expect(f.application.execute({
        kind: "cancel-current-device-removal",
        operationId: `uninstall:${phase}`,
      })).rejects.toThrow(message);
    }
    expect(f.currentDeviceRemoval.abort).not.toHaveBeenCalled();

    f.currentDeviceRemoval.read.mockResolvedValueOnce({
      kind: "current-device-removal",
      path: "migration",
      phase: "gate-frozen",
    });
    f.currentDeviceRemoval.abort.mockResolvedValueOnce({
      kind: "current-device-removal",
      path: "migration",
      phase: "aborted",
    });
    await expect(f.application.execute({
      kind: "cancel-current-device-removal",
      operationId: "uninstall:cancellable",
    })).resolves.toEqual({ phase: "cancelled" });
    expect(f.currentDeviceRemoval.abort).toHaveBeenCalledWith({
      operationId: "uninstall:cancellable",
    });

    f.currentDeviceRemoval.read.mockResolvedValueOnce({
      kind: "current-device-removal",
      path: "recovery-backup",
      phase: "checkpoint-verified",
    });
    f.currentDeviceRemoval.abort.mockResolvedValueOnce({
      kind: "current-device-removal",
      path: "recovery-backup",
      phase: "aborted",
    });
    await expect(f.application.execute({
      kind: "cancel-current-device-removal",
      operationId: "uninstall:backup-cancellable",
    })).resolves.toEqual({ phase: "cancelled" });
    expect(f.currentDeviceRemoval.abort).toHaveBeenNthCalledWith(2, {
      operationId: "uninstall:backup-cancellable",
    });
  });

  it("owns current authority, removal conflict, backup readiness and unique ready target selection", async () => {
    const f = fixture();
    f.currentRemovalRecovery.readiness.mockResolvedValueOnce({
      state: "recoverable",
      fullBackupReady: true,
      checkpointId: "checkpoint-1",
      targetId: "target-1",
      upToLsn: 42,
    });
    await expect(f.application.query({ kind: "preflight-current-device-removal" }))
      .resolves.toMatchObject({ recoveryBackupReady: true });

    f.currentRemovalContext.read.mockResolvedValueOnce({
      localDeviceId: "device-duty",
      currentDutyDeviceId: "device-duty",
      localIssuerKeyId: "key-duty",
      currentDutyIssuerKeyId: "key-duty",
      executorRemovalInProgress: false,
    });
    f.currentRemovalMigrationTargets.list.mockResolvedValueOnce([
      { deviceId: "device-z", displayName: "后序设备", ready: false },
      { deviceId: "device-a", displayName: "前序设备", ready: true },
    ]);
    await expect(f.application.query({ kind: "preflight-current-device-removal" }))
      .resolves.toEqual({
        currentDeviceName: "当前设备",
        migrationTargets: [
          { displayName: "后序设备", ready: false },
          { displayName: "前序设备", ready: true },
        ],
        recoveryBackupReady: false,
      });

    f.currentRemovalContext.read.mockResolvedValueOnce({
      localDeviceId: "device-local",
      currentDutyDeviceId: "device-other",
      localIssuerKeyId: "key-local",
      currentDutyIssuerKeyId: "key-other",
      executorRemovalInProgress: false,
    });
    await expect(f.application.query({ kind: "preflight-current-device-removal" }))
      .rejects.toThrow("Only the current duty device can uninstall itself");

    f.currentRemovalContext.read.mockResolvedValueOnce({
      localDeviceId: "device-duty",
      currentDutyDeviceId: "device-duty",
      localIssuerKeyId: "key-duty",
      currentDutyIssuerKeyId: "key-duty",
      currentDeviceName: "当前设备",
      executorRemovalInProgress: true,
    });
    await expect(f.application.query({ kind: "preflight-current-device-removal" }))
      .rejects.toThrow("Finish the current device removal before uninstalling this device");

    f.currentRemovalMigrationTargets.list.mockResolvedValueOnce([]);
    await expect(f.application.execute({
      kind: "begin-current-device-removal",
      path: "migration",
      requestId: "request:no-target",
      operationId: "uninstall-no-target",
      transferId: "transfer-no-target",
      targetName: "备用设备",
    })).rejects.toThrow("No ready duty device has that name");

    f.currentRemovalMigrationTargets.list.mockResolvedValueOnce([
      { deviceId: "device-a", displayName: "同名设备", ready: true },
      { deviceId: "device-b", displayName: "同名设备", ready: true },
    ]);
    await expect(f.application.execute({
      kind: "begin-current-device-removal",
      path: "migration",
      requestId: "request:ambiguous-target",
      operationId: "uninstall-ambiguous-target",
      transferId: "transfer-ambiguous-target",
      targetName: "同名设备",
    })).rejects.toThrow("More than one ready duty device has that name");
    expect(f.currentRemovalMigration.begin).not.toHaveBeenCalled();
  });

  it("fails closed when the current-device removal mechanism is unavailable", async () => {
    const f = fixture();
    const application = new DeviceAdministrationApplicationService({
      relationships: f.relationships,
      removalState: f.removalState,
      dutyMigrationTargets: f.dutyMigrationTargets,
      removalContext: f.removalContext,
      removalAuthority: f.removalAuthority,
      removalEffects: f.removalEffects,
      dutyMigrationContext: f.dutyMigrationContext,
      dutyMigration: f.dutyMigration,
    });

    await expect(application.query({ kind: "preflight-current-device-removal" }))
      .rejects.toMatchObject({
        name: "DeviceAdministrationApplicationError",
        kind: "current-device-removal-unavailable",
      });
    await expect(application.execute({
      kind: "cancel-current-device-removal",
      operationId: "uninstall-1",
    })).rejects.toMatchObject({ kind: "current-device-removal-unavailable" });
  });

  it("owns begin selection and only sends an accepted receipt to a connected target", async () => {
    const f = fixture();
    await expect(f.application.execute({
      kind: "begin-device-removal",
      requestId: "request-1",
      operationId: "operation-1",
      targetName: "书房设备",
    })).resolves.toEqual({ conversations: ["conv-main"], hasAcceptedWork: true });
    expect(f.removalAuthority.acceptForTarget).toHaveBeenCalledWith({
      requestId: "request-1",
      operationId: "operation-1",
      targetDeviceId: "device-target",
    });
    expect(f.removalEffects.accept).toHaveBeenCalledWith({
      targetDeviceId: "device-target",
      accepted: "accepted-token",
    });

    f.removalEffects.isConnected.mockReturnValueOnce(false);
    await expect(f.application.execute({
      kind: "begin-device-removal",
      requestId: "request-2",
      operationId: "operation-2",
      targetName: "书房设备",
    })).resolves.toEqual({ conversations: [], hasAcceptedWork: false });
    expect(f.removalEffects.accept).toHaveBeenCalledTimes(1);
  });

  it("fails closed for a non-duty caller, unknown target and current-duty self removal", async () => {
    const f = fixture();
    f.removalContext.read.mockReturnValueOnce({
      localDeviceId: "device-target",
      currentDutyDeviceId: "device-duty",
      members: [],
    });
    await expect(f.application.execute({
      kind: "begin-device-removal",
      requestId: "request-1",
      operationId: "operation-1",
      targetName: "书房设备",
    })).rejects.toThrow("Only the current duty device can remove a paired device");
    expect(f.removalAuthority.acceptForTarget).not.toHaveBeenCalled();

    await expect(f.application.execute({
      kind: "begin-device-removal",
      requestId: "request-2",
      operationId: "operation-2",
      targetName: "未知设备",
    })).rejects.toThrow("No active paired device has that name");

    await expect(f.application.execute({
      kind: "begin-device-removal",
      requestId: "request-3",
      operationId: "operation-3",
      targetName: "值班设备",
    })).rejects.toThrow("The current duty device cannot remove itself");
    expect(f.removalAuthority.acceptForTarget).not.toHaveBeenCalled();
  });

  it("owns transfer, lost and offline cancellation results without interpreting mechanism tokens", async () => {
    const f = fixture();
    await expect(f.application.execute({
      kind: "continue-device-removal",
      targetName: "书房设备",
      mode: "transfer",
    })).resolves.toMatchObject({ phase: "moving-conversations" });
    expect(f.removalEffects.decide).toHaveBeenCalledWith({
      targetDeviceId: "device-target",
      operationId: "operation-1",
      mode: "transfer",
      currentDutyDeviceId: "device-duty",
    });

    await expect(f.application.execute({
      kind: "continue-device-removal",
      targetName: "书房设备",
      mode: "lost",
    })).resolves.toEqual({
      phase: "removed",
      conversations: [],
      localData: "unknown",
      credentialActions: ["Change credentials for accounts used on this device"],
    });
    expect(f.removalAuthority.commitLost).toHaveBeenCalledWith("operation-1");

    f.removalEffects.isConnected.mockReturnValueOnce(false);
    await expect(f.application.execute({
      kind: "continue-device-removal",
      targetName: "书房设备",
      mode: "cancel",
    })).resolves.toEqual({
      phase: "waiting-for-device",
      conversations: [],
      localData: "known",
      credentialActions: ["取消已安全记录；目标设备上线后会自动恢复准入"],
    });
    expect(f.removalAuthority.abort).toHaveBeenCalledWith("operation-1");
    expect(f.removalEffects.abort).not.toHaveBeenCalled();
  });

  it("keeps exact cancellation replay and rejects ambiguous or mismatched identities", async () => {
    const f = fixture();
    f.removalAuthority.operation.mockResolvedValueOnce(undefined);
    await expect(f.application.execute({
      kind: "continue-device-removal",
      targetName: "书房设备",
      mode: "cancel",
      operationId: "operation-complete",
    })).resolves.toEqual(removalPublicState("cancelled"));

    f.removalContext.read.mockReturnValueOnce({
      localDeviceId: "device-duty",
      currentDutyDeviceId: "device-duty",
      members: [
        { deviceId: "device-a", displayName: "同名设备", state: "active" },
        { deviceId: "device-b", displayName: "同名设备", state: "active" },
      ],
    });
    await expect(f.application.execute({
      kind: "continue-device-removal",
      targetName: "同名设备",
      mode: "destroy",
    })).rejects.toThrow("Paired device name is not unique");

    f.removalAuthority.operationForTarget.mockResolvedValueOnce({
      operationId: "operation-other",
      targetDeviceId: "device-other",
    });
    await expect(f.application.execute({
      kind: "continue-device-removal",
      targetName: "书房设备",
      mode: "destroy",
    })).rejects.toThrow("Removal target name does not match the accepted device");
  });

  it("passes the durable abort token once and refuses inactive or offline transfer", async () => {
    const f = fixture();
    await expect(f.application.execute({
      kind: "continue-device-removal",
      targetName: "书房设备",
      mode: "cancel",
      operationId: "operation-1",
    })).resolves.toEqual(removalPublicState("cancelled"));
    expect(f.removalAuthority.abort).toHaveBeenCalledTimes(1);
    expect(f.removalEffects.abort).toHaveBeenCalledWith({
      targetDeviceId: "device-target",
      operationId: "operation-1",
      abort: "abort-token",
    });

    f.removalContext.read.mockReturnValueOnce({
      localDeviceId: "device-duty",
      currentDutyDeviceId: "device-duty",
      members: [{
        deviceId: "device-target",
        displayName: "书房设备",
        state: "revoked",
      }],
    });
    await expect(f.application.execute({
      kind: "continue-device-removal",
      targetName: "书房设备",
      mode: "destroy",
    })).rejects.toThrow("Removal target is no longer an active paired device");

    f.removalEffects.isConnected.mockReturnValueOnce(false);
    await expect(f.application.execute({
      kind: "continue-device-removal",
      targetName: "书房设备",
      mode: "transfer",
    })).rejects.toThrow("The device is offline");
    expect(f.removalEffects.decide).not.toHaveBeenCalled();
  });

  it("owns duty-migration admission, target qualification and stable replay results", async () => {
    const f = fixture();
    const prepare = {
      kind: "prepare-duty-migration" as const,
      requestId: "request:migration-1",
      transferId: "transfer-1",
      targetDeviceId: "device-target",
    };

    await expect(f.application.execute(prepare)).resolves.toEqual({ stage: "ready" });
    await expect(f.application.execute(prepare)).resolves.toEqual({ stage: "ready" });
    expect(f.dutyMigration.prepare).toHaveBeenNthCalledWith(1, {
      requestId: "request:migration-1",
      transferId: "transfer-1",
      targetDeviceId: "device-target",
    });
    expect(f.dutyMigration.prepare).toHaveBeenNthCalledWith(2, {
      requestId: "request:migration-1",
      transferId: "transfer-1",
      targetDeviceId: "device-target",
    });
    await expect(f.application.execute({
      kind: "commit-duty-migration",
      requestId: "request:migration-1",
      transferId: "transfer-1",
    })).resolves.toEqual({ stage: "completed" });
    await expect(f.application.execute({
      kind: "cancel-duty-migration",
      requestId: "request:migration-1",
      transferId: "transfer-1",
    })).resolves.toEqual({ stage: "cancelled" });
    expect(f.dutyMigration.commit).toHaveBeenCalledWith({
      requestId: "request:migration-1",
      transferId: "transfer-1",
    });
    expect(f.dutyMigration.cancel).toHaveBeenCalledWith({
      requestId: "request:migration-1",
      transferId: "transfer-1",
    });
  });

  it("fails closed before migration effects when ownership, generation or target admission fails", async () => {
    const f = fixture();
    const prepare = {
      kind: "prepare-duty-migration" as const,
      requestId: "request:migration-1",
      transferId: "transfer-1",
      targetDeviceId: "device-target",
    };

    f.dutyMigrationContext.read.mockReturnValueOnce({
      localDeviceId: "device-duty",
      currentDutyDeviceId: "device-duty",
      currentOwnerReady: false,
      deviceRemovalInProgress: false,
      members: [],
    });
    await expect(f.application.execute(prepare)).rejects.toThrow(
      "Current duty device is completing its durable migration consumers",
    );

    f.dutyMigrationContext.read.mockReturnValueOnce({
      localDeviceId: "device-duty",
      currentDutyDeviceId: "device-other",
      currentOwnerReady: true,
      deviceRemovalInProgress: false,
      members: [],
    });
    await expect(f.application.execute(prepare)).rejects.toThrow(
      "This device is not the current duty device",
    );

    f.dutyMigrationContext.read.mockReturnValueOnce({
      localDeviceId: "device-duty",
      currentDutyDeviceId: "device-duty",
      currentOwnerReady: true,
      deviceRemovalInProgress: true,
      members: [],
    });
    await expect(f.application.execute(prepare)).rejects.toThrow(
      "Duty-device migration is unavailable while a paired device is being removed",
    );

    await expect(f.application.execute({ ...prepare, targetDeviceId: "device-unknown" }))
      .rejects.toThrow("Migration target is not an active paired duty-capable device");
    expect(f.dutyMigration.prepare).not.toHaveBeenCalled();
  });

  it("preserves the existing post-commit cancellation boundary during device removal", async () => {
    const f = fixture();
    f.dutyMigrationContext.read.mockReturnValueOnce({
      localDeviceId: "device-duty",
      currentDutyDeviceId: "device-duty",
      currentOwnerReady: true,
      deviceRemovalInProgress: true,
      members: [],
    });
    await expect(f.application.execute({
      kind: "cancel-duty-migration",
      requestId: "request:migration-1",
      transferId: "transfer-1",
    })).resolves.toEqual({ stage: "cancelled" });
    expect(f.dutyMigration.cancel).toHaveBeenCalledTimes(1);
  });
});

function removalPublicState(
  phase: "moving-conversations" | "cancelled",
) {
  return {
    phase,
    conversations: [],
    localData: "known" as const,
    credentialActions: [],
  };
}
