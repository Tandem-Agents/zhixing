import type { HomeTrustEvent, HomeTrustEventBody } from "@zhixing/core/contracts";
import { protocolDigest } from "@zhixing/core/protocol";
import { DeviceKey, enrollDeviceIdentity } from "@zhixing/mesh/device-identity";
import type { MeshServiceClient } from "@zhixing/mesh/request-channel";
import { MeshServiceRegistry, type MeshServiceDefinition } from "@zhixing/mesh/service-registry";
import {
  applyTrustEvent,
  buildHomeTrustRecord,
  createSignedTrustEvent,
  createTrustGenesisEvent,
  initializeTrustChain,
  LEGACY_TRUST_RECORD_MESSAGE,
  replayTrustChain,
  type TrustProjection,
} from "@zhixing/mesh/trust-chain";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";
import {
  reconcilePlannedAnchorTrustFromPeer,
  registerPlannedAnchorTrustReconciliationService,
} from "./planned-anchor-transfer-mesh.js";

const AT = "2026-08-12T00:00:00.000Z";

describe("one-time continuation of legacy v1 trust snapshots", () => {
  it("re-signs the head on the duty device once and lets a member fetch the same-head v2 snapshot", async () => {
    const issuerKey = await DeviceKey.generate();
    const memberKey = await DeviceKey.generate();
    const issuer = enrollDeviceIdentity(issuerKey, { displayName: "值班电脑", platform: "headless", enrolledAt: AT });
    const member = enrollDeviceIdentity(memberKey, { displayName: "工作电脑", platform: "headless", enrolledAt: AT });
    // 开发资料：同一条链，每个链头都由按原 v1 规则签名的快照闭合
    const genesis = createTrustGenesisEvent({ homeId: "home-legacy", issuer, signer: issuerKey, at: AT });
    let state = initializeTrustChain(genesis);
    const groups: { readonly event: HomeTrustEvent; readonly projection: TrustProjection }[] = [{ event: genesis, projection: state }];
    const bodies: HomeTrustEventBody[] = [
      { t: "role-change", deviceId: issuer.deviceId, roles: ["anchor"] },
      { t: "enroll", device: member, roles: ["executor"], pairingTranscriptDigest: protocolDigest("LegacyPairing", 1, { member: member.deviceId }) },
    ];
    for (const body of bodies) {
      const event = createSignedTrustEvent({ current: state, body, at: AT, signer: issuerKey });
      state = applyTrustEvent(state, event);
      groups.push({ event, projection: state });
    }
    const openLegacy = async (label: string, key: DeviceKey) => {
      const store = new FileMeshBootstrapStore(await createTempDir(`trust-continuation-${label}`), key);
      for (const { event, projection } of groups) {
        await store.authorityLog().append([
          { stream: "trust", body: { t: "home-trust-event", event } },
          { stream: "trust", body: { t: "home-trust-record", record: legacyRecord(projection, issuerKey) } },
        ]);
      }
      return store;
    };
    const issuerStore = await openLegacy("issuer", issuerKey);
    const memberStore = await openLegacy("member", memberKey);
    try {
      // 当前视图照常可用，当前快照的读者不交 v1
      expect((await memberStore.loadCurrentTrust())?.members.map((entry) => entry.device.deviceId).sort())
        .toEqual([issuer.deviceId, member.deviceId].sort());
      await expect(memberStore.loadTrustRecord()).rejects.toThrow(LEGACY_TRUST_RECORD_MESSAGE);

      // 值班设备：首次访问即补签同一链头的 v2，只补一次
      const continued = await issuerStore.loadTrustRecord();
      expect(continued).toEqual(buildHomeTrustRecord(replayTrustChain(groups.map((group) => group.event)), issuerKey));
      await expect(issuerStore.loadTrustRecord()).resolves.toEqual(continued);
      await expect(issuerStore.continueCurrentTrustRecord(issuerKey)).resolves.toBeUndefined();
      expect(await recordCount(issuerStore)).toBe(groups.length + 1);

      // 成员设备：对齐时带回同一链头的 v2 快照，不重复写
      const link = new InMemoryLink();
      registerPlannedAnchorTrustReconciliationService(link, { store: issuerStore, authorizePeer: () => true });
      await reconcilePlannedAnchorTrustFromPeer(link.client(), { store: memberStore, localDeviceId: memberKey.deviceId });
      await expect(memberStore.loadTrustRecord()).resolves.toEqual(continued);
      await reconcilePlannedAnchorTrustFromPeer(link.client(), { store: memberStore, localDeviceId: memberKey.deviceId });
      expect(await recordCount(memberStore)).toBe(groups.length + 1);
    } finally {
      await issuerStore.stopStorageMaintenance();
      await memberStore.stopStorageMaintenance();
    }
  }, 60_000);
});

/** 按原 v1 规则签出的旧格式快照（列全成员），只用来构造开发资料。 */
function legacyRecord(projection: TrustProjection, signer: DeviceKey) {
  const unsigned = {
    v: 1 as const,
    homeId: projection.homeId,
    trustEpoch: projection.trustEpoch,
    chainHead: { ...projection.chainHead },
    issuer: { ...projection.issuer },
    members: projection.members.map((entry) => ({ device: entry.device, roles: [...entry.roles], state: entry.state })),
  };
  return { ...unsigned, signature: signer.sign("HomeTrustRecord", 1, unsigned) };
}

async function recordCount(store: FileMeshBootstrapStore): Promise<number> {
  return (await store.authorityLog().readStream("trust"))
    .filter((entry) => (entry.body as { readonly t?: string }).t === "home-trust-record").length;
}

/** 截获注册的服务定义，直接调用其处理函数；只替代传输，服务与对齐逻辑都是真实实现。 */
class InMemoryLink extends MeshServiceRegistry {
  readonly #definitions = new Map<string, MeshServiceDefinition>();

  override register(serviceId: string, definition: MeshServiceDefinition): () => void {
    this.#definitions.set(serviceId, definition);
    return super.register(serviceId, definition);
  }

  client(): MeshServiceClient {
    const connection = { peer: { deviceId: "member" } } as never;
    return {
      request: async (serviceId, payload, signal) => {
        const definition = this.#definitions.get(serviceId);
        if (!definition) throw new Error(`service is not registered: ${serviceId}`);
        return definition.handler(payload, connection, signal ?? new AbortController().signal);
      },
    };
  }
}
