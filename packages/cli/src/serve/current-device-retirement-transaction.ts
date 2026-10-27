import type {
  CredentialExposureRecord,
  HomeTrustEvent,
} from "@zhixing/core/contracts";
import type { AuthorityCommitLog } from "@zhixing/core/authority";
import {
  assertDeviceAdministrationRetirementAuthority,
} from "@zhixing/core/device-administration/correctness";
import {
  decideCurrentDeviceRetirementCredentialExposures,
} from "@zhixing/core/device-administration/application";
import {
  emptyDeviceLifecycleProjection,
  protocolDigest,
  reduceDeviceLifecycleProjection,
  validateDeviceLifecycleRecord,
  type AnchorUninstallLifecycleIdentity,
  type DeviceLifecycleEvidenceRef,
  type DeviceLifecycleProjection,
  type ProtocolSignatureVerifier,
} from "@zhixing/core/protocol";
import { credentialExposureIndex, projectCredentialExposures } from "@zhixing/mesh/credential-exposure";
import { EMPTY_TRUST_STREAM_FOLD, foldTrustStreamRecord, replayTrustChain, type TrustStreamFold } from "@zhixing/mesh/trust-chain";

interface CurrentDeviceRetirementProjection {
  readonly trustEvents: readonly HomeTrustEvent[];
  readonly trustStaged: TrustStreamFold["staged"];
  readonly exposures: readonly CredentialExposureRecord[];
  readonly lifecycle: DeviceLifecycleProjection;
}

/**
 * Atomically commits an already-decided current-device retirement fact.
 * Product exposure selection stays in Device Administration; this adapter only
 * verifies the locked Authority prefix and appends the finite records.
 */
export async function commitCurrentDeviceRetirementTransaction(options: {
  readonly log: AuthorityCommitLog;
  readonly verifier: ProtocolSignatureVerifier;
  readonly identity: AnchorUninstallLifecycleIdentity;
  readonly acceptedWork: DeviceLifecycleEvidenceRef;
}): Promise<void> {
  credentialExposureIndex(options.log);
  const { acceptedWork, identity } = options;
  if (
    acceptedWork.kind !== "accepted-work" ||
    !acceptedWork.artifact ||
    acceptedWork.digest !== acceptedWork.artifact.digest
  ) {
    throw new Error("Anchor retirement requires its frozen accepted-work artifact");
  }
  await options.log.transactProjection<
    CurrentDeviceRetirementProjection,
    unknown,
    void
  >(
    { trustEvents: [], trustStaged: EMPTY_TRUST_STREAM_FOLD.staged, exposures: [], lifecycle: emptyDeviceLifecycleProjection() },
    (state, entry) => {
      if (entry.stream === "trust") {
        const fold = foldTrustStreamRecord({ events: state.trustEvents, staged: state.trustStaged }, entry.body);
        return { ...state, trustEvents: fold.events, trustStaged: fold.staged };
      }
      if (entry.stream === "exposure" && isExposureRecord(entry.body)) {
        return { ...state, exposures: [...state.exposures, entry.body] };
      }
      if (entry.stream === "device-lifecycle") {
        return {
          ...state,
          lifecycle: reduceDeviceLifecycleProjection(
            state.lifecycle,
            entry.body,
            options.verifier,
          ),
        };
      }
      return state;
    },
    (state, context) => {
      const operation = state.lifecycle.operations.get(identity.operationId);
      if (!operation || operation.identity.kind !== "anchor-uninstall") {
        throw new Error("Anchor uninstall retirement lost its lifecycle operation");
      }
      if (operation.phase === "retirement-decided") {
        return { kind: "return", value: undefined };
      }
      if (operation.phase !== "checkpoint-verified") {
        throw new Error("Anchor retirement requires a verified recovery backup");
      }
      const trust = replayTrustChain(state.trustEvents);
      assertDeviceAdministrationRetirementAuthority({
        currentDeviceId: identity.currentDeviceId,
        acceptedTrustHeadDigest: identity.trustHeadDigest,
        currentDutyDeviceId: trust.issuer.deviceId,
        currentTrustHeadDigest: trust.chainHead.eventDigest,
      });
      const compromised = decideCurrentDeviceRetirementCredentialExposures({
        records: projectCredentialExposures(state.exposures).records,
        currentDeviceId: identity.currentDeviceId,
        markedAt: context.at,
      });
      const evidence = [
        acceptedWork,
        {
          kind: "credential-exposure" as const,
          digest: protocolDigest("AnchorRetirementCredentialExposure", 1, compromised),
        },
      ];
      const lifecycle = validateDeviceLifecycleRecord({
        v: 1,
        t: "advanced",
        operationId: identity.operationId,
        phase: "retirement-decided",
        evidence,
      });
      reduceDeviceLifecycleProjection(state.lifecycle, lifecycle, options.verifier);
      return {
        kind: "append",
        entries: [
          ...compromised.map((body) => ({ stream: "exposure", body })),
          { stream: "device-lifecycle", body: lifecycle },
        ],
        value: undefined,
      };
    },
    {
      streams: ["trust", "exposure", "device-lifecycle"],
      candidateReferences: [acceptedWork.artifact],
    },
  );
}

export async function readCurrentDeviceRemovalPhaseLsn(options: {
  readonly log: AuthorityCommitLog;
  readonly operationId: string;
  readonly phase: "flushed";
}): Promise<number> {
  const records = await options.log.readStream<unknown>("device-lifecycle");
  const decision = records.find((entry) => {
    const record = validateDeviceLifecycleRecord(entry.body);
    return record.t === "advanced" &&
      record.operationId === options.operationId &&
      record.phase === options.phase;
  });
  if (!decision) throw new Error(`Anchor uninstall ${options.phase} LSN is missing`);
  return decision.lsn;
}

function isExposureRecord(input: unknown): input is CredentialExposureRecord {
  return !!input && typeof input === "object" &&
    typeof (input as { deviceId?: unknown }).deviceId === "string" &&
    typeof (input as { bindingId?: unknown }).bindingId === "string" &&
    new Set(["active", "compromised", "rotated"])
      .has((input as { state?: unknown }).state as string);
}
