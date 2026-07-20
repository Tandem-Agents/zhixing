import { describe, expect, it } from "vitest";
import type {
  CapabilityDescriptor,
  ExecutionManifest,
  ExecutorVersionInventory,
  Signature,
  TrustRuleSnapshot,
} from "../contracts/index.js";
import { canonicalize, protocolDigest } from "./canonical.js";
import type { ProtocolSignatureVerifier, ProtocolSigner } from "./assignment.js";
import {
  acceptExecutorCapabilitySnapshot,
  createExecutionManifest,
  createSignedCapabilityDescriptor,
  createSignedExecutorVersionInventory,
  ExecutorCapabilityDirectory,
  type ExecutorCapabilityDirectoryState,
  matchManifest,
  validateCapabilityDescriptor,
  validateExecutionManifest,
  validateExecutorCapabilitySnapshot,
  validateExecutorVersionInventory,
} from "./manifest.js";
import {
  createSignedTrustRuleSnapshot,
  validateTrustRuleSnapshot,
} from "./permission-snapshot.js";

const signer: ProtocolSigner = {
  sign(schemaId, version, payload) {
    return {
      alg: "test-digest",
      keyId: "device-a",
      sig: protocolDigest(schemaId, version, payload),
    };
  },
};

const verifier: ProtocolSignatureVerifier = {
  verify(schemaId, version, payload, signature) {
    expect(signature).toEqual(signer.sign(schemaId, version, payload));
  },
};

function signerFor(keyId: string): ProtocolSigner {
  return {
    sign(schemaId, version, payload) {
      return {
        alg: "test-digest",
        keyId,
        sig: protocolDigest(schemaId, version, payload),
      };
    },
  };
}

const multiDeviceVerifier: ProtocolSignatureVerifier = {
  verify(schemaId, version, payload, signature) {
    expect(signature.alg).toBe("test-digest");
    expect(signature.sig).toBe(protocolDigest(schemaId, version, payload));
  },
};

function memoryDirectoryStore(initial?: ExecutorCapabilityDirectoryState) {
  let state = initial === undefined ? undefined : structuredClone(initial);
  return {
    async load() {
      return state === undefined ? undefined : structuredClone(state);
    },
    async save(next: ExecutorCapabilityDirectoryState, expectedGeneration: number) {
      expect(state?.generation ?? 0).toBe(expectedGeneration);
      state = structuredClone(next);
    },
  };
}

const DEVICE_REQUIREMENT_FIELDS = [
  "runtimeConfigRev",
  "modelProfileRev",
  "policyRev",
  "skillsRev",
  "rubricsRev",
  "promptAssetsRev",
] as const;

function requirements(revision = 3) {
  return {
    runtimeConfigRev: revision,
    modelProfileRev: revision,
    policyRev: revision,
    skillsRev: revision,
    rubricsRev: revision,
    promptAssetsRev: revision,
    permissionSnapshotVersion: revision,
  };
}

function manifest(): ExecutionManifest<"conversation"> {
  return createExecutionManifest({
    baseRef: {
      execution: "conversation",
      conversationId: "conversation-a",
      baseRevision: 7,
    },
    protocolVersion: "1",
    requires: requirements(),
    tools: ["Read"],
    mcpServers: ["local-mcp"],
    environment: {
      deviceId: "device-a",
      workspace: {
        deviceId: "device-a",
        bindingRef: "workspace-a",
        workspaceBindingRevision: 5,
      },
      credentialBindings: [{ service: "provider", bindingId: "binding-a" }],
      evidenceKinds: ["artifact", "test-result"],
    },
    credentialBindings: [
      { service: "provider", bindingId: "binding-a", revision: 4 },
    ],
  });
}

function descriptor(revision = 2): CapabilityDescriptor {
  return createSignedCapabilityDescriptor(
    {
      executorId: "device-a",
      revision,
      protocolVersion: "1",
      workspaces: [
        {
          bindingRef: "workspace-a",
          workspaceBindingRevision: 5,
          displayName: "Workspace A",
        },
      ],
      tools: ["Read", "Write"],
      mcpServers: ["local-mcp"],
      credentialBindings: [
        {
          bindingId: "binding-a",
          service: "provider",
          principalFingerprint: protocolDigest("CredentialPrincipal", 1, {
            service: "provider",
            canonicalProviderPrincipal: "principal-a",
          }),
          scopes: ["chat", "models"],
          verification: "service-verified",
          revision: 4,
        },
      ],
      evidenceCapabilities: ["artifact", "test-result"],
      at: "2026-07-19T00:00:00.000Z",
    },
    signer,
  );
}

function inventory(
  inventoryRevision = 8,
  capabilityRevision = 2,
): ExecutorVersionInventory {
  const versions = requirements();
  return createSignedExecutorVersionInventory(
    {
      executorId: "device-a",
      inventoryRevision,
      capabilityRevision,
      configVersions: {
        runtimeConfigRev: versions.runtimeConfigRev,
        modelProfileRev: versions.modelProfileRev,
        policyRev: versions.policyRev,
      },
      assetVersions: {
        skillsRev: versions.skillsRev,
        rubricsRev: versions.rubricsRev,
        promptAssetsRev: versions.promptAssetsRev,
      },
      permissionSnapshotHighWater: versions.permissionSnapshotVersion,
      credentialBindingRevisions: [{ bindingId: "binding-a", revision: 4 }],
      at: "2026-07-19T00:00:00.000Z",
    },
    signer,
  );
}

function resign<T extends { signature: Signature }>(value: T): T {
  const payload = { ...value };
  delete (payload as Partial<T>).signature;
  return {
    ...value,
    signature: signer.sign(
      "executorId" in value && "inventoryRevision" in value
        ? "ExecutorVersionInventory"
        : "CapabilityDescriptor",
      1,
      payload,
    ),
  };
}

describe("execution manifest contracts", () => {
  it("constructs and validates one canonical manifest", () => {
    const value = manifest();
    expect(validateExecutionManifest(value)).toEqual(value);
    expect(value.digest).toBe(
      protocolDigest("ExecutionManifest", 1, {
        v: value.v,
        baseRef: value.baseRef,
        protocolVersion: value.protocolVersion,
        requires: value.requires,
        tools: value.tools,
        mcpServers: value.mcpServers,
        environment: value.environment,
        credentialBindings: value.credentialBindings,
      }),
    );
  });

  it("rejects non-canonical execution protocol versions", () => {
    expect(() => createExecutionManifest({
      ...withoutManifestIdentity(manifest()),
      protocolVersion: "01",
    })).toThrow("canonical positive decimal");
    expect(() => createSignedCapabilityDescriptor({
      ...withoutSignedIdentity(descriptor()),
      protocolVersion: "not-a-version",
    }, signer)).toThrow("canonical positive decimal");
  });

  it("rejects digest changes, unknown secret fields and inconsistent devices", () => {
    expect(() =>
      validateExecutionManifest({ ...manifest(), digest: protocolDigest("Wrong", 1, {}) }),
    ).toThrow("digest");
    expect(() =>
      validateExecutionManifest({ ...manifest(), secret: "must-not-cross-wire" }),
    ).toThrow("unknown");
    expect(() =>
      createExecutionManifest({
        ...withoutManifestIdentity(manifest()),
        environment: {
          deviceId: "device-b",
          workspace: {
            deviceId: "device-a",
            bindingRef: "workspace-a",
            workspaceBindingRevision: 5,
          },
        },
      }),
    ).toThrow("workspace target device");
  });

  it("requires every environment credential to carry a frozen revision", () => {
    expect(() =>
      createExecutionManifest({
        ...withoutManifestIdentity(manifest()),
        credentialBindings: [],
      }),
    ).toThrow("frozen manifest revision");
  });

  it("rejects one credential binding id assigned to multiple services", () => {
    expect(() => createExecutionManifest({
      ...withoutManifestIdentity(manifest()),
      credentialBindings: [
        { service: "provider-a", bindingId: "binding-a", revision: 1 },
        { service: "provider-b", bindingId: "binding-a", revision: 1 },
      ],
    })).toThrow("binding ids must be unique");
    expect(() => createExecutionManifest({
      ...withoutManifestIdentity(manifest()),
      environment: {
        credentialBindings: [
          { service: "provider-a", bindingId: "binding-a" },
          { service: "provider-b", bindingId: "binding-a" },
        ],
      },
    })).toThrow("binding ids must be unique");
  });

  it("rejects non-canonical environment collections and zero workspace revisions", () => {
    const payload = withoutManifestIdentity(manifest());
    expect(() => createExecutionManifest({
      ...payload,
      environment: {
        ...payload.environment,
        credentialBindings: [
          { service: "provider", bindingId: "binding-z" },
          { service: "provider", bindingId: "binding-a" },
        ],
      },
    })).toThrow("Environment credential bindings must be sorted");
    expect(() => createExecutionManifest({
      ...payload,
      environment: {
        ...payload.environment,
        evidenceKinds: ["test-result", "artifact"],
      },
    })).toThrow("Environment evidence kinds must be sorted");
    expect(() => createExecutionManifest({
      ...payload,
      environment: {
        ...payload.environment,
        workspace: {
          ...payload.environment.workspace!,
          workspaceBindingRevision: 0,
        },
      },
    })).toThrow("Workspace binding revision must be a positive safe integer");
  });
});

describe("capability and inventory contracts", () => {
  it("verifies signed descriptor and inventory shapes", () => {
    expect(validateCapabilityDescriptor(descriptor(), verifier)).toEqual(descriptor());
    expect(validateExecutorVersionInventory(inventory(), verifier)).toEqual(inventory());
  });

  it("rejects secret-bearing and ambiguous credential descriptors", () => {
    const value = descriptor();
    expect(() =>
      validateCapabilityDescriptor({ ...value, credentialSecret: "secret" }),
    ).toThrow("unknown");
    expect(() =>
      validateCapabilityDescriptor({
        ...value,
        credentialBindings: [
          {
            bindingId: "binding-a",
            service: "provider",
            verification: "user-alias",
            revision: 4,
            principalFingerprint: protocolDigest("CredentialPrincipal", 1, {}),
          },
        ],
      }),
    ).toThrow("verified principal");
  });

  it("rejects duplicate and non-canonical capability collections", () => {
    const value = descriptor();
    expect(() => validateCapabilityDescriptor({ ...value, tools: ["Read", "Read"] }))
      .toThrow("unique");
    expect(() => validateCapabilityDescriptor({ ...value, tools: ["Write", "Read"] }))
      .toThrow("sorted");
  });

  it("keeps secret-bearing fields out of every advertised wire snapshot", () => {
    const keys = collectKeys({
      manifest: manifest(),
      descriptor: descriptor(),
      inventory: inventory(),
    });
    expect(keys.filter((key) => /secret|password|token|authorization|headers?/iu.test(key)))
      .toEqual([]);
  });
});

describe("matchManifest", () => {
  it("accepts the same snapshot through in-process and serialized adapters", () => {
    const direct = matchManifest(manifest(), descriptor(), inventory());
    const serialized = matchManifest(
      JSON.parse(canonicalize(manifest())),
      JSON.parse(canonicalize(descriptor())),
      JSON.parse(canonicalize(inventory())),
    );
    expect(direct).toEqual({ ok: true });
    expect(serialized).toEqual(direct);
  });

  it("binds device requirements to the snapshot signer instead of the executor label", () => {
    const executorDescriptor = resign({
      ...descriptor(),
      executorId: "executor-a",
    });
    const executorInventory = resign({
      ...inventory(),
      executorId: "executor-a",
    });

    expect(matchManifest(manifest(), executorDescriptor, executorInventory)).toEqual({
      ok: true,
    });
    const crossSignedInventory = createSignedExecutorVersionInventory(
      withoutSignedIdentity(executorInventory),
      signerFor("device-b"),
    );
    const direct = matchManifest(manifest(), executorDescriptor, crossSignedInventory);
    expect(direct).toMatchObject({
        ok: false,
        error: { code: "revision-conflict" },
      });
    expect(matchManifest(
      JSON.parse(canonicalize(manifest())),
      JSON.parse(canonicalize(executorDescriptor)),
      JSON.parse(canonicalize(crossSignedInventory)),
    )).toEqual(direct);
    expect(() =>
      validateExecutorCapabilitySnapshot(
        {
          descriptor: executorDescriptor,
          inventory: {
            ...executorInventory,
            signature: {
              ...executorInventory.signature,
              keyId: "device-b",
            },
          },
        },
        { verify() {} },
      ),
    ).toThrow("identity or revision");
  });

  it("rejects inventory credential revisions that lack a descriptor", () => {
    const current = inventory();
    const inconsistent = createSignedExecutorVersionInventory(
      {
        ...withoutSignedIdentity(current),
        credentialBindingRevisions: [
          ...current.credentialBindingRevisions,
          { bindingId: "binding-extra", revision: 1 },
        ],
      },
      signer,
    );
    expect(() => validateExecutorCapabilitySnapshot(
      { descriptor: descriptor(), inventory: inconsistent },
      verifier,
    )).toThrow("binding sets");
    const direct = matchManifest(manifest(), descriptor(), inconsistent);
    expect(direct).toMatchObject({
      ok: false,
      error: { code: "revision-conflict" },
    });
    expect(matchManifest(
      JSON.parse(canonicalize(manifest())),
      JSON.parse(canonicalize(descriptor())),
      JSON.parse(canonicalize(inconsistent)),
    )).toEqual(direct);
  });

  for (const field of DEVICE_REQUIREMENT_FIELDS) {
    it(`rejects a ${field} mismatch as revision-conflict`, () => {
      const value = inventory();
      const changed = clone(value);
      if (field in changed.configVersions) {
        changed.configVersions[field as keyof typeof changed.configVersions] += 1;
      } else {
        changed.assetVersions[field as keyof typeof changed.assetVersions] += 1;
      }
      changed.signature = resign(changed).signature;
      expect(matchManifest(manifest(), descriptor(), changed)).toEqual({
        ok: false,
        error: {
          code: "revision-conflict",
          message: `Execution snapshot revision mismatch: ${field}`,
          retryable: true,
        },
      });
    });
  }

  it("accepts a historical permission snapshot at or below the ready high water", () => {
    const historical = createExecutionManifest({
      ...withoutManifestIdentity(manifest()),
      requires: { ...requirements(), permissionSnapshotVersion: 2 },
    });
    expect(matchManifest(historical, descriptor(), inventory())).toEqual({ ok: true });
  });

  it("rejects a permission snapshot above the ready high water as a capability gap", () => {
    const future = createExecutionManifest({
      ...withoutManifestIdentity(manifest()),
      requires: { ...requirements(), permissionSnapshotVersion: 4 },
    });
    expect(matchManifest(future, descriptor(), inventory())).toEqual({
      ok: false,
      error: {
        code: "capability-gap",
        message: "Required permission snapshot is not locally ready",
        retryable: true,
      },
    });
  });

  it.each([
    ["target device", () => createExecutionManifest({
      ...withoutManifestIdentity(manifest()),
      environment: { deviceId: "device-b" },
    })],
    ["workspace", () => ({
      ...descriptor(),
      workspaces: [{ ...descriptor().workspaces[0]!, bindingRef: "workspace-b" }],
    })],
    ["credential", () => ({ ...descriptor(), credentialBindings: [] })],
    ["evidence", () => ({ ...descriptor(), evidenceCapabilities: ["artifact"] })],
    ["tool", () => ({ ...descriptor(), tools: ["Write"] })],
    ["MCP server", () => ({ ...descriptor(), mcpServers: [] })],
  ])("rejects a missing %s capability", (_label, mutate) => {
    const changed = mutate();
    const result = "baseRef" in changed
      ? matchManifest(changed as ExecutionManifest, descriptor(), inventory())
      : matchManifest(manifest(), changed as CapabilityDescriptor, inventory());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(["capability-gap", "revision-conflict"]).toContain(result.error.code);
  });

  it("rejects descriptor/inventory skew before checking capabilities", () => {
    expect(matchManifest(manifest(), descriptor(), inventory(8, 3))).toMatchObject({
      ok: false,
      error: { code: "revision-conflict" },
    });
  });

  it("rejects an incompatible executor protocol version", () => {
    const incompatible = { ...descriptor(), protocolVersion: "2" };
    expect(matchManifest(manifest(), incompatible, inventory())).toEqual({
      ok: false,
      error: {
        code: "capability-gap",
        message: "Executor protocol version is incompatible with the manifest",
        retryable: true,
      },
    });
  });

  it("classifies stale workspace and credential revisions as revision conflicts", () => {
    const staleWorkspace = clone(descriptor());
    staleWorkspace.workspaces[0]!.workspaceBindingRevision += 1;
    const staleCredential = clone(inventory());
    staleCredential.credentialBindingRevisions[0]!.revision += 1;

    expect(matchManifest(manifest(), staleWorkspace, inventory())).toMatchObject({
      ok: false,
      error: { code: "revision-conflict" },
    });
    expect(matchManifest(manifest(), descriptor(), staleCredential)).toMatchObject({
      ok: false,
      error: { code: "revision-conflict" },
    });
  });
});

describe("executor capability snapshot updates", () => {
  it("accepts an initial snapshot and exact signed replay", () => {
    const first = { descriptor: descriptor(), inventory: inventory() };
    expect(acceptExecutorCapabilitySnapshot(undefined, first, verifier)).toMatchObject({
      ok: true,
      status: "accepted",
    });
    expect(
      acceptExecutorCapabilitySnapshot(first, {
        descriptor: resign(first.descriptor),
        inventory: resign(first.inventory),
      }, verifier),
    ).toMatchObject({ ok: true, status: "replayed" });
  });

  it("treats a re-signed observation time as the same versioned snapshot", () => {
    const first = { descriptor: descriptor(), inventory: inventory() };
    const refreshed = {
      descriptor: createSignedCapabilityDescriptor({
        ...withoutSignedIdentity(first.descriptor),
        at: "2026-07-19T00:01:00.000Z",
      }, signer),
      inventory: createSignedExecutorVersionInventory({
        ...withoutSignedIdentity(first.inventory),
        at: "2026-07-19T00:01:00.000Z",
      }, signer),
    };
    expect(
      acceptExecutorCapabilitySnapshot(first, refreshed, verifier),
    ).toMatchObject({ ok: true, status: "replayed" });
  });

  it("publishes only snapshots accepted by the version directory", async () => {
    const directory = await ExecutorCapabilityDirectory.open({
      verifier,
      store: memoryDirectoryStore(),
      isDeviceAuthorized: (keyId) => keyId === "device-a",
      allowInitialize: true,
    });
    const first = { descriptor: descriptor(), inventory: inventory() };
    expect(await directory.accept(first)).toMatchObject({ ok: true, status: "accepted" });
    expect(directory.snapshotFor("device-a")).toEqual(first);

    const rewritten = createSignedCapabilityDescriptor({
      ...withoutSignedIdentity(first.descriptor),
      tools: ["Read"],
    }, signer);
    expect(await directory.accept({ descriptor: rewritten, inventory: first.inventory }))
      .toMatchObject({ ok: false });
    expect(directory.snapshotFor("device-a")).toEqual(first);
  });

  it("requires explicit first-bootstrap authority for an empty durable directory", async () => {
    await expect(
      ExecutorCapabilityDirectory.open({
        verifier,
        store: memoryDirectoryStore(),
        isDeviceAuthorized: () => true,
      }),
    ).rejects.toThrow("state is missing");
  });

  it("uses canonical JSON ordering for durable executor and binding collections", async () => {
    const store = memoryDirectoryStore();
    const directory = await ExecutorCapabilityDirectory.open({
      store,
      verifier: multiDeviceVerifier,
      isDeviceAuthorized: () => true,
      allowInitialize: true,
    });
    const mixedBindings = [
      {
        bindingId: "binding-Z",
        service: "provider",
        verification: "user-alias" as const,
        revision: 1,
      },
      {
        bindingId: "binding-a",
        service: "provider",
        verification: "user-alias" as const,
        revision: 1,
      },
    ];

    await expect(directory.accept(capabilitySnapshot({
      executorId: "executor:a",
      credentialBindings: mixedBindings,
    }))).resolves.toMatchObject({ ok: true });
    await expect(directory.accept(capabilitySnapshot({
      executorId: "executor:Z",
      deviceKeyId: "device-z",
      credentialBindings: mixedBindings,
    }))).resolves.toMatchObject({ ok: true });
    expect(directory.snapshotFor("executor:Z")).toBeDefined();
    expect(directory.snapshotFor("executor:a")).toBeDefined();
  });

  it("preserves identity and revision high-water marks across restart", async () => {
    const store = memoryDirectoryStore();
    const authorized = new Set(["device-a", "device-b"]);
    const first = capabilitySnapshot();
    const directory = await ExecutorCapabilityDirectory.open({
      verifier: multiDeviceVerifier,
      store,
      isDeviceAuthorized: (keyId) => authorized.has(keyId),
      allowInitialize: true,
    });
    await expect(directory.accept(first)).resolves.toMatchObject({ ok: true });
    await expect(
      directory.accept(capabilitySnapshot({ descriptorRevision: 3, inventoryRevision: 9 })),
    ).resolves.toMatchObject({ ok: true });

    const restarted = await ExecutorCapabilityDirectory.open({
      verifier: multiDeviceVerifier,
      store,
      isDeviceAuthorized: (keyId) => authorized.has(keyId),
    });
    await expect(restarted.accept(first)).resolves.toMatchObject({
      ok: false,
      error: { code: "revision-conflict" },
    });
    await expect(
      restarted.accept(capabilitySnapshot({
        deviceKeyId: "device-b",
        descriptorRevision: 4,
        inventoryRevision: 10,
      })),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "revision-conflict" },
    });

    authorized.delete("device-a");
    expect(restarted.snapshotFor("device-a")).toBeUndefined();
    await restarted.revokeDevice("device-a");
    authorized.add("device-a");
    const afterRevocation = await ExecutorCapabilityDirectory.open({
      verifier: multiDeviceVerifier,
      store,
      isDeviceAuthorized: (keyId) => authorized.has(keyId),
    });
    expect(afterRevocation.snapshotFor("device-a")).toBeUndefined();
    await expect(
      afterRevocation.accept(capabilitySnapshot({
        descriptorRevision: 4,
        inventoryRevision: 10,
      })),
    ).resolves.toMatchObject({ ok: false, error: { code: "capability-gap" } });
  });

  it("keeps credential semantic identity and deletion tombstones durable", async () => {
    const store = memoryDirectoryStore();
    const directory = await ExecutorCapabilityDirectory.open({
      verifier: multiDeviceVerifier,
      store,
      isDeviceAuthorized: (keyId) => keyId === "device-a",
      allowInitialize: true,
    });
    await directory.accept(capabilitySnapshot());
    const original = descriptor().credentialBindings[0]!;
    await expect(
      directory.accept(capabilitySnapshot({
        descriptorRevision: 3,
        inventoryRevision: 9,
        credentialBindings: [{ ...original, tenant: "tenant-b" }],
      })),
    ).resolves.toMatchObject({ ok: false, error: { code: "revision-conflict" } });

    await expect(
      directory.accept(capabilitySnapshot({
        descriptorRevision: 3,
        inventoryRevision: 9,
        credentialBindings: [],
      })),
    ).resolves.toMatchObject({ ok: true });
    const restarted = await ExecutorCapabilityDirectory.open({
      verifier: multiDeviceVerifier,
      store,
      isDeviceAuthorized: (keyId) => keyId === "device-a",
    });
    await expect(
      restarted.accept(capabilitySnapshot({
        descriptorRevision: 4,
        inventoryRevision: 10,
        credentialBindings: [original],
      })),
    ).resolves.toMatchObject({ ok: false, error: { code: "revision-conflict" } });
    await expect(
      restarted.accept(capabilitySnapshot({
        descriptorRevision: 4,
        inventoryRevision: 10,
        credentialBindings: [{ ...original, revision: 5 }],
      })),
    ).resolves.toMatchObject({ ok: true });
  });

  it("fails closed when a restored current snapshot is behind its claimed high water", async () => {
    const current = capabilitySnapshot();
    const versions = requirements();
    const {
      permissionSnapshotVersion,
      ...deviceVersionHighWater
    } = versions;
    const store = memoryDirectoryStore({
      v: 1,
      generation: 1,
      executors: [{
        executorId: current.descriptor.executorId,
        deviceKeyId: current.descriptor.signature.keyId,
        active: true,
        snapshot: current,
        descriptorRevisionHighWater: current.descriptor.revision + 1,
        inventoryRevisionHighWater: current.inventory.inventoryRevision,
        versionHighWater: deviceVersionHighWater,
        permissionSnapshotHighWater: permissionSnapshotVersion,
        credentialBindingHighWater: current.descriptor.credentialBindings.map((binding) => ({
          active: true,
          binding,
        })),
      }],
    });
    await expect(ExecutorCapabilityDirectory.open({
      verifier: multiDeviceVerifier,
      store,
      isDeviceAuthorized: () => true,
    })).rejects.toThrow("identity or high water");
  });

  it("accepts a forward version update", () => {
    const current = { descriptor: descriptor(), inventory: inventory() };
    const nextDescriptor = createSignedCapabilityDescriptor(
      {
        ...withoutSignedIdentity(descriptor()),
        revision: 3,
        at: "2026-07-19T00:01:00.000Z",
      },
      signer,
    );
    const nextInventory = createSignedExecutorVersionInventory(
      {
        ...withoutSignedIdentity(inventory()),
        inventoryRevision: 9,
        capabilityRevision: 3,
        configVersions: { ...inventory().configVersions, policyRev: 4 },
        at: "2026-07-19T00:01:00.000Z",
      },
      signer,
    );
    expect(
      acceptExecutorCapabilitySnapshot(
        current,
        { descriptor: nextDescriptor, inventory: nextInventory },
        verifier,
      ),
    ).toMatchObject({ ok: true, status: "accepted" });
  });

  for (const field of DEVICE_REQUIREMENT_FIELDS) {
    it(`rejects rollback of ${field}`, () => {
      const currentDescriptor = descriptor(3);
      const currentInventory = createInventoryWithVersions(9, 3, requirements(4));
      const nextInventory = createInventoryWithVersions(10, 4, {
        ...requirements(4),
        [field]: 3,
      });
      const nextDescriptor = createSignedCapabilityDescriptor(
        {
          ...withoutSignedIdentity(currentDescriptor),
          revision: 4,
          at: "2026-07-19T00:01:00.000Z",
        },
        signer,
      );
      expect(
        acceptExecutorCapabilitySnapshot(
          { descriptor: currentDescriptor, inventory: currentInventory },
          { descriptor: nextDescriptor, inventory: nextInventory },
          verifier,
        ),
      ).toMatchObject({ ok: false, error: { code: "revision-conflict" } });
    });
  }


  it("rejects rollback of the permission snapshot high water", () => {
    const currentDescriptor = descriptor(3);
    const currentInventory = createInventoryWithVersions(9, 3, requirements(4));
    const nextInventory = createInventoryWithVersions(10, 4, {
      ...requirements(4),
      permissionSnapshotVersion: 3,
    });
    const nextDescriptor = createSignedCapabilityDescriptor(
      {
        ...withoutSignedIdentity(currentDescriptor),
        revision: 4,
        at: "2026-07-19T00:01:00.000Z",
      },
      signer,
    );
    expect(
      acceptExecutorCapabilitySnapshot(
        { descriptor: currentDescriptor, inventory: currentInventory },
        { descriptor: nextDescriptor, inventory: nextInventory },
        verifier,
      ),
    ).toMatchObject({ ok: false, error: { code: "revision-conflict" } });
  });

  it("rejects rewriting an existing revision", () => {
    const current = { descriptor: descriptor(), inventory: inventory() };
    const rewritten = createSignedCapabilityDescriptor(
      {
        ...withoutSignedIdentity(descriptor()),
        tools: ["Read"],
      },
      signer,
    );
    expect(
      acceptExecutorCapabilitySnapshot(
        current,
        { descriptor: rewritten, inventory: inventory() },
        verifier,
      ),
    ).toMatchObject({ ok: false, error: { code: "revision-conflict" } });
  });
});

describe("trust rule snapshot contracts", () => {
  it("binds versioned rule content to one digest and signature", () => {
    const value: TrustRuleSnapshot = createSignedTrustRuleSnapshot(
      { snapshotVersion: 3, rules: [], generatedAt: "2026-07-19T00:00:00.000Z" },
      signer,
    );
    expect(validateTrustRuleSnapshot(value, verifier)).toEqual(value);
    expect(() => validateTrustRuleSnapshot({ ...value, snapshotVersion: 4 }, verifier))
      .toThrow("digest");
  });

  it("canonicalizes rule order and excludes local display paths from wire", () => {
    const rule = (id: string, contextPath?: string) => ({
      id,
      pattern: { tool: "bash", argument: "*" },
      decision: "allow" as const,
      scope: "context" as const,
      createdAt: 1,
      lastMatchedAt: 1,
      matchCount: 0,
      contextId: { kind: "main" as const },
      ...(contextPath === undefined ? {} : { contextPath }),
    });
    const value = createSignedTrustRuleSnapshot(
      {
        snapshotVersion: 3,
        rules: [
          rule("rule-a"),
          rule("rule-Z", "C:\\private\\workspace"),
        ],
        generatedAt: "2026-07-19T00:00:00.000Z",
      },
      signer,
    );
    expect(value.rules.map(({ id }) => id)).toEqual(["rule-Z", "rule-a"]);
    expect(value.rules.some((entry) => "contextPath" in entry)).toBe(false);
    expect(() => validateTrustRuleSnapshot({
      ...value,
      rules: [{ ...value.rules[0]!, contextPath: "C:\\private\\workspace" }, value.rules[1]!],
    }, verifier)).toThrow("unknown field");
  });

  it("omits undefined storage fields and keeps policy identity stable across telemetry updates", () => {
    const rule = {
      id: "rule-global",
      pattern: { tool: "bash", argument: "pnpm test" },
      decision: "allow" as const,
      scope: "global" as const,
      createdAt: 1,
      lastMatchedAt: 2,
      matchCount: 3,
      contextId: undefined,
      contextPath: undefined,
      contributors: undefined,
    };
    const first = createSignedTrustRuleSnapshot(
      {
        snapshotVersion: 1,
        rules: [rule],
        generatedAt: "2026-07-19T00:00:00.000Z",
      },
      signer,
    );
    const replay = createSignedTrustRuleSnapshot(
      {
        snapshotVersion: 1,
        rules: [{ ...rule, lastMatchedAt: 99, matchCount: 50 }],
        generatedAt: "2026-07-19T00:00:00.000Z",
      },
      signer,
    );

    expect(first.digest).toBe(replay.digest);
    expect(first.rules).toEqual([{
      id: rule.id,
      pattern: rule.pattern,
      decision: rule.decision,
      scope: rule.scope,
      createdAt: rule.createdAt,
    }]);
  });
});

function createInventoryWithVersions(
  inventoryRevision: number,
  capabilityRevision: number,
  versions: ReturnType<typeof requirements>,
): ExecutorVersionInventory {
  return createSignedExecutorVersionInventory(
    {
      ...withoutSignedIdentity(inventory()),
      inventoryRevision,
      capabilityRevision,
      configVersions: {
        runtimeConfigRev: versions.runtimeConfigRev,
        modelProfileRev: versions.modelProfileRev,
        policyRev: versions.policyRev,
      },
      assetVersions: {
        skillsRev: versions.skillsRev,
        rubricsRev: versions.rubricsRev,
        promptAssetsRev: versions.promptAssetsRev,
      },
      permissionSnapshotHighWater: versions.permissionSnapshotVersion,
      at: "2026-07-19T00:01:00.000Z",
    },
    signer,
  );
}

function capabilitySnapshot(input: {
  readonly deviceKeyId?: string;
  readonly executorId?: string;
  readonly descriptorRevision?: number;
  readonly inventoryRevision?: number;
  readonly credentialBindings?: CapabilityDescriptor["credentialBindings"];
} = {}) {
  const deviceSigner = signerFor(input.deviceKeyId ?? "device-a");
  const executorId = input.executorId ?? "device-a";
  const descriptorRevision = input.descriptorRevision ?? 2;
  const credentialBindings = input.credentialBindings ?? descriptor().credentialBindings;
  return {
    descriptor: createSignedCapabilityDescriptor({
      ...withoutSignedIdentity(descriptor()),
      executorId,
      revision: descriptorRevision,
      credentialBindings,
      at: "2026-07-19T00:01:00.000Z",
    }, deviceSigner),
    inventory: createSignedExecutorVersionInventory({
      ...withoutSignedIdentity(inventory()),
      executorId,
      inventoryRevision: input.inventoryRevision ?? 8,
      capabilityRevision: descriptorRevision,
      credentialBindingRevisions: credentialBindings.map(({ bindingId, revision }) => ({
        bindingId,
        revision,
      })),
      at: "2026-07-19T00:01:00.000Z",
    }, deviceSigner),
  };
}

function withoutManifestIdentity<E extends "conversation" | "job">(
  value: ExecutionManifest<E>,
): Omit<ExecutionManifest<E>, "digest" | "v"> {
  const { digest: _digest, v: _v, ...payload } = clone(value);
  return payload;
}

function withoutSignedIdentity<
  T extends CapabilityDescriptor | ExecutorVersionInventory,
>(value: T): Omit<T, "signature" | "v"> {
  const { signature: _signature, v: _v, ...payload } = clone(value);
  return payload;
}

function clone<T>(value: T): T {
  return JSON.parse(canonicalize(value)) as T;
}

function collectKeys(value: unknown, result: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, result);
  } else if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      result.push(key);
      collectKeys(nested, result);
    }
  }
  return result;
}
