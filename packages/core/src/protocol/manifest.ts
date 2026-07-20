import type {
  AuthorityError,
  CapabilityDescriptor,
  CredentialBindingDescriptor,
  Digest,
  ExecutionKind,
  ExecutionManifest,
  ExecutorVersionInventory,
  ProtocolVersion,
  Signature,
} from "../contracts/index.js";
import {
  canonicalize,
  compareCanonicalStrings,
  protocolDigest,
} from "./canonical.js";
import type {
  ProtocolSignatureVerifier,
  ProtocolSigner,
} from "./signature.js";
import {
  assertProtocolIdentifier as assertIdentifier,
  validateProtocolVersion,
} from "./validation.js";
import { validateEnvironmentRequirement } from "./values.js";

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
export const EXECUTION_PROTOCOL_VERSION: ProtocolVersion = "1";
const EVIDENCE_KINDS = new Set([
  "file-diff",
  "test-result",
  "build-result",
  "log",
  "artifact",
  "conversation-fact",
  "none",
]);
const DEVICE_VERSION_FIELDS = [
  "runtimeConfigRev",
  "modelProfileRev",
  "policyRev",
  "skillsRev",
  "rubricsRev",
  "promptAssetsRev",
] as const;
const MANIFEST_VERSION_FIELDS = [
  ...DEVICE_VERSION_FIELDS,
  "permissionSnapshotVersion",
] as const;

type ManifestRequirements = ExecutionManifest["requires"];

export type ManifestMatchResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: AuthorityError };

export interface ExecutorCapabilitySnapshot {
  readonly descriptor: CapabilityDescriptor;
  readonly inventory: ExecutorVersionInventory;
}

export type ExecutorSnapshotUpdateResult =
  | {
      readonly ok: true;
      readonly status: "accepted" | "replayed";
      readonly snapshot: ExecutorCapabilitySnapshot;
    }
  | { readonly ok: false; readonly error: AuthorityError };

export interface ExecutorCapabilityDirectoryStore {
  load(): Promise<ExecutorCapabilityDirectoryState | undefined>;
  save(
    state: ExecutorCapabilityDirectoryState,
    expectedGeneration: number,
  ): Promise<void>;
}

export interface ExecutorCapabilityDirectoryState {
  readonly v: 1;
  readonly generation: number;
  readonly executors: readonly ExecutorCapabilityDirectoryEntry[];
}

export interface ExecutorCapabilityDirectoryEntry {
  readonly executorId: string;
  readonly deviceKeyId: string;
  readonly active: boolean;
  readonly snapshot?: ExecutorCapabilitySnapshot;
  readonly descriptorRevisionHighWater: number;
  readonly inventoryRevisionHighWater: number;
  readonly versionHighWater: Readonly<
    Record<(typeof DEVICE_VERSION_FIELDS)[number], number>
  >;
  readonly permissionSnapshotHighWater: number;
  readonly credentialBindingHighWater: readonly ExecutorCredentialBindingHistory[];
}

export interface ExecutorCredentialBindingHistory {
  readonly binding: CredentialBindingDescriptor;
  readonly active: boolean;
}

export interface ExecutorCapabilityDirectoryOptions {
  readonly verifier: ProtocolSignatureVerifier;
  readonly store: ExecutorCapabilityDirectoryStore;
  readonly isDeviceAuthorized: (deviceKeyId: string) => boolean;
  /** Only the authority that proved this is a first bootstrap may create empty state. */
  readonly allowInitialize?: boolean;
}

/**
 * Verified capability advertisements used by owner preselection and executor admission.
 * The directory stores metadata only; snapshot content becomes visible after its local
 * configuration, assets and permission rules are ready.
 */
export class ExecutorCapabilityDirectory {
  readonly #verifier: ProtocolSignatureVerifier;
  readonly #store: ExecutorCapabilityDirectoryStore;
  readonly #isDeviceAuthorized: (deviceKeyId: string) => boolean;
  #entries: Map<string, ExecutorCapabilityDirectoryEntry>;
  #generation: number;

  private constructor(
    options: ExecutorCapabilityDirectoryOptions,
    state: ExecutorCapabilityDirectoryState,
  ) {
    this.#verifier = options.verifier;
    this.#store = options.store;
    this.#isDeviceAuthorized = options.isDeviceAuthorized;
    this.#entries = new Map(state.executors.map((entry) => [entry.executorId, entry]));
    this.#generation = state.generation;
  }

  static async open(
    options: ExecutorCapabilityDirectoryOptions,
  ): Promise<ExecutorCapabilityDirectory> {
    const loaded = await options.store.load();
    if (loaded === undefined && options.allowInitialize !== true) {
      throw new TypeError("Executor capability directory state is missing");
    }
    const state = validateExecutorCapabilityDirectoryState(
      loaded ?? { v: 1, generation: 0, executors: [] },
      options.verifier,
    );
    return new ExecutorCapabilityDirectory(options, state);
  }

  async accept(incoming: ExecutorCapabilitySnapshot): Promise<ExecutorSnapshotUpdateResult> {
    const verified = validateExecutorCapabilitySnapshot(incoming, this.#verifier);
    const executorId = verified.descriptor.executorId;
    const deviceKeyId = verified.descriptor.signature.keyId;
    const current = this.#entries.get(executorId);
    if (!this.#deviceIsAuthorized(deviceKeyId)) {
      return mismatch("capability-gap", "Executor device is not currently authorized");
    }
    if (current !== undefined && current.deviceKeyId !== deviceKeyId) {
      return mismatch("revision-conflict", "Executor identity is bound to another device");
    }
    if (current !== undefined && !current.active) {
      return mismatch("capability-gap", "Executor identity is inactive");
    }
    const result = acceptExecutorCapabilitySnapshot(
      current?.snapshot,
      verified,
      this.#verifier,
    );
    if (!result.ok) return result;
    const highWaterConflict = validateDirectoryHighWater(current, result.snapshot);
    if (highWaterConflict !== undefined) return highWaterConflict;
    if (result.status === "replayed" && current?.snapshot !== undefined) {
      return {
        ...result,
        snapshot: snapshot(current.snapshot, "Executor capability snapshot"),
      };
    }
    const nextEntry = directoryEntryFromSnapshot(current, result.snapshot);
    const nextEntries = new Map(this.#entries);
    nextEntries.set(executorId, nextEntry);
    await this.#commit(nextEntries);
    if (nextEntry.snapshot === undefined) {
      throw new TypeError("Accepted executor snapshot was not retained");
    }
    return {
      ...result,
      snapshot: snapshot(nextEntry.snapshot, "Executor capability snapshot"),
    };
  }

  snapshotFor(executorId: string): ExecutorCapabilitySnapshot | undefined {
    const entry = this.#entries.get(executorId);
    return entry === undefined || !entry.active || entry.snapshot === undefined ||
        !this.#deviceIsAuthorized(entry.deviceKeyId)
      ? undefined
      : snapshot(entry.snapshot, "Executor capability snapshot");
  }

  async revokeDevice(deviceKeyId: string): Promise<void> {
    const nextEntries = new Map(this.#entries);
    let changed = false;
    for (const [executorId, entry] of nextEntries) {
      if (entry.deviceKeyId === deviceKeyId && entry.active) {
        nextEntries.set(executorId, { ...entry, active: false });
        changed = true;
      }
    }
    if (changed) await this.#commit(nextEntries);
  }

  async transitionExecutorDevice(
    executorId: string,
    expectedDeviceKeyId: string,
    nextDeviceKeyId: string,
  ): Promise<void> {
    assertIdentifier(executorId, "Executor transition executorId");
    assertIdentifier(expectedDeviceKeyId, "Executor transition current device key");
    assertIdentifier(nextDeviceKeyId, "Executor transition next device key");
    const current = this.#entries.get(executorId);
    if (current === undefined || current.deviceKeyId !== expectedDeviceKeyId) {
      throw new TypeError("Executor device transition does not match durable lineage");
    }
    if (!this.#deviceIsAuthorized(nextDeviceKeyId)) {
      throw new TypeError("Executor device transition target is not authorized");
    }
    const nextEntries = new Map(this.#entries);
    const { snapshot: _, ...withoutCurrentSnapshot } = current;
    nextEntries.set(executorId, {
      ...withoutCurrentSnapshot,
      deviceKeyId: nextDeviceKeyId,
      active: true,
    });
    await this.#commit(nextEntries);
  }

  #deviceIsAuthorized(deviceKeyId: string): boolean {
    try {
      return this.#isDeviceAuthorized(deviceKeyId) === true;
    } catch {
      return false;
    }
  }

  async #commit(nextEntries: Map<string, ExecutorCapabilityDirectoryEntry>): Promise<void> {
    const state = validateExecutorCapabilityDirectoryState(
      {
        v: 1,
        generation: this.#generation + 1,
        executors: [...nextEntries.values()].sort((a, b) =>
          compareCanonicalStrings(a.executorId, b.executorId)),
      },
      this.#verifier,
    );
    await this.#store.save(state, this.#generation);
    this.#entries = new Map(state.executors.map((entry) => [entry.executorId, entry]));
    this.#generation = state.generation;
  }
}

export function validateExecutorCapabilityDirectoryState(
  input: unknown,
  verifier: ProtocolSignatureVerifier,
): ExecutorCapabilityDirectoryState {
  const state = snapshot(input, "Executor capability directory state") as
    ExecutorCapabilityDirectoryState;
  assertExactKeys(
    state,
    ["executors", "generation", "v"],
    "Executor capability directory state",
  );
  assertVersion(state.v, "Executor capability directory state");
  assertNonNegativeInteger(state.generation, "Executor capability directory generation");
  assertDenseArray(state.executors, "Executor capability directory entries");
  const executorIds = new Set<string>();
  const entries: ExecutorCapabilityDirectoryEntry[] = [];
  for (const value of state.executors) {
    assertPlainRecord(value, "Executor capability directory entry");
    assertAllowedKeys(
      value,
      [
        "active",
        "credentialBindingHighWater",
        "descriptorRevisionHighWater",
        "deviceKeyId",
        "executorId",
        "inventoryRevisionHighWater",
        "permissionSnapshotHighWater",
        "snapshot",
        "versionHighWater",
      ],
      "Executor capability directory entry",
    );
    for (const key of [
      "active",
      "credentialBindingHighWater",
      "descriptorRevisionHighWater",
      "deviceKeyId",
      "executorId",
      "inventoryRevisionHighWater",
      "permissionSnapshotHighWater",
      "versionHighWater",
    ] as const) {
      if (!(key in value)) {
        throw new TypeError("Executor capability directory entry is incomplete");
      }
    }
    assertIdentifier(value.executorId, "Directory executorId");
    assertIdentifier(value.deviceKeyId, "Directory device key id");
    if (typeof value.active !== "boolean") {
      throw new TypeError("Directory executor active flag is invalid");
    }
    assertPositiveInteger(
      value.descriptorRevisionHighWater,
      "Directory capability revision high water",
    );
    assertPositiveInteger(
      value.inventoryRevisionHighWater,
      "Directory inventory revision high water",
    );
    assertPositiveInteger(
      value.permissionSnapshotHighWater,
      "Directory permission snapshot high water",
    );
    validateVersionHighWater(value.versionHighWater);
    assertDenseArray(
      value.credentialBindingHighWater,
      "Directory credential binding high water",
    );
    const bindingIds = new Set<string>();
    const validatedBindingHighWater: ExecutorCredentialBindingHistory[] = [];
    for (const rawHistory of value.credentialBindingHighWater) {
      assertPlainRecord(rawHistory, "Directory credential binding history");
      assertExactKeys(
        rawHistory,
        ["active", "binding"],
        "Directory credential binding history",
      );
      if (typeof rawHistory.active !== "boolean") {
        throw new TypeError("Directory credential binding active flag is invalid");
      }
      const binding = validateCredentialBindingDescriptor(rawHistory.binding);
      if (bindingIds.has(binding.bindingId)) {
        throw new TypeError("Directory credential binding high water must be unique");
      }
      bindingIds.add(binding.bindingId);
      validatedBindingHighWater.push({ active: rawHistory.active, binding });
    }
    assertSorted(
      validatedBindingHighWater,
      (history) => history.binding.bindingId,
      "Directory credential binding high water",
    );
    const currentSnapshot = value.snapshot === undefined
      ? undefined
      : validateExecutorCapabilitySnapshot(value.snapshot, verifier);
    if (currentSnapshot !== undefined) {
      if (
        currentSnapshot.descriptor.executorId !== value.executorId ||
        currentSnapshot.descriptor.signature.keyId !== value.deviceKeyId ||
        currentSnapshot.descriptor.revision !== value.descriptorRevisionHighWater ||
        currentSnapshot.inventory.inventoryRevision !== value.inventoryRevisionHighWater
      ) {
        throw new TypeError("Directory snapshot does not fit its durable identity or high water");
      }
      for (const field of DEVICE_VERSION_FIELDS) {
        if (inventoryVersion(currentSnapshot.inventory, field) !== value.versionHighWater[field]) {
          throw new TypeError("Directory snapshot does not match its version high water");
        }
      }
      if (
        currentSnapshot.inventory.permissionSnapshotHighWater !==
        value.permissionSnapshotHighWater
      ) {
        throw new TypeError(
          "Directory snapshot does not match its permission snapshot high water",
        );
      }
      const currentBindings = new Map(
        currentSnapshot.descriptor.credentialBindings.map((binding) => [
          binding.bindingId,
          binding,
        ]),
      );
      for (const history of validatedBindingHighWater) {
        const currentBinding = currentBindings.get(history.binding.bindingId);
        if (
          history.active !== (currentBinding !== undefined) ||
          (currentBinding !== undefined &&
            canonicalize(currentBinding) !== canonicalize(history.binding))
        ) {
          throw new TypeError(
            "Directory credential binding history does not match its current snapshot",
          );
        }
      }
      if (
        currentSnapshot.descriptor.credentialBindings.some(
          (binding) => !bindingIds.has(binding.bindingId),
        )
      ) {
        throw new TypeError("Directory snapshot lacks credential binding history");
      }
    }
    if (executorIds.has(value.executorId)) {
      throw new TypeError("Executor capability directory entries must be unique");
    }
    executorIds.add(value.executorId);
    entries.push({
      executorId: value.executorId,
      deviceKeyId: value.deviceKeyId,
      active: value.active,
      ...(currentSnapshot === undefined ? {} : { snapshot: currentSnapshot }),
      descriptorRevisionHighWater: value.descriptorRevisionHighWater,
      inventoryRevisionHighWater: value.inventoryRevisionHighWater,
      versionHighWater: snapshot(value.versionHighWater, "Directory version high water"),
      permissionSnapshotHighWater: value.permissionSnapshotHighWater,
      credentialBindingHighWater: snapshot(
        validatedBindingHighWater,
        "Directory credential binding high water",
      ),
    });
  }
  assertSorted(entries, (entry) => entry.executorId, "Executor capability directory entries");
  return snapshot(
    { v: 1 as const, generation: state.generation, executors: entries },
    "Executor capability directory state",
  );
}

function validateDirectoryHighWater(
  current: ExecutorCapabilityDirectoryEntry | undefined,
  incoming: ExecutorCapabilitySnapshot,
): Extract<ExecutorSnapshotUpdateResult, { readonly ok: false }> | undefined {
  if (current === undefined) return undefined;
  const requiresFreshSnapshot = current.snapshot === undefined;
  if (
    incoming.descriptor.revision < current.descriptorRevisionHighWater ||
    incoming.inventory.inventoryRevision < current.inventoryRevisionHighWater ||
    (requiresFreshSnapshot &&
      (incoming.descriptor.revision === current.descriptorRevisionHighWater ||
        incoming.inventory.inventoryRevision === current.inventoryRevisionHighWater))
  ) {
    return mismatch("revision-conflict", "Executor snapshot moved behind durable high water");
  }
  for (const field of DEVICE_VERSION_FIELDS) {
    if (inventoryVersion(incoming.inventory, field) < current.versionHighWater[field]) {
      return mismatch(
        "revision-conflict",
        `Execution snapshot version moved behind durable high water: ${field}`,
      );
    }
  }
  if (
    incoming.inventory.permissionSnapshotHighWater <
    current.permissionSnapshotHighWater
  ) {
    return mismatch(
      "revision-conflict",
      "Permission snapshot high water moved behind durable high water",
    );
  }
  const history = new Map(
    current.credentialBindingHighWater.map((entry) => [entry.binding.bindingId, entry]),
  );
  for (const binding of incoming.descriptor.credentialBindings) {
    const previousEntry = history.get(binding.bindingId);
    if (previousEntry === undefined) continue;
    const previous = previousEntry.binding;
    if (binding.revision < previous.revision) {
      return mismatch("revision-conflict", "Credential binding moved behind durable high water");
    }
    if (
      binding.revision === previous.revision &&
      canonicalize(withoutField(binding, "revision")) !==
        canonicalize(withoutField(previous, "revision"))
    ) {
      return mismatch("revision-conflict", "Credential binding revision was rewritten");
    }
    if (!previousEntry.active && binding.revision === previous.revision) {
      return mismatch(
        "revision-conflict",
        "Credential binding must advance its revision after deletion",
      );
    }
  }
  return undefined;
}

function directoryEntryFromSnapshot(
  current: ExecutorCapabilityDirectoryEntry | undefined,
  next: ExecutorCapabilitySnapshot,
): ExecutorCapabilityDirectoryEntry {
  const credentialHistory = new Map(
    (current?.credentialBindingHighWater ?? []).map((entry) => [
      entry.binding.bindingId,
      { ...entry, active: false },
    ]),
  );
  for (const binding of next.descriptor.credentialBindings) {
    credentialHistory.set(binding.bindingId, { active: true, binding });
  }
  const versionHighWater = Object.fromEntries(
    DEVICE_VERSION_FIELDS.map((field) => [
      field,
      Math.max(current?.versionHighWater[field] ?? 0, inventoryVersion(next.inventory, field)),
    ]),
  ) as Record<(typeof DEVICE_VERSION_FIELDS)[number], number>;
  return snapshot(
    {
      executorId: next.descriptor.executorId,
      deviceKeyId: next.descriptor.signature.keyId,
      active: true,
      snapshot: next,
      descriptorRevisionHighWater: Math.max(
        current?.descriptorRevisionHighWater ?? 0,
        next.descriptor.revision,
      ),
      inventoryRevisionHighWater: Math.max(
        current?.inventoryRevisionHighWater ?? 0,
        next.inventory.inventoryRevision,
      ),
      versionHighWater,
      permissionSnapshotHighWater: Math.max(
        current?.permissionSnapshotHighWater ?? 0,
        next.inventory.permissionSnapshotHighWater,
      ),
      credentialBindingHighWater: [...credentialHistory.values()].sort((a, b) =>
        compareCanonicalStrings(a.binding.bindingId, b.binding.bindingId)),
    },
    "Executor capability directory entry",
  );
}

function validateVersionHighWater(
  input: unknown,
): asserts input is Record<(typeof DEVICE_VERSION_FIELDS)[number], number> {
  assertPlainRecord(input, "Directory version high water");
  assertExactKeys(input, DEVICE_VERSION_FIELDS, "Directory version high water");
  for (const field of DEVICE_VERSION_FIELDS) {
    assertPositiveInteger(input[field], `Directory ${field} high water`);
  }
}

export function createExecutionManifest<E extends ExecutionKind>(
  input: Omit<ExecutionManifest<E>, "digest" | "v">,
): ExecutionManifest<E> {
  const payload = snapshot({ v: 1 as const, ...input }, "Execution manifest payload");
  return validateExecutionManifest({
    ...payload,
    digest: protocolDigest("ExecutionManifest", 1, payload),
  }) as ExecutionManifest<E>;
}

export function validateExecutionManifest(
  input: unknown,
): ExecutionManifest {
  const manifest = snapshot(input, "Execution manifest") as ExecutionManifest;
  assertExactKeys(
    manifest,
    [
      "baseRef",
      "credentialBindings",
      "digest",
      "environment",
      "mcpServers",
      "protocolVersion",
      "requires",
      "tools",
      "v",
    ],
    "Execution manifest",
  );
  assertVersion(manifest.v, "Execution manifest");
  assertPlainRecord(manifest.baseRef, "Manifest base reference");
  if (manifest.baseRef.execution === "conversation") {
    assertExactKeys(
      manifest.baseRef,
      ["baseRevision", "conversationId", "execution"],
      "Manifest base reference",
    );
    assertIdentifier(manifest.baseRef.conversationId, "Manifest conversationId");
    assertNonNegativeInteger(manifest.baseRef.baseRevision, "Manifest baseRevision");
  } else if (manifest.baseRef.execution === "job") {
    assertExactKeys(
      manifest.baseRef,
      ["execution", "jobRunId", "taskId", "taskRevision"],
      "Manifest base reference",
    );
    assertIdentifier(manifest.baseRef.jobRunId, "Manifest jobRunId");
    assertIdentifier(manifest.baseRef.taskId, "Manifest taskId");
    assertPositiveInteger(manifest.baseRef.taskRevision, "Manifest taskRevision");
  } else {
    throw new TypeError("Manifest base reference execution kind is invalid");
  }
  validateProtocolVersion(manifest.protocolVersion);
  validateRequirements(manifest.requires);
  assertIdentifierArray(manifest.tools, "Manifest tools");
  assertIdentifierArray(manifest.mcpServers, "Manifest MCP servers");
  validateEnvironmentRequirement(manifest.environment);
  assertDenseArray(manifest.credentialBindings, "Manifest credential bindings");
  const bindingIds = new Set<string>();
  for (const binding of manifest.credentialBindings) {
    assertPlainRecord(binding, "Manifest credential binding");
    assertExactKeys(
      binding,
      ["bindingId", "revision", "service"],
      "Manifest credential binding",
    );
    assertIdentifier(binding.service, "Manifest credential service");
    assertIdentifier(binding.bindingId, "Manifest credential bindingId");
    assertPositiveInteger(binding.revision, "Manifest credential binding revision");
    if (bindingIds.has(binding.bindingId)) {
      throw new TypeError("Manifest credential binding ids must be unique");
    }
    bindingIds.add(binding.bindingId);
  }
  assertSorted(
    manifest.credentialBindings,
    (binding) => bindingKey(binding.service, binding.bindingId),
    "Manifest credential bindings",
  );
  assertDigest(manifest.digest, "Execution manifest digest");
  const expected = protocolDigest(
    "ExecutionManifest",
    1,
    withoutField(manifest, "digest"),
  );
  if (manifest.digest !== expected) {
    throw new TypeError("Execution manifest digest is invalid");
  }
  assertEnvironmentCredentialClosure(manifest);
  return manifest;
}

export function createSignedCapabilityDescriptor(
  input: Omit<CapabilityDescriptor, "signature" | "v">,
  signer: ProtocolSigner,
): CapabilityDescriptor {
  const payload = snapshot(
    { v: 1 as const, ...input },
    "Capability descriptor payload",
  );
  return validateCapabilityDescriptor({
    ...payload,
    signature: signer.sign("CapabilityDescriptor", 1, payload),
  });
}

export function validateCapabilityDescriptor(
  input: unknown,
  verifier?: ProtocolSignatureVerifier,
): CapabilityDescriptor {
  const descriptor = snapshot(input, "Capability descriptor") as CapabilityDescriptor;
  assertExactKeys(
    descriptor,
    [
      "at",
      "credentialBindings",
      "evidenceCapabilities",
      "executorId",
      "mcpServers",
      "protocolVersion",
      "revision",
      "signature",
      "tools",
      "v",
      "workspaces",
    ],
    "Capability descriptor",
  );
  assertVersion(descriptor.v, "Capability descriptor");
  assertIdentifier(descriptor.executorId, "Capability executorId");
  assertPositiveInteger(descriptor.revision, "Capability revision");
  validateProtocolVersion(descriptor.protocolVersion);
  assertCanonicalTime(descriptor.at, "Capability timestamp");
  assertSignature(descriptor.signature, "Capability signature");

  assertDenseArray(descriptor.workspaces, "Capability workspaces");
  const workspaces = new Set<string>();
  for (const workspace of descriptor.workspaces) {
    assertPlainRecord(workspace, "Capability workspace");
    assertExactKeys(
      workspace,
      ["bindingRef", "displayName", "workspaceBindingRevision"],
      "Capability workspace",
    );
    assertIdentifier(workspace.bindingRef, "Workspace bindingRef");
    assertPositiveInteger(
      workspace.workspaceBindingRevision,
      "Workspace binding revision",
    );
    assertBoundedString(workspace.displayName, "Workspace display name");
    if (workspaces.has(workspace.bindingRef)) {
      throw new TypeError("Capability workspaces must be unique");
    }
    workspaces.add(workspace.bindingRef);
  }
  assertSorted(descriptor.workspaces, (workspace) => workspace.bindingRef, "Capability workspaces");
  assertIdentifierArray(descriptor.tools, "Capability tools");
  assertIdentifierArray(descriptor.mcpServers, "Capability MCP servers");

  assertDenseArray(descriptor.credentialBindings, "Capability credential bindings");
  const bindings = new Set<string>();
  for (const binding of descriptor.credentialBindings) {
    validateCredentialBindingDescriptor(binding);
    if (bindings.has(binding.bindingId)) {
      throw new TypeError("Capability credential binding ids must be unique");
    }
    bindings.add(binding.bindingId);
  }
  assertSorted(
    descriptor.credentialBindings,
    (binding) => binding.bindingId,
    "Capability credential bindings",
  );

  assertDenseArray(descriptor.evidenceCapabilities, "Capability evidence kinds");
  for (const kind of descriptor.evidenceCapabilities) {
    if (typeof kind !== "string" || !EVIDENCE_KINDS.has(kind)) {
      throw new TypeError("Capability evidence kind is invalid");
    }
  }
  assertSorted(descriptor.evidenceCapabilities, (kind) => kind, "Capability evidence kinds");
  assertUnique(descriptor.evidenceCapabilities, "Capability evidence kinds");
  verifier?.verify(
    "CapabilityDescriptor",
    1,
    withoutField(descriptor, "signature"),
    descriptor.signature,
  );
  return descriptor;
}

export function validateCredentialBindingDescriptor(
  input: unknown,
): CredentialBindingDescriptor {
  const binding = snapshot(input, "Credential binding descriptor") as CredentialBindingDescriptor;
  assertAllowedKeys(
    binding,
    [
      "bindingId",
      "principalFingerprint",
      "resource",
      "revision",
      "scopes",
      "service",
      "tenant",
      "verification",
    ],
    "Credential binding descriptor",
  );
  for (const key of ["bindingId", "revision", "service", "verification"] as const) {
    if (!(key in binding)) {
      throw new TypeError("Credential binding descriptor is incomplete");
    }
  }
  assertIdentifier(binding.bindingId, "Credential bindingId");
  assertIdentifier(binding.service, "Credential service");
  assertPositiveInteger(binding.revision, "Credential binding revision");
  if (
    binding.verification !== "service-verified" &&
    binding.verification !== "user-alias"
  ) {
    throw new TypeError("Credential binding verification is invalid");
  }
  if (binding.resource !== undefined) {
    assertIdentifier(binding.resource, "Credential resource");
  }
  if (binding.tenant !== undefined) {
    assertIdentifier(binding.tenant, "Credential tenant");
  }
  if (binding.principalFingerprint !== undefined) {
    assertDigest(binding.principalFingerprint, "Credential principal fingerprint");
    if (binding.verification !== "service-verified") {
      throw new TypeError("User-alias credentials cannot claim a verified principal");
    }
  }
  if (binding.scopes !== undefined) {
    assertIdentifierArray(binding.scopes, "Credential scopes");
  }
  return binding;
}

export function createSignedExecutorVersionInventory(
  input: Omit<ExecutorVersionInventory, "signature" | "v">,
  signer: ProtocolSigner,
): ExecutorVersionInventory {
  const payload = snapshot(
    { v: 1 as const, ...input },
    "Executor version inventory payload",
  );
  return validateExecutorVersionInventory({
    ...payload,
    signature: signer.sign("ExecutorVersionInventory", 1, payload),
  });
}

export function validateExecutorVersionInventory(
  input: unknown,
  verifier?: ProtocolSignatureVerifier,
): ExecutorVersionInventory {
  const inventory = snapshot(input, "Executor version inventory") as ExecutorVersionInventory;
  assertExactKeys(
    inventory,
    [
      "assetVersions",
      "at",
      "capabilityRevision",
      "configVersions",
      "credentialBindingRevisions",
      "executorId",
      "inventoryRevision",
      "permissionSnapshotHighWater",
      "signature",
      "v",
    ],
    "Executor version inventory",
  );
  assertVersion(inventory.v, "Executor version inventory");
  assertIdentifier(inventory.executorId, "Inventory executorId");
  assertPositiveInteger(inventory.inventoryRevision, "Inventory revision");
  assertPositiveInteger(inventory.capabilityRevision, "Inventory capability revision");
  validateDeviceVersions({ ...inventory.configVersions, ...inventory.assetVersions });
  assertPositiveInteger(
    inventory.permissionSnapshotHighWater,
    "Inventory permission snapshot high water",
  );
  assertDenseArray(
    inventory.credentialBindingRevisions,
    "Inventory credential binding revisions",
  );
  const bindingIds = new Set<string>();
  for (const binding of inventory.credentialBindingRevisions) {
    assertPlainRecord(binding, "Inventory credential binding revision");
    assertExactKeys(
      binding,
      ["bindingId", "revision"],
      "Inventory credential binding revision",
    );
    assertIdentifier(binding.bindingId, "Inventory credential bindingId");
    assertPositiveInteger(binding.revision, "Inventory credential revision");
    if (bindingIds.has(binding.bindingId)) {
      throw new TypeError("Inventory credential binding ids must be unique");
    }
    bindingIds.add(binding.bindingId);
  }
  assertSorted(
    inventory.credentialBindingRevisions,
    (binding) => binding.bindingId,
    "Inventory credential binding revisions",
  );
  assertCanonicalTime(inventory.at, "Inventory timestamp");
  assertSignature(inventory.signature, "Inventory signature");
  verifier?.verify(
    "ExecutorVersionInventory",
    1,
    withoutField(inventory, "signature"),
    inventory.signature,
  );
  return inventory;
}

/**
 * Single manifest compatibility predicate used by owner preselection and executor admission.
 * Signature trust is established by the adapter before invoking this pure function.
 */
export function matchManifest(
  rawManifest: ExecutionManifest,
  rawDescriptor: CapabilityDescriptor,
  rawInventory: ExecutorVersionInventory,
): ManifestMatchResult {
  const manifest = validateExecutionManifest(rawManifest);
  const descriptor = validateCapabilityDescriptor(rawDescriptor);
  const inventory = validateExecutorVersionInventory(rawInventory);

  const snapshotConsistencyError = executorSnapshotConsistencyError(
    descriptor,
    inventory,
  );
  if (snapshotConsistencyError !== undefined) {
    return { ok: false, error: snapshotConsistencyError };
  }
  if (descriptor.protocolVersion !== manifest.protocolVersion) {
    return mismatch(
      "capability-gap",
      "Executor protocol version is incompatible with the manifest",
    );
  }
  const availableTools = new Set(descriptor.tools);
  for (const tool of manifest.tools) {
    if (!availableTools.has(tool)) {
      return mismatch("capability-gap", "Required tool is unavailable");
    }
  }
  const availableMcpServers = new Set(descriptor.mcpServers);
  for (const server of manifest.mcpServers) {
    if (!availableMcpServers.has(server)) {
      return mismatch("capability-gap", "Required MCP server is unavailable");
    }
  }
  for (const field of DEVICE_VERSION_FIELDS) {
    const actual = inventoryVersion(inventory, field);
    if (manifest.requires[field] !== actual) {
      return mismatch(
        "revision-conflict",
        `Execution snapshot revision mismatch: ${field}`,
      );
    }
  }
  if (
    manifest.requires.permissionSnapshotVersion >
    inventory.permissionSnapshotHighWater
  ) {
    return mismatch(
      "capability-gap",
      "Required permission snapshot is not locally ready",
    );
  }

  const targetDevice = manifest.environment.workspace?.deviceId ??
    manifest.environment.deviceId;
  if (targetDevice !== undefined && targetDevice !== descriptor.signature.keyId) {
    return mismatch("capability-gap", "Execution target device is unavailable");
  }
  const requiredWorkspace = manifest.environment.workspace;
  if (requiredWorkspace) {
    const available = descriptor.workspaces.find(
      (workspace) => workspace.bindingRef === requiredWorkspace.bindingRef,
    );
    if (
      !available ||
      available.workspaceBindingRevision !== requiredWorkspace.workspaceBindingRevision
    ) {
      return mismatch("revision-conflict", "Workspace binding revision is unavailable");
    }
  }

  const inventoryBindings = new Map(
    inventory.credentialBindingRevisions.map((binding) => [binding.bindingId, binding.revision]),
  );
  for (const required of manifest.credentialBindings) {
    const available = descriptor.credentialBindings.find(
      (binding) => binding.bindingId === required.bindingId,
    );
    if (!available || available.service !== required.service) {
      return mismatch("capability-gap", "Required credential binding is unavailable");
    }
    if (
      available.revision !== required.revision ||
      inventoryBindings.get(required.bindingId) !== required.revision
    ) {
      return mismatch("revision-conflict", "Credential binding revision is stale");
    }
  }

  const availableEvidence = new Set(descriptor.evidenceCapabilities);
  for (const kind of manifest.environment.evidenceKinds ?? []) {
    if (!availableEvidence.has(kind)) {
      return mismatch("capability-gap", "Required evidence capability is unavailable");
    }
  }
  return { ok: true };
}

/**
 * Accepts a signed descriptor/inventory pair as one versioned metadata snapshot.
 * Content transfer is deliberately outside this gate; publishers advance inventory only
 * after the referenced configuration, assets and permission snapshot are locally ready.
 */
export function acceptExecutorCapabilitySnapshot(
  previous: ExecutorCapabilitySnapshot | undefined,
  incoming: ExecutorCapabilitySnapshot,
  verifier: ProtocolSignatureVerifier,
): ExecutorSnapshotUpdateResult {
  const next = validateExecutorCapabilitySnapshot(incoming, verifier);
  if (!previous) {
    return { ok: true, status: "accepted", snapshot: next };
  }
  const current = validateExecutorCapabilitySnapshot(previous, verifier);
  if (current.descriptor.executorId !== next.descriptor.executorId) {
    return mismatch("revision-conflict", "Executor snapshot identity changed");
  }
  const currentPayload = snapshotPayload(current);
  const nextPayload = snapshotPayload(next);
  if (
    current.descriptor.revision === next.descriptor.revision &&
    canonicalize(withoutSignatureAndTime(current.descriptor)) !==
      canonicalize(withoutSignatureAndTime(next.descriptor))
  ) {
    return mismatch("revision-conflict", "Capability descriptor revision was rewritten");
  }
  if (
    current.descriptor.revision === next.descriptor.revision &&
    current.inventory.inventoryRevision === next.inventory.inventoryRevision
  ) {
    return canonicalize(currentPayload) === canonicalize(nextPayload)
      ? { ok: true, status: "replayed", snapshot: next }
      : mismatch("revision-conflict", "Executor snapshot revision was rewritten");
  }
  if (
    next.descriptor.revision < current.descriptor.revision ||
    next.inventory.inventoryRevision <= current.inventory.inventoryRevision
  ) {
    return mismatch("revision-conflict", "Executor snapshot revision moved backwards");
  }
  for (const field of DEVICE_VERSION_FIELDS) {
    if (inventoryVersion(next.inventory, field) < inventoryVersion(current.inventory, field)) {
      return mismatch(
        "revision-conflict",
        `Execution snapshot version moved backwards: ${field}`,
      );
    }
  }
  if (
    next.inventory.permissionSnapshotHighWater <
    current.inventory.permissionSnapshotHighWater
  ) {
    return mismatch(
      "revision-conflict",
      "Permission snapshot high water moved backwards",
    );
  }
  const currentBindings = new Map(
    current.inventory.credentialBindingRevisions.map((binding) => [
      binding.bindingId,
      binding.revision,
    ]),
  );
  for (const binding of next.inventory.credentialBindingRevisions) {
    const oldRevision = currentBindings.get(binding.bindingId);
    if (oldRevision !== undefined && binding.revision < oldRevision) {
      return mismatch("revision-conflict", "Credential binding revision moved backwards");
    }
  }
  return { ok: true, status: "accepted", snapshot: next };
}

export function validateExecutorCapabilitySnapshot(
  input: ExecutorCapabilitySnapshot,
  verifier: ProtocolSignatureVerifier,
): ExecutorCapabilitySnapshot {
  assertPlainRecord(input, "Executor capability snapshot");
  assertExactKeys(input, ["descriptor", "inventory"], "Executor capability snapshot");
  const descriptor = validateCapabilityDescriptor(input.descriptor, verifier);
  const inventory = validateExecutorVersionInventory(input.inventory, verifier);
  const snapshotConsistencyError = executorSnapshotConsistencyError(
    descriptor,
    inventory,
  );
  if (snapshotConsistencyError !== undefined) {
    throw new TypeError(snapshotConsistencyError.message);
  }
  return { descriptor, inventory };
}

function executorSnapshotConsistencyError(
  descriptor: CapabilityDescriptor,
  inventory: ExecutorVersionInventory,
): AuthorityError | undefined {
  if (
    descriptor.executorId !== inventory.executorId ||
    descriptor.revision !== inventory.capabilityRevision ||
    descriptor.signature.keyId !== inventory.signature.keyId
  ) {
    return mismatch(
      "revision-conflict",
      "Executor capability snapshot identity or revision is inconsistent",
    ).error;
  }
  const inventoryBindings = new Map(
    inventory.credentialBindingRevisions.map((binding) => [binding.bindingId, binding.revision]),
  );
  if (inventoryBindings.size !== descriptor.credentialBindings.length) {
    return mismatch(
      "revision-conflict",
      "Credential descriptor and inventory binding sets are inconsistent",
    ).error;
  }
  for (const binding of descriptor.credentialBindings) {
    if (inventoryBindings.get(binding.bindingId) !== binding.revision) {
      return mismatch(
        "revision-conflict",
        "Credential descriptor and inventory revisions are inconsistent",
      ).error;
    }
  }
  return undefined;
}

function validateRequirements(input: unknown): asserts input is ManifestRequirements {
  assertPlainRecord(input, "Execution snapshot requirements");
  assertExactKeys(input, MANIFEST_VERSION_FIELDS, "Execution snapshot requirements");
  for (const field of MANIFEST_VERSION_FIELDS) {
    assertPositiveInteger(input[field], `Execution snapshot ${field}`);
  }
}

function validateDeviceVersions(
  input: unknown,
): asserts input is ExecutorVersionInventory["configVersions"] &
  ExecutorVersionInventory["assetVersions"] {
  assertPlainRecord(input, "Executor device versions");
  assertExactKeys(input, DEVICE_VERSION_FIELDS, "Executor device versions");
  for (const field of DEVICE_VERSION_FIELDS) {
    assertPositiveInteger(input[field], `Executor device version ${field}`);
  }
}

function assertEnvironmentCredentialClosure(manifest: ExecutionManifest): void {
  const frozen = new Set(
    manifest.credentialBindings.map((binding) =>
      bindingKey(binding.service, binding.bindingId),
    ),
  );
  const environment = manifest.environment.credentialBindings ?? [];
  for (const binding of environment) {
    if (!frozen.has(bindingKey(binding.service, binding.bindingId))) {
      throw new TypeError(
        "Environment credential requirement lacks a frozen manifest revision",
      );
    }
  }
}

function snapshotPayload(snapshotValue: ExecutorCapabilitySnapshot): object {
  return {
    descriptor: withoutSignatureAndTime(snapshotValue.descriptor),
    inventory: withoutSignatureAndTime(snapshotValue.inventory),
  };
}

function withoutSignatureAndTime<
  T extends { readonly signature: Signature; readonly at: string },
>(input: T): Omit<T, "signature" | "at"> {
  const { signature: _, at: __, ...payload } = input;
  return payload;
}

function inventoryVersion(
  inventory: ExecutorVersionInventory,
  field: (typeof DEVICE_VERSION_FIELDS)[number],
): number {
  return field in inventory.configVersions
    ? inventory.configVersions[field as keyof typeof inventory.configVersions]
    : inventory.assetVersions[field as keyof typeof inventory.assetVersions];
}

function mismatch(
  code: "revision-conflict" | "capability-gap",
  message: string,
): { readonly ok: false; readonly error: AuthorityError } {
  return { ok: false, error: { code, message, retryable: true } };
}

function bindingKey(service: string, bindingId: string): string {
  return `${service}\u0000${bindingId}`;
}

function snapshot<T>(input: T, label: string): T {
  try {
    return JSON.parse(canonicalize(input)) as T;
  } catch (error) {
    throw new TypeError(`${label} must be canonical JSON`, { cause: error });
  }
}

function withoutField<T extends object, K extends keyof T>(
  input: T,
  key: K,
): Omit<T, K> {
  const clone = { ...input };
  delete clone[key];
  return clone;
}

function assertVersion(value: unknown, label: string): asserts value is 1 {
  if (value !== 1) throw new TypeError(`${label} version must be 1`);
}

function assertDigest(value: unknown, label: string): asserts value is Digest {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
}

function assertSignature(value: unknown, label: string): asserts value is Signature {
  assertPlainRecord(value, label);
  assertExactKeys(value, ["alg", "keyId", "sig"], label);
  assertBoundedString(value.alg, `${label} algorithm`);
  assertBoundedString(value.keyId, `${label} key id`);
  assertBoundedString(value.sig, `${label} value`);
}

function assertCanonicalTime(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") throw new TypeError(`${label} is invalid`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
}

function assertIdentifierArray(value: unknown, label: string): asserts value is string[] {
  assertDenseArray(value, label);
  for (const item of value) assertIdentifier(item, label);
  const identifiers = value as string[];
  assertSorted(identifiers, (item) => item, label);
  assertUnique(identifiers, label);
}

function assertBoundedString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 480) {
    throw new TypeError(`${label} must be a non-empty bounded string`);
  }
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

function assertPlainRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function assertDenseArray(value: unknown, label: string): asserts value is unknown[] {
  if (!Array.isArray(value) || Object.keys(value).length !== value.length) {
    throw new TypeError(`${label} must be a dense array`);
  }
}

function assertExactKeys(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} fields are incomplete or unknown`);
  }
}

function assertAllowedKeys(value: object, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new TypeError(`${label} contains an unknown field`);
  }
}

function assertSorted<T>(
  values: readonly T[],
  key: (value: T) => string,
  label: string,
): void {
  for (let index = 1; index < values.length; index += 1) {
    if (compareCanonicalStrings(key(values[index - 1]!), key(values[index]!)) > 0) {
      throw new TypeError(`${label} must be sorted`);
    }
  }
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new TypeError(`${label} must be unique`);
  }
}
