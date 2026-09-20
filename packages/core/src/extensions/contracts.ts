/** Shared lifecycle protocol. Business payloads belong to the consuming type. */
export const EXTENSION_PROTOCOL_VERSION = 1 as const;

export interface ExtensionManifest {
  readonly id: string;
  readonly version: string;
  readonly digest: string;
  readonly runtime: "node24";
  readonly entry: string;
  readonly protocol: typeof EXTENSION_PROTOCOL_VERSION;
  readonly type: string;
  readonly contract: number;
  readonly declaration: unknown;
}

export interface ExtensionBinding {
  readonly manifest: ExtensionManifest;
  /** Opaque Configuration / Secret Provider revision; never contains credentials. */
  readonly configurationRevision: string;
  readonly secretRevision: string;
  readonly projectionRevision: string;
  /** Last complete local configuration publication consumed by this binding. */
  readonly sourceRevision?: string;
  /** Type-owned opaque resource identity; enabled instances cannot claim it twice. */
  readonly exclusiveKey?: string;
}

export type ExtensionPhase = "stopped" | "starting" | "running" | "blocked";

export interface ExtensionInstance {
  readonly id: string;
  readonly revision: number;
  readonly enabled: boolean;
  readonly intentRevision: number;
  readonly binding: ExtensionBinding;
  readonly generation: string | null;
  readonly phase: ExtensionPhase;
  readonly reason?: string;
  readonly configurationIssue?: string;
  /** New installations expose only type-owned verification until admission commits. */
  readonly admission?: { readonly operationId: string; readonly ready: boolean };
}

export interface ExtensionSnapshot {
  readonly instances: readonly ExtensionInstance[];
  readonly operations?: readonly ExtensionOperation[];
}

export interface ExtensionOperation {
  readonly id: string;
  readonly instanceId: string;
  readonly revision: number;
  readonly source: { readonly conversationId: string; readonly request: string; readonly returnAddress?: unknown };
  readonly phase: "preparing" | "configuration" | "verifying" | "ready" | "blocked" | "cancelled";
  readonly candidate?: ExtensionManifest;
  /** Opaque type-owned verification checkpoint; no credentials. */
  readonly verification?: unknown;
  readonly reason?: string;
  readonly notifiedRevision?: number;
  /** Existing Conversation admission receipt, interpreted only by its binding. */
  readonly continuation?: unknown;
}

export const extensionOperationActive = (operation: ExtensionOperation) =>
  !["ready", "cancelled"].includes(operation.phase);

export interface ExtensionCandidate {
  readonly manifest: ExtensionManifest;
  readonly code: string;
  readonly provenance: { readonly url: string; readonly revision: string; readonly kind: "existing" | "authored" };
  /** Versioned source and exact build recipe, retained independently of scratch space. */
  readonly sources: Readonly<Record<string, string>>;
  readonly build: string;
}

export type ExtensionManagementRequest =
  | { readonly action: "prepare"; readonly id: string; readonly instanceId: string; readonly source: ExtensionOperation["source"] }
  | { readonly action: "connect"; readonly id: string; readonly expectedRevision: number; readonly candidate: ExtensionCandidate }
  | { readonly action: "cancel"; readonly id: string; readonly expectedRevision: number }
  | { readonly action: "disable"; readonly instanceId: string }
  | { readonly action: "status" };

export function validateExtensionManifest(value: unknown): ExtensionManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid extension manifest");
  }
  const m = value as Record<string, unknown>;
  if (typeof m.id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(m.id) ||
      typeof m.version !== "string" || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(m.version) ||
      typeof m.digest !== "string" || !/^[a-f0-9]{64}$/.test(m.digest) ||
      m.runtime !== "node24" || m.protocol !== EXTENSION_PROTOCOL_VERSION ||
      typeof m.type !== "string" || !/^[a-z][a-z0-9-]*$/.test(m.type) ||
      !Number.isSafeInteger(m.contract) || (m.contract as number) < 1 ||
      typeof m.entry !== "string" || !/^[a-zA-Z0-9_-]+\.mjs$/.test(m.entry)) {
    throw new TypeError("Unsupported or malformed extension manifest");
  }
  return Object.freeze(structuredClone(m)) as unknown as ExtensionManifest;
}

export function validateExtensionBinding(binding: ExtensionBinding): ExtensionBinding {
  validateExtensionManifest(binding.manifest);
  if (binding.exclusiveKey !== undefined && !/^[a-f0-9]{64}$/.test(binding.exclusiveKey)) throw new TypeError("Invalid extension exclusive identity");
  for (const revision of [binding.configurationRevision, binding.secretRevision, binding.projectionRevision, ...(binding.sourceRevision === undefined ? [] : [binding.sourceRevision])]) {
    if (typeof revision !== "string" || revision.length === 0 || revision.length > 256) {
      throw new TypeError("Extension binding requires complete source revisions");
    }
  }
  return structuredClone(binding);
}

export interface ExtensionInvocation {
  readonly method: string;
  readonly payload: unknown;
}

/** A finite, host-owned binding; an executable cannot register services. */
export interface ExtensionTypeBinding {
  readonly type: string;
  readonly contract: number;
  validate(manifest: ExtensionManifest, projection: unknown): void;
  receive(invocation: ExtensionInvocation): Promise<unknown>;
  close(): void;
}

export interface ExtensionProcess {
  readonly generation: string;
  call(method: string, payload: unknown): Promise<unknown>;
  stop(): Promise<void>;
}
