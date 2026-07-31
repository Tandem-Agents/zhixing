import type {
  CapabilityDescriptor,
  EnvironmentRequirement,
  ExplicitEnvironmentSelection,
  WorksceneDto,
} from "../contracts/index.js";
import type { RuntimeExecutionProfile } from "../types/index.js";
import { validateExplicitEnvironmentSelection } from "../protocol/index.js";
import type { EnvironmentPort } from "../contracts/index.js";

export interface ExecutorEnvironmentCandidate {
  readonly executorId: string;
  readonly deviceId: string;
  readonly descriptor: CapabilityDescriptor;
}

export interface DerivedEnvironmentRequirement {
  readonly deviceId?: string;
  readonly workspace?: { readonly deviceId: string; readonly bindingRef: string };
  readonly credentialBindings?: EnvironmentRequirement["credentialBindings"];
  readonly evidenceKinds?: EnvironmentRequirement["evidenceKinds"];
}

export type ExecutorSelectionResult =
  | {
      readonly kind: "selected";
      readonly executorId: string;
      readonly environment: EnvironmentRequirement;
    }
  | {
      readonly kind: "queued";
      readonly reason:
        | "device-offline"
        | "workspace-unavailable"
        | "capability-unavailable";
      readonly requirement: DerivedEnvironmentRequirement;
    }
  | {
      readonly kind: "selection-required";
      readonly requirement: DerivedEnvironmentRequirement;
      readonly candidates: readonly {
        readonly executorId: string;
        readonly deviceId: string;
      }[];
    };

export interface EnvironmentSourceInput {
  readonly explicit?: ExplicitEnvironmentSelection;
  readonly workscene?: Pick<WorksceneDto, "workspace">;
  readonly frozen?: EnvironmentRequirement;
}

/** Tools whose authority is meaningful only when a runtime owns an explicit workspace root. */
export const WORKSPACE_DEPENDENT_TOOL_IDS = [
  "admit_skill",
  "bash",
  "edit",
  "glob",
  "grep",
  "read",
  "write",
] as const;

const WORKSPACE_DEPENDENT_TOOLS = new Set<string>(
  WORKSPACE_DEPENDENT_TOOL_IDS,
);

export function executionProfileForEnvironment(
  profile: RuntimeExecutionProfile,
  requirement: Pick<DerivedEnvironmentRequirement, "workspace">,
): RuntimeExecutionProfile {
  if (requirement.workspace) {
    return {
      tools: [...profile.tools],
      mcpServers: [...profile.mcpServers],
      providerIds: [...profile.providerIds],
    };
  }
  return {
    tools: profile.tools.filter((tool) => !WORKSPACE_DEPENDENT_TOOLS.has(tool)),
    mcpServers: [...profile.mcpServers],
    providerIds: [...profile.providerIds],
  };
}

/**
 * Resolves the only environment requirement admitted for a run. Higher-priority
 * sources replace lower-priority workspace choices; unrelated requirements are
 * preserved from the frozen task/session requirement.
 */
export function deriveEnvironmentRequirement(
  input: EnvironmentSourceInput,
): DerivedEnvironmentRequirement {
  const explicit = input.explicit
    ? validateExplicitEnvironmentSelection(input.explicit)
    : undefined;
  const frozen = input.frozen ?? {};
  const selected = explicit?.workspace ?? input.workscene?.workspace;
  const workspaceSourcePresent =
    explicit !== undefined || input.workscene !== undefined;
  if (!selected) {
    const inherited = cloneDerivedRequirement(frozen);
    if (!workspaceSourcePresent) return inherited;
    const { workspace: _workspace, ...withoutWorkspace } = inherited;
    return withoutWorkspace;
  }
  return {
    ...cloneDerivedRequirement(frozen),
    deviceId: selected.deviceId,
    workspace: {
      deviceId: selected.deviceId,
      bindingRef: selected.bindingRef,
    },
  };
}

/**
 * Selects deterministically from authenticated capability snapshots and freezes
 * the current workspace revision into the returned requirement.
 */
export function selectExecutorForEnvironment(
  requirement: DerivedEnvironmentRequirement,
  candidates: readonly ExecutorEnvironmentCandidate[],
  preferredExecutorId?: string,
): ExecutorSelectionResult {
  const ordered = [...candidates].sort((left, right) =>
    left.executorId.localeCompare(right.executorId, "en-US"),
  );
  const targetDevice =
    requirement.workspace?.deviceId ?? requirement.deviceId;
  const onDevice =
    targetDevice === undefined
      ? ordered
      : ordered.filter((candidate) => candidate.deviceId === targetDevice);
  if (targetDevice !== undefined && onDevice.length === 0) {
    return {
      kind: "queued",
      reason: "device-offline",
      requirement: cloneDerivedRequirement(requirement),
    };
  }
  const capable = onDevice.filter((candidate) =>
    supportsEnvironmentRequirement(candidate.descriptor, requirement),
  );
  if (onDevice.length > 0 && capable.length === 0) {
    return {
      kind: "queued",
      reason: "capability-unavailable",
      requirement: cloneDerivedRequirement(requirement),
    };
  }
  const eligible = requirement.workspace
    ? capable.filter((candidate) =>
        candidate.descriptor.workspaces.some(
          (entry) => entry.bindingRef === requirement.workspace?.bindingRef,
        ),
      )
    : capable;
  if (requirement.workspace && eligible.length === 0) {
    return {
      kind: "queued",
      reason: "workspace-unavailable",
      requirement: cloneDerivedRequirement(requirement),
    };
  }
  const preferred = eligible.find(
    (candidate) => candidate.executorId === preferredExecutorId,
  );
  const selected = preferred ?? (eligible.length === 1 ? eligible[0] : undefined);
  if (!selected && eligible.length > 1) {
    return {
      kind: "selection-required",
      requirement: cloneDerivedRequirement(requirement),
      candidates: eligible.map(({ executorId, deviceId }) => ({
        executorId,
        deviceId,
      })),
    };
  }
  if (requirement.workspace && selected) {
      const workspace = selected.descriptor.workspaces.find(
        (entry) => entry.bindingRef === requirement.workspace?.bindingRef,
      );
      if (!workspace) {
        throw new TypeError("Selected executor lost its workspace capability");
      }
      return {
        kind: "selected",
        executorId: selected.executorId,
        environment: {
          ...cloneDerivedRequirement(requirement),
          deviceId: selected.deviceId,
          workspace: {
            deviceId: selected.deviceId,
            bindingRef: workspace.bindingRef,
            workspaceBindingRevision: workspace.workspaceBindingRevision,
          },
        },
      };
  }
  return selected
    ? {
        kind: "selected",
        executorId: selected.executorId,
        environment: {
          ...(targetDevice ? { deviceId: targetDevice } : {}),
          ...(requirement.credentialBindings
            ? {
                credentialBindings: requirement.credentialBindings.map(
                  (binding) => ({ ...binding }),
                ),
              }
            : {}),
          ...(requirement.evidenceKinds
            ? { evidenceKinds: [...requirement.evidenceKinds] }
            : {}),
        },
      }
    : {
        kind: "queued",
        reason: "capability-unavailable",
        requirement: cloneDerivedRequirement(requirement),
      };
}

export class ExecutorSelectionRequiredError extends Error {
  readonly candidates: readonly {
    readonly executorId: string;
    readonly deviceId: string;
  }[];

  constructor(
    candidates: readonly {
      readonly executorId: string;
      readonly deviceId: string;
    }[],
  ) {
    super("Conversation environment requires an explicit executor selection");
    this.name = "ExecutorSelectionRequiredError";
    this.candidates = candidates.map((candidate) => ({ ...candidate }));
  }
}

export type WorkspacePreflightResult =
  | {
      readonly ok: true;
      readonly absolutePath?: string;
      readonly state?: "directory" | "missing";
    }
  | {
      readonly ok: false;
      readonly reason:
        | "binding-missing"
        | "revision-conflict"
        | "non-directory"
        | "inaccessible"
        | "probe-error";
    };

/** Re-resolves the executor-local binding immediately before runtime creation. */
export async function preflightWorkspaceRequirement(
  environment: EnvironmentPort,
  requirement: EnvironmentRequirement,
): Promise<WorkspacePreflightResult> {
  if (!requirement.workspace) return { ok: true };
  let resolved: Awaited<ReturnType<EnvironmentPort["resolveWorkspace"]>>;
  try {
    resolved = await environment.resolveWorkspace(
      requirement.workspace.bindingRef,
    );
  } catch {
    return { ok: false, reason: "binding-missing" };
  }
  if (
    resolved.workspaceBindingRevision !==
    requirement.workspace.workspaceBindingRevision
  ) {
    return { ok: false, reason: "revision-conflict" };
  }
  let state: Awaited<ReturnType<EnvironmentPort["probePath"]>>;
  try {
    state = await environment.probePath(resolved.absolutePath);
  } catch {
    return { ok: false, reason: "probe-error" };
  }
  switch (state) {
    case "directory":
      return {
        ok: true,
        absolutePath: resolved.absolutePath,
        state: "directory",
      };
    case "missing":
      return {
        ok: true,
        absolutePath: resolved.absolutePath,
        state: "missing",
      };
    case "non_directory":
      return { ok: false, reason: "non-directory" };
    case "inaccessible":
      return { ok: false, reason: "inaccessible" };
    case "error":
      return { ok: false, reason: "probe-error" };
  }
}

function supportsEnvironmentRequirement(
  descriptor: CapabilityDescriptor,
  requirement: DerivedEnvironmentRequirement,
): boolean {
  const credentials = requirement.credentialBindings ?? [];
  for (const required of credentials) {
    if (
      !descriptor.credentialBindings.some(
        (available) =>
          available.service === required.service &&
          available.bindingId === required.bindingId,
      )
    ) {
      return false;
    }
  }
  const evidence = new Set(descriptor.evidenceCapabilities);
  return (requirement.evidenceKinds ?? []).every((kind) => evidence.has(kind));
}

function cloneDerivedRequirement(
  input: DerivedEnvironmentRequirement,
): DerivedEnvironmentRequirement {
  return {
    ...(input.deviceId ? { deviceId: input.deviceId } : {}),
    ...(input.workspace
      ? { workspace: { ...input.workspace } }
      : {}),
    ...(input.credentialBindings
      ? {
          credentialBindings: input.credentialBindings.map((binding) => ({
            ...binding,
          })),
        }
      : {}),
    ...(input.evidenceKinds
      ? { evidenceKinds: [...input.evidenceKinds] }
      : {}),
  };
}
