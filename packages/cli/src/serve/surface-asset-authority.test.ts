import path from "node:path";
import {
  bindDurableProjectionMutations,
  DurableProjectionStorageError,
  durableProjectionDirectoryName,
  FileArtifactStore,
  FileAuthorityCommitLog,
  FileDurableProjectionIndex,
  surfaceAssetRequestKey,
} from "@zhixing/core/authority";
import type {
  ControlEnvelope,
  ControlRecord,
  Digest,
  JsonValue,
  SurfaceAssetGrant,
  SurfaceAssetScope,
} from "@zhixing/core/contracts";
import {
  byteDigest,
  canonicalize,
  createSignedSurfaceAssetGrant,
  protocolDigest,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing/core/protocol";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import { createSurfaceAssetAuthority } from "./surface-asset-authority.js";

const DURABLE_IO_TEST_TIMEOUT_MS = 30_000;
const CLI_DURABLE_IO_TEST_TIMEOUT_MS = 120_000;
const at = "2026-07-25T00:00:00.000Z";
const scope: SurfaceAssetScope = { domain: "global", anchorEpoch: 1 };
const asset = {
  digest: `sha256:${"a".repeat(64)}` as Digest,
  bytes: 17,
};
const payloadDigest = `sha256:${"b".repeat(64)}` as Digest;

const identity: ProtocolSigner & ProtocolSignatureVerifier = {
  sign(schemaId, version, payload) {
    return {
      alg: "test",
      keyId: "owner",
      sig: protocolDigest("TestSignature", 1, { schemaId, version, payload }),
    };
  },
  verify(schemaId, version, payload, signature) {
    expect(signature).toEqual(this.sign(schemaId, version, payload));
  },
};

describe("surface asset authority", () => {
  it(
    "replays an issued grant directly from its source-bound durable key",
    async () => {
      const root = await createTempDir("surface-asset-authority-replay");
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
      const logRoot = path.join(root, "authority-log");
      const authorityRoot = path.join(root, "authority");
      const first = createSurfaceAssetAuthority({
        authorityRoot,
        log: new FileAuthorityCommitLog(logRoot, artifacts, {
          clock: () => at,
        }),
        retentionLogs: [],
        artifacts,
        signer: identity,
        verifier: identity,
        anchorEpoch: 1,
        clock: () => at,
      });
      const request = {
        kind: "asset-upload" as const,
        scope,
        surfacePrincipal: "surface-one",
        requestId: "request-one",
        assets: [asset],
        payloadDigest,
      };
      const issued = await first.issue(request);

      const reopened = createSurfaceAssetAuthority({
        authorityRoot,
        log: new FileAuthorityCommitLog(logRoot, artifacts, {
          clock: () => at,
        }),
        retentionLogs: [],
        artifacts,
        signer: identity,
        verifier: identity,
        anchorEpoch: 1,
        clock: () => at,
      });
      await expect(reopened.issue(request)).resolves.toEqual(issued);
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "restores visibility after conversation and asset records are semantically misbound",
    async () => {
      const root = await createTempDir("surface-asset-authority-visibility");
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
      const logRoot = path.join(root, "authority-log");
      const authorityRoot = path.join(root, "authority");
      const log = new FileAuthorityCommitLog(logRoot, artifacts, {
        clock: () => at,
      });
      const content = await artifacts.put(
        Buffer.from("durable visible content", "utf8"),
      );
      const contentAsset = { ...content, kind: "file" as const };
      const conversationId = "conversation-visible";
      const envelope = (
        requestId: string,
        body: ControlEnvelope["body"],
      ): ControlEnvelope => {
        const dependencyArtifacts: ControlEnvelope["dependencyArtifacts"] = [];
        return {
          v: 1,
          requestId,
          principal: {
            surfacePrincipal: "surface-visible",
            deviceId: "device-visible",
            connectionId: "connection-visible",
          },
          at,
          dependencyArtifacts,
          body,
          payloadDigest: protocolDigest("ControlEnvelopePayload", 1, {
            body,
            dependencyArtifacts,
          }),
        };
      };
      const create = envelope("request-create-visible", {
        t: "session-create",
      });
      const createCommit = await log.append<ControlRecord>([
        {
          stream: "control",
          body: { t: "received", requestId: create.requestId, envelope: create },
        },
        {
          stream: "control",
          body: {
            t: "applied",
            requestId: create.requestId,
            authorityRevision: 1,
            result: {
              v: 1,
              status: "ok",
              body: { t: "session-create", conversationId },
            },
          },
        },
      ]);
      const input = envelope("request-input-visible", {
        t: "input",
        conversationId,
        ingress: { ingressId: "ingress-visible", source: "first-party" },
        input: { parts: [{ type: "text", text: "attach" }] },
        attachments: [contentAsset],
        invocation: { kind: "agent", source: "interactive" },
        ownerEpoch: 1,
      });
      const inputRef = await artifacts.put(
        Buffer.from(canonicalize(input), "utf8"),
      );
      await log.append<ControlRecord>([
        {
          stream: "control",
          body: {
            t: "received",
            requestId: input.requestId,
            envelope: { ref: inputRef },
          },
        },
        {
          stream: "control",
          body: {
            t: "applied",
            requestId: input.requestId,
            authorityRevision: 2,
            result: {
              v: 1,
              status: "ok",
              body: { t: "input", runId: "run-visible", queuedPosition: 1 },
            },
          },
        },
      ]);
      const conversationScope: SurfaceAssetScope = {
        domain: "conversation",
        conversationId,
        ownerEpoch: 1,
      };
      const conversationKey = `visibility/conversation/${
        Buffer.from(conversationId, "utf8").toString("base64url")
      }`;
      const origin = await log.originCheckpoint();
      const conversationGeneration = `${
        Buffer.from(origin.logId, "utf8").toString("base64url")
      }-${createCommit.lsn.toString(10).padStart(16, "0")}`;
      const createAuthority = () =>
        createSurfaceAssetAuthority({
          authorityRoot,
          log: new FileAuthorityCommitLog(logRoot, artifacts, {
            clock: () => at,
          }),
          retentionLogs: [],
          artifacts,
          signer: identity,
          verifier: identity,
          anchorEpoch: 1,
          clock: () => at,
        });
      await expect(createAuthority().issue({
        kind: "asset-download",
        scope: conversationScope,
        surfacePrincipal: "surface-visible",
        requestId: "request-download-visible-1",
        assets: [content],
      })).resolves.toMatchObject({ kind: "asset-download" });

      await replaceSurfaceProjectionValue(
        log,
        conversationKey,
        {
          conversationId: "conversation-other",
          state: "active",
          generation: "other-generation",
        },
      );
      await expect(createAuthority().issue({
        kind: "asset-download",
        scope: conversationScope,
        surfacePrincipal: "surface-visible",
        requestId: "request-download-visible-2",
        assets: [content],
      })).resolves.toMatchObject({ kind: "asset-download" });

      const visibleKey = `visibility/asset/${
        Buffer.from(`conversation:${conversationId}`, "utf8").toString(
          "base64url",
        )
      }/${
        Buffer.from(conversationGeneration, "utf8").toString(
          "base64url",
        )
      }/${content.digest}`;
      await replaceSurfaceProjectionValues(log, [
        {
          key: conversationKey,
          value: {
            conversationId,
            state: "active",
            generation: conversationGeneration,
          },
        },
        {
          key: visibleKey,
          value: {
            scope: { domain: "global", anchorEpoch: 1 },
            generation: "global:1",
            ref: content,
          },
        },
      ]);
      await expect(createAuthority().issue({
        kind: "asset-download",
        scope: conversationScope,
        surfacePrincipal: "surface-visible",
        requestId: "request-download-visible-3",
        assets: [content],
      })).resolves.toMatchObject({ kind: "asset-download" });
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "rebuilds invalid or cross-bound received envelopes from persisted faults",
    async () => {
      for (
        const fault of [
          "inline-cross-request",
          "stored-cross-request",
          "inline-invalid-contract",
          "stored-invalid-json",
          "stored-missing",
          "stored-corrupt",
        ] as const
      ) {
        const stored = fault.startsWith("stored-");
        const root = await createTempDir(
          `surface-asset-received-envelope-${fault}`,
        );
        const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
        const logRoot = path.join(root, "authority-log");
        const authorityRoot = path.join(root, "authority");
        const openLog = () =>
          new FileAuthorityCommitLog(logRoot, artifacts, { clock: () => at });
        const openAuthority = (currentLog: FileAuthorityCommitLog) =>
          createSurfaceAssetAuthority({
            authorityRoot,
            log: currentLog,
            retentionLogs: [],
            artifacts,
            signer: identity,
            verifier: identity,
            anchorEpoch: 1,
            clock: () => at,
          });
        let log = openLog();
        let authority = openAuthority(log);
        const principal = {
          surfacePrincipal: "surface-received-envelope",
          deviceId: "device-received-envelope",
          connectionId: "connection-received-envelope",
        };
        const envelope = (
          requestId: string,
          body: ControlEnvelope["body"],
        ): ControlEnvelope => {
          const dependencyArtifacts: ControlEnvelope["dependencyArtifacts"] = [];
          return {
            v: 1,
            requestId,
            principal,
            at,
            dependencyArtifacts,
            body,
            payloadDigest: protocolDigest("ControlEnvelopePayload", 1, {
              body,
              dependencyArtifacts,
            }),
          };
        };
        const conversationId = `conversation-received-envelope-${fault}`;
        const create = envelope(`request-create-${fault}`, {
          t: "session-create",
        });
        const createCommit = await log.append<ControlRecord>([
          {
            stream: "control",
            body: {
              t: "received",
              requestId: create.requestId,
              envelope: create,
            },
          },
          {
            stream: "control",
            body: {
              t: "applied",
              requestId: create.requestId,
              authorityRevision: 1,
              result: {
                v: 1,
                status: "ok",
                body: { t: "session-create", conversationId },
              },
            },
          },
        ]);
        const current = await artifacts.put(
          Buffer.from(`current-${fault}`, "utf8"),
        );
        const other = await artifacts.put(
          Buffer.from(`other-${fault}`, "utf8"),
        );
        const input = (requestId: string, ref: typeof current) =>
          envelope(requestId, {
            t: "input",
            conversationId,
            ingress: {
              ingressId: `ingress-${requestId}`,
              source: "first-party",
            },
            input: { parts: [{ type: "text", text: requestId }] },
            attachments: [{ ...ref, kind: "file" }],
            invocation: { kind: "agent", source: "interactive" },
            ownerEpoch: 1,
          });
        const currentEnvelope = input(`request-current-${fault}`, current);
        const otherEnvelope = input(`request-other-${fault}`, other);
        const storeEnvelope = async (value: ControlEnvelope) =>
          !stored
            ? value
            : {
              ref: await artifacts.put(
                Buffer.from(canonicalize(value), "utf8"),
              ),
            };
        const currentStored = await storeEnvelope(currentEnvelope);
        const invalidStoredRef = await artifacts.put(
          Buffer.from("not-json", "utf8"),
        );
        const corruptEnvelope: JsonValue = fault === "inline-cross-request"
          ? otherEnvelope
          : fault === "stored-cross-request"
          ? {
            ref: await artifacts.put(
              Buffer.from(canonicalize(otherEnvelope), "utf8"),
            ),
          }
          : fault === "inline-invalid-contract"
          ? { requestId: currentEnvelope.requestId }
          : fault === "stored-invalid-json"
          ? {
            ref: invalidStoredRef,
          }
          : fault === "stored-corrupt"
          ? {
            ref: {
              ...invalidStoredRef,
              bytes: invalidStoredRef.bytes + 1,
            },
          }
          : {
            ref: {
              digest: `sha256:${"0".repeat(64)}`,
              bytes: 7,
            },
          };
        await log.append<ControlRecord>([{
          stream: "control",
          body: {
            t: "received",
            requestId: currentEnvelope.requestId,
            envelope: currentStored,
          },
        }]);
        const origin = await log.originCheckpoint();
        const generation = `${
          Buffer.from(origin.logId, "utf8").toString("base64url")
        }-${createCommit.lsn.toString(10).padStart(16, "0")}`;
        const conversationKey = `visibility/conversation/${
          Buffer.from(conversationId, "utf8").toString("base64url")
        }`;
        const receivedKey = `visibility/received/${
          Buffer.from(currentEnvelope.requestId, "utf8").toString("base64url")
        }`;
        await replaceSurfaceProjectionValues(log, [
          {
            key: conversationKey,
            value: {
              conversationId,
              state: "active",
              generation,
            },
          },
          {
            key: receivedKey,
            value: {
              requestId: currentEnvelope.requestId,
              envelope: corruptEnvelope,
            },
          },
        ]);
        log = openLog();
        authority = openAuthority(log);
        await expect(log.append<ControlRecord>([{
          stream: "control",
          body: {
            t: "applied",
            requestId: currentEnvelope.requestId,
            authorityRevision: 2,
            result: {
              v: 1,
              status: "ok",
              body: {
                t: "input",
                runId: `run-${fault}`,
                queuedPosition: 1,
              },
            },
          },
        }])).resolves.toBeDefined();
        const currentScope: SurfaceAssetScope = {
          domain: "conversation",
          conversationId,
          ownerEpoch: 1,
        };
        await expect(authority.issue({
          kind: "asset-download",
          scope: currentScope,
          surfacePrincipal: principal.surfacePrincipal,
          requestId: `download-current-${fault}`,
          assets: [current],
        })).resolves.toMatchObject({ kind: "asset-download" });
        await expect(authority.issue({
          kind: "asset-download",
          scope: currentScope,
          surfacePrincipal: principal.surfacePrincipal,
          requestId: `download-other-${fault}`,
          assets: [other],
        })).rejects.toThrow(
          "Surface asset download is outside the visible asset set",
        );
      }
    },
    CLI_DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "rebuilds received and grant-history records before applying their identities",
    async () => {
      const root = await createTempDir("surface-asset-secondary-key-binding");
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
      const logRoot = path.join(root, "authority-log");
      const authorityRoot = path.join(root, "authority");
      const openLog = () =>
        new FileAuthorityCommitLog(logRoot, artifacts, { clock: () => at });
      const openAuthority = (log: FileAuthorityCommitLog) =>
        createSurfaceAssetAuthority({
          authorityRoot,
          log,
          retentionLogs: [],
          artifacts,
          signer: identity,
          verifier: identity,
          anchorEpoch: 1,
          clock: () => at,
        });
      let log = openLog();
      const authority = openAuthority(log);
      const request = {
        kind: "asset-upload" as const,
        scope,
        surfacePrincipal: "surface-one",
        requestId: "request-history-one",
        assets: [asset],
        payloadDigest,
      };
      const issued = await authority.issue(request);
      const other = await authority.issue({
        ...request,
        requestId: "request-history-two",
      });
      const firstHistoryKey = `history/${
        Buffer.from(issued.grantId, "utf8").toString("base64url")
      }`;
      const otherRequestKey = `request/${
        Buffer.from(
          surfaceAssetRequestKey(
            other.scope,
            other.surfacePrincipal,
            other.requestId,
          ),
          "utf8",
        ).toString("base64url")
      }`;
      const otherHistory = {
        key: firstHistoryKey,
        requestKey: otherRequestKey,
      };
      await replaceSurfaceProjectionValue(
        log,
        firstHistoryKey,
        otherHistory,
      );
      log = openLog();
      openAuthority(log);
      await expect(log.append<ControlRecord>([{
        stream: "control",
        body: { t: "asset-grant-issued", grant: issued },
      }])).resolves.toBeDefined();

      const requestId = "request-received-binding";
      const body: ControlEnvelope["body"] = { t: "session-create" };
      const dependencyArtifacts: ControlEnvelope["dependencyArtifacts"] = [];
      const envelope: ControlEnvelope = {
        v: 1,
        requestId,
        principal: {
          surfacePrincipal: "surface-one",
          deviceId: "device-one",
          connectionId: "connection-one",
        },
        at,
        dependencyArtifacts,
        body,
        payloadDigest: protocolDigest("ControlEnvelopePayload", 1, {
          body,
          dependencyArtifacts,
        }),
      };
      await log.append<ControlRecord>([{
        stream: "control",
        body: { t: "received", requestId, envelope },
      }]);
      await replaceSurfaceProjectionValue(
        log,
        `visibility/received/${
          Buffer.from(requestId, "utf8").toString("base64url")
        }`,
        {
          requestId: "request-other",
          envelope,
        },
      );
      log = openLog();
      openAuthority(log);
      await expect(log.append<ControlRecord>([{
        stream: "control",
        body: {
          t: "applied",
          requestId,
          authorityRevision: 1,
          result: {
            v: 1,
            status: "ok",
            body: {
              t: "session-create",
              conversationId: "conversation-received-binding",
            },
          },
        },
      }])).resolves.toBeDefined();
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "rejects request-key and grant-id conflicts inside one commit",
    async () => {
      const root = await createTempDir("surface-asset-authority-conflict");
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
      const log = new FileAuthorityCommitLog(
        path.join(root, "authority-log"),
        artifacts,
        { clock: () => at },
      );
      createSurfaceAssetAuthority({
        authorityRoot: path.join(root, "authority"),
        log,
        retentionLogs: [],
        artifacts,
        signer: identity,
        verifier: identity,
        anchorEpoch: 1,
        clock: () => at,
      });
      const grant = (grantId: string, requestId: string) =>
        createSignedSurfaceAssetGrant({
          v: 1,
          grantId,
          scope,
          surfacePrincipal: "surface-one",
          requestId,
          kind: "asset-upload",
          assets: [asset],
          payloadDigest,
          issuedAt: at,
          expiry: "2026-07-25T01:00:00.000Z",
        }, identity);
      const first = grant("grt-01J00000000000000000000001", "request-one");
      const conflictingRequest = grant(
        "grt-01J00000000000000000000002",
        "request-one",
      );
      await expect(
        log.append<ControlRecord>([
          { stream: "control", body: { t: "asset-grant-issued", grant: first } },
          {
            stream: "control",
            body: { t: "asset-grant-issued", grant: conflictingRequest },
          },
        ]),
      ).rejects.toThrow("conflicting durable grants");
      await expect(log.readAll()).resolves.toEqual([]);

      const conflictingId = grant(first.grantId, "request-two");
      await expect(
        log.append<ControlRecord>([
          { stream: "control", body: { t: "asset-grant-issued", grant: first } },
          {
            stream: "control",
            body: { t: "asset-grant-issued", grant: conflictingId },
          },
        ]),
      ).rejects.toThrow("conflicting durable payloads");
      await expect(log.readAll()).resolves.toEqual([]);
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it.each([
    "checkpoint",
    "envelope-digest",
    "grant",
    "source-shape",
  ] as const)(
    "rebuilds a checksum-valid request index with a misbound %s",
    async (misbinding) => {
      const root = await createTempDir(`surface-grant-source-${misbinding}`);
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
      const log = new FileAuthorityCommitLog(
        path.join(root, "authority-log"),
        artifacts,
        { clock: () => at },
      );
      const request = {
        kind: "asset-upload" as const,
        scope,
        surfacePrincipal: "surface-one",
        requestId: "request-one",
        assets: [asset],
        payloadDigest,
      };
      const grant = createSignedSurfaceAssetGrant({
        v: 1,
        grantId: "grt-01J00000000000000000000001",
        scope,
        surfacePrincipal: request.surfacePrincipal,
        requestId: request.requestId,
        kind: request.kind,
        assets: request.assets,
        payloadDigest,
        issuedAt: at,
        expiry: "2026-07-25T01:00:00.000Z",
      }, identity);
      const wrongGrant = createSignedSurfaceAssetGrant({
        v: 1,
        grantId: "grt-01J00000000000000000000002",
        scope,
        surfacePrincipal: request.surfacePrincipal,
        requestId: request.requestId,
        kind: request.kind,
        assets: request.assets,
        payloadDigest,
        issuedAt: at,
        expiry: "2026-07-25T01:00:00.000Z",
      }, identity);
      const requestKey = `request/${
        Buffer.from(
          surfaceAssetRequestKey(
            scope,
            request.surfacePrincipal,
            request.requestId,
          ),
          "utf8",
        ).toString("base64url")
      }`;
      let corruptFirstReduction = true;
      log.durableProjection({
        projectionId: "surface-asset-grants",
        reducerVersion: 7,
        reduce(envelope, _current, source) {
          const issued = envelope.entries.find((entry) =>
            entry.stream === "control" &&
            (entry.body as ControlRecord).t === "asset-grant-issued"
          );
          if (!issued) return [];
          const storedGrant = (
            issued.body as Extract<
              ControlRecord,
              { t: "asset-grant-issued" }
            >
          ).grant;
          const stored = {
            grant: storedGrant,
            source: {
              checkpoint: source.checkpoint,
              envelopeDigest: envelope.envelopeDigest,
            },
          };
          const value = corruptFirstReduction
            ? corruptStoredGrant(stored, misbinding, wrongGrant)
            : stored;
          corruptFirstReduction = false;
          return [{
            kind: "put" as const,
            key: requestKey,
            value: JSON.parse(canonicalize(value)) as JsonValue,
          }];
        },
      });
      await log.append<ControlRecord>([
        { stream: "control", body: { t: "asset-grant-issued", grant } },
      ]);

      const authority = createSurfaceAssetAuthority({
        authorityRoot: path.join(root, "authority"),
        log,
        retentionLogs: [],
        artifacts,
        signer: identity,
        verifier: identity,
        anchorEpoch: 1,
        clock: () => at,
      });
      await expect(authority.issue(request)).resolves.toEqual(grant);
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "rebuilds a cross-request index entry before replay or adoption",
    async () => {
      const root = await createTempDir("surface-grant-source-request-key");
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
      const log = new FileAuthorityCommitLog(
        path.join(root, "authority-log"),
        artifacts,
        { clock: () => at },
      );
      const storedAsset = await artifacts.put(
        Buffer.from("cross-request-adoption", "utf8"),
      );
      const request = {
        kind: "asset-upload" as const,
        scope,
        surfacePrincipal: "surface-one",
        requestId: "request-one",
        assets: [storedAsset],
        payloadDigest,
      };
      const otherGrant = createSignedSurfaceAssetGrant({
        v: 1,
        grantId: "grt-01J00000000000000000000003",
        scope,
        surfacePrincipal: request.surfacePrincipal,
        requestId: "request-two",
        kind: request.kind,
        assets: request.assets,
        payloadDigest,
        issuedAt: at,
        expiry: "2026-07-25T01:00:00.000Z",
      }, identity);
      const requestedIndexKey = surfaceGrantIndexKey(
        scope,
        request.surfacePrincipal,
        request.requestId,
      );
      let corruptFirstReduction = true;
      log.durableProjection({
        projectionId: "surface-asset-grants",
        reducerVersion: 7,
        reduce(envelope, _current, source) {
          const issued = envelope.entries.find((entry) =>
            entry.stream === "control" &&
            (entry.body as ControlRecord).t === "asset-grant-issued"
          );
          if (!issued) return [];
          const storedGrant = (
            issued.body as Extract<
              ControlRecord,
              { t: "asset-grant-issued" }
            >
          ).grant;
          const key = corruptFirstReduction
            ? requestedIndexKey
            : surfaceGrantIndexKey(
              storedGrant.scope,
              storedGrant.surfacePrincipal,
              storedGrant.requestId,
            );
          corruptFirstReduction = false;
          return [{
            kind: "put" as const,
            key,
            value: JSON.parse(canonicalize({
              grant: storedGrant,
              source: {
                checkpoint: source.checkpoint,
                envelopeDigest: envelope.envelopeDigest,
              },
            })) as JsonValue,
          }];
        },
      });
      await log.append<ControlRecord>([
        {
          stream: "control",
          body: { t: "asset-grant-issued", grant: otherGrant },
        },
      ]);

      const authority = createSurfaceAssetAuthority({
        authorityRoot: path.join(root, "authority"),
        log,
        retentionLogs: [],
        artifacts,
        signer: identity,
        verifier: identity,
        anchorEpoch: 1,
        clock: () => at,
      });
      await expect(authority.assertUploadAdoption(request)).rejects.toThrow(
        "unknown or revoked",
      );
      const issued = await authority.issue(request);
      expect(issued.requestId).toBe(request.requestId);
      expect(issued.grantId).not.toBe(otherGrant.grantId);
      await expect(authority.assertUploadAdoption(request)).resolves
        .toBeUndefined();
    },
    CLI_DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "rebuilds lifecycle grant history before adopting an issued request",
    async () => {
      const root = await createTempDir("surface-grant-lifecycle-history");
      const artifactRoot = path.join(root, "artifacts");
      const logRoot = path.join(root, "authority-log");
      const authorityRoot = path.join(root, "authority");
      const artifacts = new FileArtifactStore(artifactRoot);
      const log = new FileAuthorityCommitLog(logRoot, artifacts, {
        clock: () => at,
      });
      const storedAsset = await artifacts.put(
        Buffer.from("cross-projection-adoption", "utf8"),
      );
      const request = {
        kind: "asset-upload" as const,
        scope,
        surfacePrincipal: "surface-one",
        requestId: "request-cross-projection",
        assets: [storedAsset],
        payloadDigest,
      };
      const authority = createSurfaceAssetAuthority({
        authorityRoot,
        log,
        retentionLogs: [],
        artifacts,
        signer: identity,
        verifier: identity,
        anchorEpoch: 1,
        clock: () => at,
      });
      const issued = await authority.issue(request);
      const { signature: _signature, ...unsignedIssued } = issued;
      const conflicting = createSignedSurfaceAssetGrant(
        {
          ...unsignedIssued,
          requestId: "request-conflicting-history",
        },
        identity,
      );
      await replaceLifecycleProjectionValue(
        authorityRoot,
        log,
        `grant/history/${
          Buffer.from(issued.grantId, "utf8").toString("base64url")
        }`,
        JSON.parse(canonicalize(conflicting)) as JsonValue,
      );

      const reopenedArtifacts = new FileArtifactStore(artifactRoot);
      const reopened = createSurfaceAssetAuthority({
        authorityRoot,
        log: new FileAuthorityCommitLog(logRoot, reopenedArtifacts, {
          clock: () => at,
        }),
        retentionLogs: [],
        artifacts: reopenedArtifacts,
        signer: identity,
        verifier: identity,
        anchorEpoch: 1,
        clock: () => at,
      });
      await expect(reopened.assertUploadAdoption(request)).resolves
        .toBeUndefined();
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "rebuilds an invalid durable-time value before observing a clock rollback",
    async () => {
      const root = await createTempDir("surface-grant-durable-time");
      const artifactRoot = path.join(root, "artifacts");
      const logRoot = path.join(root, "authority-log");
      const authorityRoot = path.join(root, "authority");
      let now = "2026-07-25T12:00:00.000Z";
      const artifacts = new FileArtifactStore(artifactRoot);
      const log = new FileAuthorityCommitLog(logRoot, artifacts, {
        clock: () => now,
      });
      const open = (
        store: FileArtifactStore,
        authorityLog: FileAuthorityCommitLog,
      ) =>
        createSurfaceAssetAuthority({
          authorityRoot,
          log: authorityLog,
          retentionLogs: [],
          artifacts: store,
          signer: identity,
          verifier: identity,
          anchorEpoch: 1,
          clock: () => now,
        });
      const first = await open(artifacts, log).issue({
        kind: "asset-upload",
        scope,
        surfacePrincipal: "surface-one",
        requestId: "request-time-one",
        assets: [asset],
        payloadDigest,
      });
      await replaceSurfaceProjectionValue(log, "meta/durable-time", {
        time: first.issuedAt,
      });

      now = "2026-07-24T12:00:00.000Z";
      const reopenedArtifacts = new FileArtifactStore(artifactRoot);
      const second = await open(
        reopenedArtifacts,
        new FileAuthorityCommitLog(logRoot, reopenedArtifacts, {
          clock: () => now,
        }),
      ).issue({
        kind: "asset-upload",
        scope,
        surfacePrincipal: "surface-one",
        requestId: "request-time-two",
        assets: [asset],
        payloadDigest,
      });
      expect(Date.parse(second.issuedAt)).toBeGreaterThanOrEqual(
        Date.parse(first.issuedAt),
      );
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "defers temporary cleanup when an authority head advances inside the delete fence",
    async () => {
      const root = await createTempDir("surface-asset-deferred-cleanup");
      let now = at;
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
      const log = new FileAuthorityCommitLog(
        path.join(root, "authority-log"),
        artifacts,
        { clock: () => now },
      );
      const authority = createSurfaceAssetAuthority({
        authorityRoot: path.join(root, "authority"),
        log,
        retentionLogs: [],
        artifacts,
        signer: identity,
        verifier: identity,
        anchorEpoch: 1,
        clock: () => now,
      });
      const bytes = Buffer.from("temporary-only-deferred-cleanup", "utf8");
      const temporaryRef = {
        digest: byteDigest(bytes),
        bytes: bytes.byteLength,
      };
      const request = {
        kind: "asset-upload" as const,
        scope,
        surfacePrincipal: "surface-one",
        requestId: "request-deferred-cleanup",
        assets: [temporaryRef],
        payloadDigest,
      };
      const grant = await authority.issue(request);
      await authority.append(
        grant,
        {
          scope,
          surfacePrincipal: request.surfacePrincipal,
          kind: request.kind,
          payloadDigest,
        },
        temporaryRef,
        0,
        bytes,
      );
      now = "2026-07-27T00:00:00.000Z";

      const deleteBatch =
        artifacts.deleteIfUnreferencedBatch.bind(artifacts);
      const retentionSnapshots: string[] = [];
      let advanceHead = true;
      vi.spyOn(artifacts, "deleteIfUnreferencedBatch").mockImplementation(
        async (refs, loadRetainedReferences) => {
          if (advanceHead) {
            advanceHead = false;
            await log.append<ControlRecord>([{
              stream: "control",
              body: { t: "authority-time-frontier", frontier: now },
            }]);
          }
          return deleteBatch(refs, async (candidates) => {
            const snapshot = await loadRetainedReferences(candidates);
            retentionSnapshots.push(snapshot.status);
            return snapshot;
          });
        },
      );

      await expect(authority.collectExpiredTemporaryAssets()).resolves.toEqual({
        processed: 0,
        removed: 0,
        hasMore: true,
      });
      const second = await authority.collectExpiredTemporaryAssets();
      expect(retentionSnapshots).toEqual(["deferred", "current"]);
      expect(second).toEqual({
        processed: 1,
        removed: 1,
        hasMore: false,
      });
    },
    CLI_DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "does not retry a bound projection that exhausted its own recovery",
    async () => {
      const root = await createTempDir("surface-grant-exhausted-recovery");
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
      const log = new FileAuthorityCommitLog(
        path.join(root, "authority-log"),
        artifacts,
        { clock: () => at },
      );
      const rebuild = vi.fn(async () => undefined);
      vi.spyOn(log, "durableProjection").mockImplementation(() => ({
        get: async () => {
          throw new DurableProjectionStorageError(
            "persistent projection failure",
          );
        },
        scan: async () => {
          throw new DurableProjectionStorageError(
            "persistent projection failure",
          );
        },
        checkpoints: async () => {
          throw new DurableProjectionStorageError(
            "persistent projection failure",
          );
        },
        rebuild,
      }));
      const authority = createSurfaceAssetAuthority({
        authorityRoot: path.join(root, "authority"),
        log,
        retentionLogs: [],
        artifacts,
        signer: identity,
        verifier: identity,
        anchorEpoch: 1,
        clock: () => at,
      });

      await expect(authority.issue({
        kind: "asset-upload",
        scope,
        surfacePrincipal: "surface-one",
        requestId: "request-persistent-projection-failure",
        assets: [asset],
        payloadDigest,
      })).rejects.toThrow("persistent projection failure");
      expect(rebuild).not.toHaveBeenCalled();
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "keeps conversation visibility usable under a non-default anchor epoch",
    async () => {
      // 可见性键只由 domain 与 conversationId 定位,epoch 资格单独 fail-closed。
      // 若记录值再反绑 epoch,写入端的占位常量会让非默认 epoch 下的每次查询
      // 先触发一次无效重建再失败。
      const anchorEpoch = 3;
      const root = await createTempDir("surface-asset-authority-epoch");
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
      const logRoot = path.join(root, "authority-log");
      const authorityRoot = path.join(root, "authority");
      const log = new FileAuthorityCommitLog(logRoot, artifacts, {
        clock: () => at,
      });
      const content = await artifacts.put(
        Buffer.from("epoch scoped content", "utf8"),
      );
      const contentAsset = { ...content, kind: "file" as const };
      const conversationId = "conversation-epoch";
      const envelope = (
        requestId: string,
        body: ControlEnvelope["body"],
      ): ControlEnvelope => {
        const dependencyArtifacts: ControlEnvelope["dependencyArtifacts"] = [];
        return {
          v: 1,
          requestId,
          principal: {
            surfacePrincipal: "surface-epoch",
            deviceId: "device-epoch",
            connectionId: "connection-epoch",
          },
          at,
          dependencyArtifacts,
          body,
          payloadDigest: protocolDigest("ControlEnvelopePayload", 1, {
            body,
            dependencyArtifacts,
          }),
        };
      };
      const create = envelope("request-create-epoch", { t: "session-create" });
      await log.append<ControlRecord>([
        {
          stream: "control",
          body: { t: "received", requestId: create.requestId, envelope: create },
        },
        {
          stream: "control",
          body: {
            t: "applied",
            requestId: create.requestId,
            authorityRevision: 1,
            result: {
              v: 1,
              status: "ok",
              body: { t: "session-create", conversationId },
            },
          },
        },
      ]);
      const input = envelope("request-input-epoch", {
        t: "input",
        conversationId,
        ingress: { ingressId: "ingress-epoch", source: "first-party" },
        input: { parts: [{ type: "text", text: "attach" }] },
        attachments: [contentAsset],
        invocation: { kind: "agent", source: "interactive" },
        ownerEpoch: anchorEpoch,
      });
      const inputRef = await artifacts.put(
        Buffer.from(canonicalize(input), "utf8"),
      );
      await log.append<ControlRecord>([
        {
          stream: "control",
          body: {
            t: "received",
            requestId: input.requestId,
            envelope: { ref: inputRef },
          },
        },
        {
          stream: "control",
          body: {
            t: "applied",
            requestId: input.requestId,
            authorityRevision: 2,
            result: {
              v: 1,
              status: "ok",
              body: { t: "input", runId: "run-epoch", queuedPosition: 1 },
            },
          },
        },
      ]);

      const conversationScope: SurfaceAssetScope = {
        domain: "conversation",
        conversationId,
        ownerEpoch: anchorEpoch,
      };
      const createAuthority = () =>
        createSurfaceAssetAuthority({
          authorityRoot,
          log: new FileAuthorityCommitLog(logRoot, artifacts, {
            clock: () => at,
          }),
          retentionLogs: [],
          artifacts,
          signer: identity,
          verifier: identity,
          anchorEpoch,
          clock: () => at,
        });

      await expect(createAuthority().issue({
        kind: "asset-download",
        scope: conversationScope,
        surfacePrincipal: "surface-epoch",
        requestId: "request-download-epoch",
        assets: [content],
      })).resolves.toMatchObject({ kind: "asset-download" });

      // 重开后仍可用：持久记录的形状本身与 epoch 无关。
      await expect(createAuthority().issue({
        kind: "asset-download",
        scope: conversationScope,
        surfacePrincipal: "surface-epoch",
        requestId: "request-download-epoch-reopened",
        assets: [content],
      })).resolves.toMatchObject({ kind: "asset-download" });

      // 错 epoch 仍由资格检查单点拒绝，不因值反绑而改变语义。
      await expect(createAuthority().issue({
        kind: "asset-download",
        scope: {
          domain: "conversation",
          conversationId,
          ownerEpoch: anchorEpoch + 1,
        },
        surfacePrincipal: "surface-epoch",
        requestId: "request-download-epoch-stale",
        assets: [content],
      })).rejects.toThrow();
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );
});

function surfaceGrantIndexKey(
  scope: SurfaceAssetScope,
  surfacePrincipal: string,
  requestId: string,
): string {
  return `request/${
    Buffer.from(
      surfaceAssetRequestKey(scope, surfacePrincipal, requestId),
      "utf8",
    ).toString("base64url")
  }`;
}

function surfaceProjectionIndex(
  log: FileAuthorityCommitLog,
): FileDurableProjectionIndex {
  return new FileDurableProjectionIndex({
    rootDir: path.join(
      log.rootDir,
      "projections",
      durableProjectionDirectoryName("surface-asset-grants"),
    ),
    projectionId: "surface-asset-grants",
    reducerVersion: 7,
  });
}

async function replaceSurfaceProjectionValue(
  log: FileAuthorityCommitLog,
  key: string,
  value: JsonValue,
): Promise<void> {
  await replaceSurfaceProjectionValues(log, [{ key, value }]);
}

async function replaceSurfaceProjectionValues(
  log: FileAuthorityCommitLog,
  records: readonly { readonly key: string; readonly value: JsonValue }[],
): Promise<void> {
  const index = surfaceProjectionIndex(log);
  const origin = await log.originCheckpoint();
  await index.initialize({ authority: origin });
  await index.reset({ authority: origin });
  const prepared = await index.prepare(
    bindDurableProjectionMutations(
      records.map(({ key, value }) => ({ kind: "put" as const, key, value })),
    ),
  );
  index.publish(prepared, { authority: await log.checkpoint() });
  await index.flush();
}

async function replaceLifecycleProjectionValue(
  authorityRoot: string,
  log: FileAuthorityCommitLog,
  key: string,
  value: JsonValue,
): Promise<void> {
  const index = new FileDurableProjectionIndex({
    rootDir: path.join(authorityRoot, "derived", "artifact-lifecycle"),
    projectionId: "artifact-lifecycle",
    reducerVersion: 3,
  });
  const origin = await log.originCheckpoint();
  await index.initialize({ [origin.logId]: origin });
  const prepared = await index.prepare(
    bindDurableProjectionMutations([{ kind: "put", key, value }]),
  );
  index.publish(prepared, index.checkpoints());
  await index.flush();
}

function corruptStoredGrant(
  stored: {
    readonly grant: SurfaceAssetGrant;
    readonly source: {
      readonly checkpoint: {
        readonly logId: string;
        readonly lsn: number;
        readonly frameEndOffset: number;
        readonly prefixDigest: Digest;
      };
      readonly envelopeDigest: Digest;
    };
  },
  misbinding: "checkpoint" | "envelope-digest" | "grant" | "source-shape",
  wrongGrant: SurfaceAssetGrant,
) {
  if (misbinding === "grant") return { ...stored, grant: wrongGrant };
  if (misbinding === "source-shape") {
    return {
      ...stored,
      source: {
        ...stored.source,
        envelopeDigest: "not-a-digest" as Digest,
      },
    };
  }
  if (misbinding === "envelope-digest") {
    return {
      ...stored,
      source: {
        ...stored.source,
        envelopeDigest: `sha256:${"d".repeat(64)}` as Digest,
      },
    };
  }
  return {
    ...stored,
    source: {
      ...stored.source,
      checkpoint: {
        ...stored.source.checkpoint,
        prefixDigest: `sha256:${"c".repeat(64)}` as Digest,
      },
    },
  };
}
