import {
  registerCleanup,
  type CleanupRegistrationDescriptor,
  type CleanupRegistry,
} from "@zhixing/server";
import {
  type StartupCleanupHandle,
  type StartupRollback,
} from "./startup-rollback.js";

export type AssemblyLifecycleTransferStage =
  | "foundation"
  | "surface"
  | "post-server"
  | "runtime"
  | "activation";

interface AssemblyLifecycleDescriptor extends CleanupRegistrationDescriptor {
  readonly stage: AssemblyLifecycleTransferStage;
}

/**
 * The exact pre-server lifecycle identities in normal registration order.
 *
 * Setup order remains owned by `createAssemblyUnits`; this order only mirrors
 * the established CleanupRegistry LIFO contract. Conditional resources simply
 * omit their contribution rather than manufacturing an empty cleanup.
 */
export const ASSEMBLY_LIFECYCLE_DESCRIPTORS = [
  {
    owner: "anchor-host",
    role: "common",
    id: "authorityRuntime.stopStorageMaintenance",
    stage: "foundation",
  },
  {
    owner: "anchor-local-executor",
    role: "common",
    id: "localWorkspaceHost.close",
    stage: "foundation",
  },
  {
    owner: "anchor-local-executor",
    role: "runtime",
    id: "localConversationOwner.close",
    stage: "foundation",
  },
  {
    owner: "anchor-host",
    role: "common",
    id: "channels.dispose",
    stage: "surface",
  },
  {
    owner: "anchor-host",
    role: "common",
    id: "deliveryStack.stop",
    stage: "surface",
  },
  {
    owner: "anchor-host",
    role: "common",
    id: "mcpHub.dispose",
    stage: "surface",
  },
  {
    owner: "anchor-host",
    role: "runtime",
    id: "meshRuntime.stop",
    stage: "runtime",
  },
  {
    owner: "anchor-local-executor",
    role: "runtime",
    id: "executorDataPlane.close",
    stage: "runtime",
  },
  {
    owner: "anchor-host",
    role: "runtime",
    id: "jobStatus.dispose",
    stage: "runtime",
  },
  {
    owner: "anchor-host",
    role: "runtime",
    id: "assetMaintenance.stop",
    stage: "runtime",
  },
  {
    owner: "anchor-local-executor",
    role: "runtime",
    id: "executorJobOwner.close",
    stage: "runtime",
  },
  {
    owner: "anchor-host",
    role: "runtime",
    id: "losslessDataPlane.close",
    stage: "runtime",
  },
] as const satisfies readonly AssemblyLifecycleDescriptor[];

/**
 * Runtime responsibilities that become normal-close owners only while the
 * prepared Anchor endpoint is still behind its activation gate. Registration
 * order is the existing CleanupRegistry order; normal close observes its LIFO
 * inverse. Conditional resources simply omit their contribution.
 */
export const ANCHOR_RUNTIME_LIFECYCLE_DESCRIPTORS = [
  {
    owner: "anchor-host",
    role: "surface",
    id: "confirmationBridge.dispose",
    stage: "post-server",
  },
  {
    owner: "anchor-host",
    role: "runtime",
    id: "execution.abortAllAndWait",
    stage: "activation",
  },
  {
    owner: "anchor-host",
    role: "runtime",
    id: "conversationProtocol.stopRecovery",
    stage: "activation",
  },
  {
    owner: "anchor-host",
    role: "runtime",
    id: "scheduler.stop",
    stage: "activation",
  },
  {
    owner: "anchor-host",
    role: "runtime",
    id: "inboundRouter.refuseNew",
    stage: "activation",
  },
  {
    owner: "anchor-local-executor",
    role: "runtime",
    id: "evidenceHandler.stopAccepting",
    stage: "activation",
  },
] as const satisfies readonly AssemblyLifecycleDescriptor[];

const ALL_ASSEMBLY_LIFECYCLE_DESCRIPTORS = [
  ...ASSEMBLY_LIFECYCLE_DESCRIPTORS,
  ...ANCHOR_RUNTIME_LIFECYCLE_DESCRIPTORS,
] as const;

export type AssemblyLifecycleIdentity =
  (typeof ALL_ASSEMBLY_LIFECYCLE_DESCRIPTORS)[number]["id"];

interface StoredContribution {
  readonly handle: StartupCleanupHandle;
  transferred: boolean;
}

/**
 * Owns the typed hand-off from startup compensation to normal Host shutdown.
 * The same idempotent handle is used on both paths; this collection never owns
 * product/runtime objects and cannot discover services dynamically.
 */
export class AssemblyLifecycleContributions {
  readonly #rollback: StartupRollback;
  readonly #entries = new Map<AssemblyLifecycleIdentity, StoredContribution>();
  readonly #transferredStages = new Set<AssemblyLifecycleTransferStage>();

  constructor(rollback: StartupRollback) {
    this.#rollback = rollback;
  }

  acquire(
    identity: AssemblyLifecycleIdentity,
    cleanup: () => void | Promise<void>,
  ): StartupCleanupHandle {
    this.#assertCanContribute(identity);
    const handle = this.#rollback.register(identity, cleanup);
    this.#entries.set(identity, { handle, transferred: false });
    return handle;
  }

  contribute(
    identity: AssemblyLifecycleIdentity,
    handle: StartupCleanupHandle,
  ): StartupCleanupHandle {
    this.#assertCanContribute(identity);
    if (handle.name !== identity) {
      throw new Error(
        `Assembly lifecycle handle identity mismatch: expected ${identity}, got ${handle.name}`,
      );
    }
    if (!this.#rollback.owns(handle)) {
      throw new Error(
        `Assembly lifecycle handle does not belong to this StartupRollback: ${identity}`,
      );
    }
    this.#entries.set(identity, { handle, transferred: false });
    return handle;
  }

  has(identity: AssemblyLifecycleIdentity): boolean {
    return this.#entries.has(identity);
  }

  transferTo(
    registry: CleanupRegistry,
    stage: AssemblyLifecycleTransferStage,
  ): void {
    if (this.#transferredStages.has(stage)) {
      throw new Error(`Assembly lifecycle stage already transferred: ${stage}`);
    }
    for (const descriptor of ALL_ASSEMBLY_LIFECYCLE_DESCRIPTORS) {
      if (descriptor.stage !== stage) continue;
      const contribution = this.#entries.get(descriptor.id);
      if (!contribution) continue;
      registerCleanup(registry, descriptor, () => contribution.handle.run());
      contribution.transferred = true;
    }
    this.#transferredStages.add(stage);
  }

  transferExactTo(
    registry: CleanupRegistry,
    stage: "post-server" | "activation",
    expected: readonly AssemblyLifecycleIdentity[],
  ): void {
    const expectedSet = new Set(expected);
    if (expectedSet.size !== expected.length) {
      throw new Error(`Assembly lifecycle expected duplicate ${stage} identity`);
    }
    for (const identity of expectedSet) {
      if (descriptorFor(identity).stage !== stage) {
        throw new Error(
          `Assembly lifecycle identity ${identity} does not belong to stage ${stage}`,
        );
      }
    }
    const actual = ALL_ASSEMBLY_LIFECYCLE_DESCRIPTORS
      .filter((descriptor) => descriptor.stage === stage)
      .map((descriptor) => descriptor.id)
      .filter((identity) => this.#entries.has(identity));
    if (
      actual.length !== expectedSet.size ||
      actual.some((identity) => !expectedSet.has(identity))
    ) {
      throw new Error(
        `Assembly lifecycle ${stage} exact-set mismatch: expected ${[...expectedSet].join(", ") || "none"}; got ${actual.join(", ") || "none"}`,
      );
    }
    this.transferTo(registry, stage);
  }

  assertTransferred(): void {
    const pending = [...this.#entries.entries()]
      .filter(([, contribution]) => !contribution.transferred)
      .map(([identity]) => identity);
    if (pending.length > 0) {
      throw new Error(
        `Assembly lifecycle contributions were not transferred: ${pending.join(", ")}`,
      );
    }
  }

  #assertCanContribute(identity: AssemblyLifecycleIdentity): void {
    const descriptor = descriptorFor(identity);
    if (this.#transferredStages.has(descriptor.stage)) {
      throw new Error(
        `Assembly lifecycle stage "${descriptor.stage}" is already transferred`,
      );
    }
    if (this.#entries.has(identity)) {
      throw new Error(`Assembly lifecycle contribution already exists: ${identity}`);
    }
  }
}

function descriptorFor(
  identity: AssemblyLifecycleIdentity,
): (typeof ALL_ASSEMBLY_LIFECYCLE_DESCRIPTORS)[number] {
  const descriptor = ALL_ASSEMBLY_LIFECYCLE_DESCRIPTORS.find(
    (candidate) => candidate.id === identity,
  );
  if (!descriptor) {
    throw new Error(`Unknown assembly lifecycle contribution: ${identity}`);
  }
  return descriptor;
}
