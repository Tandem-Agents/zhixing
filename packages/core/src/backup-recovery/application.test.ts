import { describe, expect, it, vi } from "vitest";
import {
  BackupRecoveryAdministrationApplicationService,
  BackupRecoveryAdministrationError,
  BackupRecoveryCurrentRemovalApplicationService,
  BackupRecoveryDisasterAdmissionApplicationService,
  BackupRecoveryDisasterAdmissionError,
  BackupRecoveryRootLifecycleApplicationService,
  BackupRecoveryRootLifecycleError,
} from "./application.js";

function administrationFixture() {
  const configuration = {
    currentTargetId: "backup-dir:current",
    bindings: [
      { kind: "directory" as const, targetId: "backup-dir:current", directory: "D:/backup" },
      { kind: "paired-device" as const, targetId: "backup-device:peer", deviceId: "peer" },
    ],
  };
  const mechanism = {
    listPairedDevices: vi.fn(async () => [
      { deviceId: "self", displayName: "self", active: true, current: true },
      { deviceId: "peer", displayName: "peer", active: true, current: false },
    ]),
    readRootState: vi.fn(async () => ({
      kind: "established" as const,
      recipientKeyId: "backup-key",
      checkpointRevision: "trust-head",
    })),
    prepareInitialRoot: vi.fn(async () => "prepared-root"),
    preparedRootRecipientKeyId: vi.fn(() => "prepared-key"),
    selectTarget: vi.fn(async () => undefined),
    withDirectoryTarget: vi.fn(async (
      directory: string,
      use: (binding: {
        readonly kind: "directory";
        readonly targetId: string;
        readonly directory: string;
      }, target: string) => Promise<unknown>,
    ) => use({ kind: "directory", targetId: "backup-dir:new", directory }, "directory-target")),
    withSelectedTarget: vi.fn(async (
      _binding: unknown,
      _recipientKeyId: string,
      use: (target: string) => Promise<unknown>,
    ) => use("selected-target")),
    replayRootActivation: vi.fn(async () => undefined),
    establishInitialRoot: vi.fn(async () => ({ legacyTrustOnly: false })),
    activateInitialRoot: vi.fn(async () => undefined),
    createCheckpoint: vi.fn(async () => ({ checkpointId: "checkpoint-new" })),
    loadTargetConfiguration: vi.fn(async () => configuration),
    verificationCandidate: vi.fn(async () => ({
      checkpointId: "checkpoint-pending",
      targetId: "backup-device:peer",
    })),
    readRecoveryPackage: vi.fn(async () => "recovery-package"),
    verifyCheckpoint: vi.fn(async () => undefined),
    readStatus: vi.fn(async () => ({
      state: "pending-verification" as const,
      fullBackupReady: false,
    })),
  };
  return {
    application: new BackupRecoveryAdministrationApplicationService(mechanism),
    mechanism,
    configuration,
  };
}

describe("BackupRecoveryAdministrationApplicationService", () => {
  it("owns directory selection, stable checkpoint identity and initial-root setup", async () => {
    const existing = administrationFixture();
    await expect(existing.application.setup({ kind: "directory", directory: "D:/backup" }))
      .resolves.toEqual({ kind: "checkpoint-created", checkpointId: "checkpoint-new" });
    expect(existing.mechanism.selectTarget).toHaveBeenCalledWith({
      kind: "directory",
      targetId: "backup-dir:new",
      directory: "D:/backup",
    });
    expect(existing.mechanism.createCheckpoint).toHaveBeenCalledWith(
      "directory-target",
      "backup-setup:backup-dir:new:trust-head",
    );

    const initial = administrationFixture();
    initial.mechanism.readRootState.mockResolvedValue({ kind: "missing" });
    await expect(initial.application.setup({ kind: "directory", directory: "D:/backup" }))
      .resolves.toEqual({ kind: "initial-root-established" });
    expect(initial.mechanism.prepareInitialRoot).toHaveBeenCalledOnce();
    expect(initial.mechanism.establishInitialRoot)
      .toHaveBeenCalledWith("prepared-root", "directory-target");
    expect(initial.mechanism.createCheckpoint).not.toHaveBeenCalled();
  });

  it("owns paired-device resolution, replay and remote initial-root activation", async () => {
    const replay = administrationFixture();
    await replay.application.setup({
      kind: "paired-device",
      selector: { kind: "display-name", value: "peer" },
    });
    expect(replay.mechanism.replayRootActivation).toHaveBeenCalledBefore(
      replay.mechanism.createCheckpoint,
    );
    expect(replay.mechanism.withSelectedTarget).toHaveBeenCalledWith(
      { kind: "paired-device", targetId: "backup-device:peer", deviceId: "peer" },
      "backup-key",
      expect.any(Function),
    );

    const initial = administrationFixture();
    initial.mechanism.readRootState.mockResolvedValue({ kind: "missing" });
    await expect(initial.application.setup({
      kind: "paired-device",
      selector: { kind: "device-id", value: "peer" },
    })).resolves.toEqual({ kind: "initial-root-established" });
    expect(initial.mechanism.prepareInitialRoot).toHaveBeenCalledBefore(
      initial.mechanism.selectTarget,
    );
    expect(initial.mechanism.activateInitialRoot)
      .toHaveBeenCalledWith(
        { kind: "paired-device", targetId: "backup-device:peer", deviceId: "peer" },
        "prepared-root",
        "selected-target",
      );
  });

  it("fails closed on ambiguous, current or unavailable paired devices", async () => {
    const ambiguous = administrationFixture();
    ambiguous.mechanism.listPairedDevices.mockResolvedValue([
      { deviceId: "one", displayName: "peer", active: true, current: false },
      { deviceId: "two", displayName: "peer", active: true, current: false },
    ]);
    await expect(ambiguous.application.setup({
      kind: "paired-device",
      selector: { kind: "display-name", value: "peer" },
    })).rejects.toMatchObject<Partial<BackupRecoveryAdministrationError>>({
      code: "duplicate-paired-device-name",
    });

    const current = administrationFixture();
    await expect(current.application.setup({
      kind: "paired-device",
      selector: { kind: "device-id", value: "self" },
    })).rejects.toMatchObject<Partial<BackupRecoveryAdministrationError>>({
      code: "invalid-paired-device",
    });
    expect(current.mechanism.selectTarget).not.toHaveBeenCalled();
  });

  it("binds verify to the configured candidate and reads the package inside the target session", async () => {
    const f = administrationFixture();
    await expect(f.application.verify()).resolves.toEqual({ checkpointId: "checkpoint-pending" });
    expect(f.mechanism.verificationCandidate).toHaveBeenCalledWith("backup-dir:current");
    expect(f.mechanism.withSelectedTarget).toHaveBeenCalledWith(
      { kind: "paired-device", targetId: "backup-device:peer", deviceId: "peer" },
      "backup-key",
      expect.any(Function),
    );
    expect(f.mechanism.verifyCheckpoint).toHaveBeenCalledWith({
      target: "selected-target",
      checkpointId: "checkpoint-pending",
      recoveryPackage: "recovery-package",
    });
  });

  it.each([
    [
      { state: "recoverable" as const, fullBackupReady: true },
      { state: "recoverable", fullBackupReady: true },
    ],
    [
      { state: "pending-verification" as const, fullBackupReady: false },
      {
        state: "pending-verification",
        fullBackupReady: false,
        nextAction: "run-backup-verify",
      },
    ],
    [
      { state: "not-configured" as const, fullBackupReady: false },
      {
        state: "configured-empty",
        fullBackupReady: false,
        nextAction: "run-backup-setup",
      },
    ],
    [
      { state: "unavailable" as const, fullBackupReady: true, code: "runtime-unavailable" as const },
      {
        state: "unavailable",
        fullBackupReady: true,
        nextAction: "start-authenticated-mesh",
      },
    ],
  ])("projects durable status %o to its product next action", async (status, expected) => {
    const f = administrationFixture();
    f.mechanism.readStatus.mockResolvedValue(status);
    await expect(f.application.status()).resolves.toEqual(expected);
  });

  it("reports an absent configuration and rejects broken current/candidate bindings", async () => {
    const absent = administrationFixture();
    absent.mechanism.loadTargetConfiguration.mockResolvedValue(undefined);
    await expect(absent.application.status()).resolves.toEqual({
      state: "not-configured",
      fullBackupReady: false,
      nextAction: "run-backup-setup",
    });
    await expect(absent.application.verify()).rejects.toMatchObject({
      code: "target-not-configured",
    });

    const broken = administrationFixture();
    broken.mechanism.loadTargetConfiguration.mockResolvedValue({
      currentTargetId: "missing",
      bindings: broken.configuration.bindings,
    });
    await expect(broken.application.status()).rejects.toMatchObject({
      code: "current-target-binding-missing",
    });

    const historical = administrationFixture();
    historical.mechanism.verificationCandidate.mockResolvedValue({
      checkpointId: "checkpoint-pending",
      targetId: "missing",
    });
    await expect(historical.application.verify()).rejects.toMatchObject({
      code: "verification-target-binding-missing",
    });
  });
});

function rootLifecycleFixture() {
  const calls: string[] = [];
  const context = {
    homeId: "home-1",
    trustEpoch: 4,
    chainHead: { seq: 9, eventDigest: "trust-9" },
    currentDeviceId: "issuer-device",
    issuerDeviceId: "issuer-device",
    issuerKeyId: "issuer-key",
    signerKeyId: "issuer-key",
    activeDeviceIds: ["issuer-device", "co-signer"],
    currentRoot: { rootPublicKey: "root-old", backupPublicKey: "backup-old" },
  };
  const current = {
    root: "root-material-old",
    identity: { rootPublicKey: "root-old", backupPublicKey: "backup-old" },
  };
  const replacement = {
    generated: {
      root: "root-material-new",
      identity: { rootPublicKey: "root-new", backupPublicKey: "backup-new" },
    },
    readBack: {
      root: "root-material-new-readback",
      identity: { rootPublicKey: "root-new", backupPublicKey: "backup-new" },
    },
  };
  const approval = {
    v: 1 as const,
    homeId: "home-1",
    seq: 10,
    prevEventDigest: "trust-9",
    trustEpoch: 4,
    at: "2026-09-01T00:00:00.000Z",
    coSign: { deviceId: "co-signer", sig: "signature" },
  };
  const issuerSession = {
    context,
    readCurrentPackage: vi.fn(async () => {
      calls.push("read-current-package");
      return current;
    }),
    prepareReplacementRoot: vi.fn(async () => {
      calls.push("prepare-replacement");
      return replacement;
    }),
    createRotateEvent: vi.fn(() => {
      calls.push("create-rotate-event");
      return "rotate-event";
    }),
    createInvalidationEvent: vi.fn(() => {
      calls.push("create-invalidate-event");
      return "invalidate-event";
    }),
    createResetEvents: vi.fn(() => {
      calls.push("create-reset-events");
      return { resetEvent: "reset-event", rootEvent: "establish-event" };
    }),
    withCurrentTarget: vi.fn(async (_root: string, use: (target: string) => Promise<unknown>) => {
      calls.push("open-target");
      try {
        return await use("target");
      } finally {
        calls.push("close-target");
      }
    }),
    targetId: vi.fn(() => "target-1"),
    captureCheckpoint: vi.fn(async () => {
      calls.push("capture-checkpoint");
      return "checkpoint";
    }),
    currentCheckpointIds: vi.fn(async () => {
      calls.push("read-superseded");
      return ["checkpoint-old"];
    }),
    activate: vi.fn(async () => {
      calls.push("activate");
    }),
    commitInvalidation: vi.fn(async () => {
      calls.push("commit-invalidation");
    }),
  };
  const approvalSession = {
    context: {
      ...context,
      currentDeviceId: "co-signer",
      signerKeyId: "co-signer",
    },
    createApproval: vi.fn(() => approval),
  };
  const mechanism = {
    now: vi.fn(() => "2026-09-01T00:00:00.000Z"),
    withIssuerSession: vi.fn(async (use: (session: typeof issuerSession) => Promise<unknown>) =>
      use(issuerSession)),
    withApprovalSession: vi.fn(async (
      use: (session: typeof approvalSession) => Promise<unknown>,
    ) => use(approvalSession)),
  };
  return {
    application: new BackupRecoveryRootLifecycleApplicationService(mechanism),
    mechanism,
    issuerSession,
    approvalSession,
    context,
    replacement,
    approval,
    calls,
  };
}

describe("BackupRecoveryRootLifecycleApplicationService", () => {
  it("owns rotate progression from current-root proof through verified activation", async () => {
    const f = rootLifecycleFixture();
    await expect(f.application.rotate({ userConfirmed: true })).resolves.toEqual({
      kind: "rotated",
    });
    expect(f.calls).toEqual([
      "read-current-package",
      "prepare-replacement",
      "create-rotate-event",
      "open-target",
      "capture-checkpoint",
      "read-superseded",
      "activate",
      "close-target",
    ]);
    expect(f.issuerSession.activate).toHaveBeenCalledWith({
      plan: { v: 1, kind: "rotate", rootEvent: "rotate-event" },
      candidateRoot: "root-material-new-readback",
      checkpoint: "checkpoint",
      target: "target",
      supersedeCheckpointIds: ["checkpoint-old"],
    });
  });

  it("owns invalidation and rejects confirmation, issuer and root-package drift before effects", async () => {
    const unconfirmed = rootLifecycleFixture();
    await expect(unconfirmed.application.invalidate({ userConfirmed: false }))
      .rejects.toMatchObject<Partial<BackupRecoveryRootLifecycleError>>({
        code: "invalidate-confirmation-required",
      });
    expect(unconfirmed.mechanism.withIssuerSession).not.toHaveBeenCalled();

    const foreignIssuer = rootLifecycleFixture();
    foreignIssuer.issuerSession.context = {
      ...foreignIssuer.context,
      currentDeviceId: "other-device",
    };
    await expect(foreignIssuer.application.invalidate({ userConfirmed: true }))
      .rejects.toMatchObject({ code: "current-issuer-required" });
    expect(foreignIssuer.issuerSession.readCurrentPackage).not.toHaveBeenCalled();

    const foreignRoot = rootLifecycleFixture();
    foreignRoot.issuerSession.readCurrentPackage.mockResolvedValue({
      root: "foreign-root",
      identity: { rootPublicKey: "foreign", backupPublicKey: "foreign" },
    });
    await expect(foreignRoot.application.invalidate({ userConfirmed: true }))
      .rejects.toMatchObject({ code: "current-package-mismatch" });
    expect(foreignRoot.issuerSession.commitInvalidation).not.toHaveBeenCalled();

    const valid = rootLifecycleFixture();
    await expect(valid.application.invalidate({ userConfirmed: true }))
      .resolves.toEqual({ kind: "invalidated" });
    expect(valid.calls).toEqual([
      "read-current-package",
      "create-invalidate-event",
      "commit-invalidation",
    ]);
  });

  it("owns distinct active co-confirmation and freezes a generation-bound approval", async () => {
    const f = rootLifecycleFixture();
    await expect(f.application.approveReset({ userConfirmed: true })).resolves.toEqual({
      kind: "reset-approved",
      approval: f.approval,
    });
    expect(f.approvalSession.createApproval).toHaveBeenCalledWith(
      "2026-09-01T00:00:00.000Z",
    );

    const issuer = rootLifecycleFixture();
    issuer.approvalSession.context = issuer.context;
    await expect(issuer.application.approveReset({ userConfirmed: true }))
      .rejects.toMatchObject({ code: "approval-cosigner-is-issuer" });
    expect(issuer.approvalSession.createApproval).not.toHaveBeenCalled();

    const inactive = rootLifecycleFixture();
    inactive.approvalSession.context = {
      ...inactive.approvalSession.context,
      activeDeviceIds: ["issuer-device"],
    };
    await expect(inactive.application.approveReset({ userConfirmed: true }))
      .rejects.toMatchObject({ code: "approval-cosigner-ineligible" });
  });

  it("owns domain-reset-establish as one checkpointed progression", async () => {
    const f = rootLifecycleFixture();
    await expect(f.application.reset({
      userConfirmed: true,
      decodeApproval: () => f.approval,
    })).resolves.toEqual({ kind: "reset" });
    expect(f.calls).toEqual([
      "prepare-replacement",
      "create-reset-events",
      "open-target",
      "capture-checkpoint",
      "read-superseded",
      "activate",
      "close-target",
    ]);
    expect(f.issuerSession.activate).toHaveBeenCalledWith({
      plan: {
        v: 1,
        kind: "domain-reset-establish",
        resetEvent: "reset-event",
        rootEvent: "establish-event",
      },
      candidateRoot: "root-material-new-readback",
      checkpoint: "checkpoint",
      target: "target",
      supersedeCheckpointIds: ["checkpoint-old"],
    });
  });

  it("fails closed before reset effects on generation, co-signer or read-back drift", async () => {
    const generation = rootLifecycleFixture();
    await expect(generation.application.reset({
      userConfirmed: true,
      decodeApproval: () => ({ ...generation.approval, prevEventDigest: "stale" }),
    })).rejects.toMatchObject({ code: "approval-generation-mismatch" });
    expect(generation.issuerSession.prepareReplacementRoot).not.toHaveBeenCalled();

    const coSigner = rootLifecycleFixture();
    await expect(coSigner.application.reset({
      userConfirmed: true,
      decodeApproval: () => ({
        ...coSigner.approval,
        coSign: { ...coSigner.approval.coSign, deviceId: "unknown" },
      }),
    })).rejects.toMatchObject({ code: "approval-cosigner-ineligible" });

    const readBack = rootLifecycleFixture();
    readBack.issuerSession.prepareReplacementRoot.mockResolvedValue({
      ...readBack.replacement,
      readBack: {
        root: "foreign-root",
        identity: { rootPublicKey: "foreign", backupPublicKey: "foreign" },
      },
    });
    await expect(readBack.application.reset({
      userConfirmed: true,
      decodeApproval: () => readBack.approval,
    })).rejects.toMatchObject({ code: "replacement-readback-mismatch" });
    expect(readBack.issuerSession.withCurrentTarget).not.toHaveBeenCalled();
  });

  it("rejects reset confirmation before approval decoding or issuer mechanisms", async () => {
    const f = rootLifecycleFixture();
    const decodeApproval = vi.fn(() => {
      throw new Error("malformed approval");
    });
    await expect(f.application.reset({
      userConfirmed: false,
      decodeApproval,
    })).rejects.toMatchObject<Partial<BackupRecoveryRootLifecycleError>>({
      code: "reset-confirmation-required",
    });
    expect(decodeApproval).not.toHaveBeenCalled();
    expect(f.mechanism.withIssuerSession).not.toHaveBeenCalled();
  });
});

interface DisasterEnvelope {
  readonly checkpointId: string;
  readonly createdAt: string;
  readonly recipientKeyId: string;
  readonly digest: string;
}

function disasterAdmissionFixture() {
  const older = Object.freeze({
    checkpointId: "checkpoint-older",
    targetId: "target-b",
    recipientKeyId: "backup-key",
    envelope: Object.freeze({
      checkpointId: "checkpoint-older",
      createdAt: "2026-08-30T00:00:00.000Z",
      recipientKeyId: "backup-key",
      digest: "sha256:older",
    }),
    envelopeIdentity: Object.freeze({
      checkpointId: "checkpoint-older",
      createdAt: "2026-08-30T00:00:00.000Z",
      recipientKeyId: "backup-key",
      digest: "sha256:older",
    }),
  });
  const newer = Object.freeze({
    checkpointId: "checkpoint-newer",
    targetId: "target-a",
    recipientKeyId: "backup-key",
    envelope: Object.freeze({
      checkpointId: "checkpoint-newer",
      createdAt: "2026-08-31T00:00:00.000Z",
      recipientKeyId: "backup-key",
      digest: "sha256:newer",
    }),
    envelopeIdentity: Object.freeze({
      checkpointId: "checkpoint-newer",
      createdAt: "2026-08-31T00:00:00.000Z",
      recipientKeyId: "backup-key",
      digest: "sha256:newer",
    }),
  });
  const mechanism = {
    deriveDiscoveryRequestId: vi.fn(() => `recover:${"a".repeat(64)}`),
    withInventorySources: vi.fn(async (
      _selection: unknown,
      use: (sources: readonly { readonly displayName: string; readonly target: string }[]) =>
        Promise<unknown>,
    ) => use([
      { displayName: " peer-b ", target: "peer-b" },
      { displayName: "peer-a", target: "peer-a" },
    ])),
    inventory: vi.fn(async (target: string) => target === "peer-b" ? [older] : [newer]),
    presentCandidates: vi.fn(),
    readRecoveryRoot: vi.fn(async () => ({
      root: "recovery-root",
      identity: { rootKeyId: "root-key", backupKeyId: "backup-key" },
    })),
    deriveTransferId: vi.fn(() => "xfer-00000000000000000000000000"),
    signPrepare: vi.fn((intent: unknown) => `signed:${JSON.stringify(intent)}`),
    readCheckpoint: vi.fn(async (_target: string, checkpointId: string) =>
      `bytes:${checkpointId}`),
  };
  const context = {
    homeId: "home-1",
    currentDeviceId: "self",
    issuerDeviceId: "issuer",
    pairedDevices: [
      { deviceId: "self", displayName: "self", active: true, current: true },
      { deviceId: "peer-a", displayName: "peer", active: true, current: false },
      { deviceId: "peer-b", displayName: "other", active: true, current: false },
    ],
    configuredPairedDeviceId: "peer-a",
    recoveryBackupRecipientKeyId: "backup-key",
  };
  return {
    application: new BackupRecoveryDisasterAdmissionApplicationService<
      string,
      DisasterEnvelope,
      string,
      string,
      string
    >(context, mechanism),
    context,
    mechanism,
    newer,
    older,
  };
}

describe("BackupRecoveryDisasterAdmissionApplicationService", () => {
  it("owns deterministic discovery, candidate order, selection, package binding and prepare intent", async () => {
    const f = disasterAdmissionFixture();
    const admitted = await f.application.admit({ backupNumber: 1 });

    expect(f.mechanism.withInventorySources).toHaveBeenCalledWith(
      {
        kind: "paired-device",
        deviceId: "peer-a",
        displayName: "peer",
        recipientKeyId: "backup-key",
      },
      expect.any(Function),
    );
    expect(f.mechanism.deriveDiscoveryRequestId).toHaveBeenCalledWith({
      homeId: "home-1",
      targetDeviceId: "self",
    });
    expect(f.mechanism.presentCandidates).toHaveBeenCalledWith([
      {
        number: 1,
        location: "peer-a",
        backedUpAt: "2026-08-31T00:00:00.000Z",
        state: "pending-verification",
      },
      {
        number: 2,
        location: "peer-b",
        backedUpAt: "2026-08-30T00:00:00.000Z",
        state: "pending-verification",
      },
    ]);
    expect(f.mechanism.deriveTransferId).toHaveBeenCalledWith({
      requestId: `recover:${"a".repeat(64)}`,
      targetDeviceId: "self",
      checkpointTargetId: "target-a",
      checkpointEnvelopeDigest: "sha256:newer",
    });
    expect(f.mechanism.signPrepare).toHaveBeenCalledWith({
      v: 1,
      op: "prepare",
      requestId: `recover:${"a".repeat(64)}`,
      transferId: "xfer-00000000000000000000000000",
      targetDeviceId: "self",
      checkpointTargetId: "target-a",
      recoveryRoot: {
        homeId: "home-1",
        rootKeyId: "root-key",
        recipientKeyId: "backup-key",
      },
      checkpointEnvelope: f.newer.envelope,
    }, "recovery-root");
    expect(admitted).toMatchObject({
      requestId: `recover:${"a".repeat(64)}`,
      transferId: "xfer-00000000000000000000000000",
      checkpointTargetId: "target-a",
      checkpointEnvelopeDigest: "sha256:newer",
      recoveryRoot: "recovery-root",
      checkpoint: "bytes:checkpoint-newer",
    });
  });

  it("owns source exclusivity, paired eligibility and candidate selection", async () => {
    const conflict = disasterAdmissionFixture();
    await expect(conflict.application.admit({
      directory: "D:/backup",
      pairedDeviceId: "peer-a",
    })).rejects.toMatchObject<Partial<BackupRecoveryDisasterAdmissionError>>({
      code: "source-selection-conflict",
      errorKind: "type-error",
    });
    expect(conflict.mechanism.withInventorySources).not.toHaveBeenCalled();

    const named = disasterAdmissionFixture();
    named.context.pairedDevices[2]!.displayName = "peer";
    await expect(named.application.admit({ pairedDeviceName: "peer" }))
      .rejects.toMatchObject({ code: "paired-device-name-not-unique" });

    const multiple = disasterAdmissionFixture();
    await expect(multiple.application.admit({}))
      .rejects.toMatchObject({ code: "candidate-selection-required" });

    const invalid = disasterAdmissionFixture();
    await expect(invalid.application.admit({ backupNumber: 3 }))
      .rejects.toMatchObject({ code: "invalid-candidate-number", errorKind: "type-error" });
  });

  it("fails closed before signing or reading bytes on duty, bad package binding and bad envelope", async () => {
    const duty = disasterAdmissionFixture();
    duty.context.issuerDeviceId = "self";
    await expect(duty.application.admit({ backupNumber: 1 }))
      .rejects.toMatchObject({ code: "current-issuer" });
    expect(duty.mechanism.inventory).not.toHaveBeenCalled();

    const packageMismatch = disasterAdmissionFixture();
    packageMismatch.mechanism.readRecoveryRoot.mockResolvedValue({
      root: "foreign-root",
      identity: { rootKeyId: "foreign-root-key", backupKeyId: "foreign-backup-key" },
    });
    await expect(packageMismatch.application.admit({ backupNumber: 1 }))
      .rejects.toMatchObject({ code: "recovery-package-mismatch" });
    expect(packageMismatch.mechanism.signPrepare).not.toHaveBeenCalled();
    expect(packageMismatch.mechanism.readCheckpoint).not.toHaveBeenCalled();

    const envelope = disasterAdmissionFixture();
    envelope.mechanism.inventory.mockResolvedValue([{
      ...envelope.newer,
      envelopeIdentity: { ...envelope.newer.envelopeIdentity, checkpointId: "other" },
    }]);
    await expect(envelope.application.admit({ backupNumber: 1 }))
      .rejects.toMatchObject({ code: "invalid-candidate-envelope" });
    expect(envelope.mechanism.presentCandidates).not.toHaveBeenCalled();
  });

  it("reconstructs stable request and transfer identities on exact replay", async () => {
    const f = disasterAdmissionFixture();
    const first = await f.application.admit({ backupNumber: 1 });
    const replay = await f.application.admit({ backupNumber: 1 });
    expect(replay.requestId).toBe(first.requestId);
    expect(replay.transferId).toBe(first.transferId);
    expect(f.mechanism.deriveDiscoveryRequestId).toHaveBeenCalledTimes(2);
    expect(f.mechanism.deriveTransferId).toHaveBeenCalledTimes(2);
  });
});

function fixture() {
  const context = {
    homeId: "home-1",
    anchorEpoch: 7,
    trustHeadDigest: "trust-7",
    recoveryRootPublicKey: "root-public",
    recoveryBackupPublicKey: "backup-public",
  };
  const identity = {
    rootKeyId: "root-key",
    backupKeyId: "backup-key",
    rootPublicKey: "root-public",
    backupPublicKey: "backup-public",
  };
  const mechanism = {
    hasCheckpointOwner: vi.fn(() => true),
    readStatus: vi.fn(async () => ({
      state: "recoverable" as const,
      fullBackupReady: true,
      checkpointId: "checkpoint-old",
      targetId: "target-1",
      upToLsn: 11,
    })),
    readContext: vi.fn(async () => context),
    decodeCurrentPackage: vi.fn(() => ({ package: "secret-root", identity })),
    bindingDigest: vi.fn((input: unknown) => `generation:${JSON.stringify(input)}`),
    forceCheckpoint: vi.fn(async (requestId: string) => ({
      checkpoint: `checkpoint:${requestId}`,
      checkpointId: `id:${requestId}`,
      envelopeDigest: `digest:${requestId}`,
      upToLsn: requestId.includes("final") ? 42 : 12,
    })),
    verifyCheckpoint: vi.fn(async ({ checkpoint }: { readonly checkpoint: string }) => ({
      targetId: "target-1",
      checkpointId: checkpoint.replace("checkpoint:", "id:"),
      envelopeDigest: checkpoint.replace("checkpoint:", "digest:"),
      evidence: `verified:${checkpoint}`,
    })),
  };
  return {
    application: new BackupRecoveryCurrentRemovalApplicationService(mechanism),
    mechanism,
    context,
    identity,
  };
}

describe("BackupRecoveryCurrentRemovalApplicationService", () => {
  it("owns package/root/generation binding and both checkpoint permissions", async () => {
    const f = fixture();
    const status = await f.application.readiness();
    expect(Object.isFrozen(status)).toBe(true);
    expect(status).toEqual({
      state: "recoverable",
      fullBackupReady: true,
      checkpointId: "checkpoint-old",
      targetId: "target-1",
      upToLsn: 11,
    });

    const initial = await f.application.prepareBegin({ recoveryPackage: "package" });
    expect(Object.isFrozen(initial.binding)).toBe(true);
    await expect(initial.verifyCheckpoint({ requestId: "operation:pre" }))
      .resolves.toBe("verified:checkpoint:operation:pre");
    const confirmed = await f.application.prepareConfirm({
      recoveryPackage: "package",
      binding: initial.binding,
    });
    await expect(confirmed.verifyCheckpoint({
      requestId: "operation:final",
      minimumUpToLsn: 40,
    })).resolves.toBe("verified:checkpoint:operation:final");
    expect(f.mechanism.bindingDigest).toHaveBeenCalledWith({
      homeId: "home-1",
      anchorEpoch: 7,
      trustHeadDigest: "trust-7",
      targetId: "target-1",
      rootKeyId: "root-key",
      recipientKeyId: "backup-key",
    });
  });

  it("fails closed on missing owner, root drift and accepted-generation drift", async () => {
    const missing = fixture();
    missing.mechanism.hasCheckpointOwner.mockReturnValue(false);
    await expect(missing.application.prepareBegin({ recoveryPackage: "package" }))
      .rejects.toThrow("No recovery backup target is configured");

    const root = fixture();
    root.mechanism.decodeCurrentPackage.mockReturnValue({
      package: "foreign-root",
      identity: { ...root.identity, rootPublicKey: "foreign-public" },
    });
    await expect(root.application.prepareBegin({ recoveryPackage: "package" }))
      .rejects.toThrow("does not bind the current home recovery root");

    const generation = fixture();
    const permit = await generation.application.prepareBegin({ recoveryPackage: "package" });
    generation.mechanism.readContext.mockResolvedValue({
      ...generation.context,
      homeId: "foreign-home",
    });
    await expect(generation.application.prepareConfirm({
      recoveryPackage: "package",
      binding: permit.binding,
    })).rejects.toThrow("changes the accepted uninstall generation");
  });

  it("rejects checkpoint equivocation and a final checkpoint before the flush", async () => {
    const equivocation = fixture();
    equivocation.mechanism.verifyCheckpoint.mockResolvedValue({
      targetId: "foreign-target",
      checkpointId: "id:operation:pre",
      envelopeDigest: "digest:operation:pre",
      evidence: "foreign",
    });
    const initial = await equivocation.application.prepareBegin({ recoveryPackage: "package" });
    await expect(initial.verifyCheckpoint({ requestId: "operation:pre" }))
      .rejects.toThrow("does not bind the frozen target");

    const stale = fixture();
    const confirmed = await stale.application.prepareBegin({ recoveryPackage: "package" });
    await expect(confirmed.verifyCheckpoint({
      requestId: "operation:pre",
      minimumUpToLsn: 13,
    })).rejects.toThrow("does not contain the accepted-work flush");
  });
});
