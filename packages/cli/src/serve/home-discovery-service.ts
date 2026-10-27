import type { DeviceIdentity, DeviceRole, HomeTrustEvent, MeshEndpointDescriptor, SecretStorePort } from "@zhixing/core/contracts";
import type { DeviceKey } from "@zhixing/mesh/device-identity";
import { canonicalize } from "@zhixing/core/protocol";
import type {
  DisasterRecoveryCommitProof,
  HomeDiscoveryResumePoint,
  HomeDiscoveryServerPorts,
  HomeTrustChainPoint,
  VerifiedHomeDiscovery,
  VerifiedHomeDiscoveryProgress,
} from "@zhixing/mesh/home-discovery";
import { homeTrustEventDigest, type CurrentTrustProjection } from "@zhixing/mesh/trust-chain";
import { readDisasterRecoveryCommit } from "./anchor-installation-index.js";
import type { CurrentIssuerDeviceRemovalAuthority } from "./device-removal.js";
import { readDiscoveryProgress, recordDiscoveryProgress, resumePointOf } from "./discovery-progress.js";
import { loadOrCreateHomeRouteMaterial } from "./home-route-material.js";
import type { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";
import { recordSupersededTrustPending, type SupersededTrustFact } from "./superseded-trust-report.js";

/** 旧分支段分页读取的页大小。 */
const SEGMENT_PAGE = 256;

/**
 * 成员发现后的耐久接续：本机在继任链里须仍是 active 成员且公钥一致（发现本身不授予资格；未完会话只要求
 * 未被撤销）。前缀情形按原签名记录分组导入后缀（每组一次提交，已导入的组跳过，可中断续做）；分叉情形交给
 * 分支接续，未完时只按页暂存并记下已验证进度。分叉发布之前，只读本机（祖先, 链头] 旧分支段：被撤销则拒绝；
 * 本机被拿掉的祖先角色连同分支身份写成待上报项，并经 beforePublish 让本机限制先于新视图生效。
 * 完整时再耐久现任的公开连接资料（传输身份、端点）。
 */
export async function adoptDiscoveredTrust(input: {
  readonly store: FileMeshBootstrapStore;
  readonly verified: VerifiedHomeDiscovery | VerifiedHomeDiscoveryProgress;
  readonly localIdentity: Pick<DeviceIdentity, "deviceId" | "publicKey">;
  /** 待上报项写下之后、分支发布之前：例如重载本机准入限制。 */
  readonly beforePublish?: () => Promise<void>;
}): Promise<void> {
  const { store, verified } = input;
  const self = verified.projection.members.find((member) => member.device.deviceId === input.localIdentity.deviceId);
  if (!self || self.device.publicKey !== input.localIdentity.publicKey ||
      (verified.complete ? self.state !== "active" : self.state === "revoked")) {
    throw new Error("This device is not an active member of the current trust chain");
  }
  if (verified.forked) {
    const ancestor = verified.ancestor!;
    const localHead = await store.localTrustHead();
    if (!localHead) throw new Error("Trust branch adoption requires a local trust chain");
    // 旧分支段只在要发布的完整会话里读一次；未完会话只暂存，不改本机视图
    const superseded = verified.complete
      ? await readSupersededSegment(store, ancestor, localHead, input.localIdentity.deviceId)
      : undefined;
    // 从进度接着的会话看不到分支首条：接续标识取自那份进度
    const resumed = await readDiscoveryProgress(store.authorityLog(), { purpose: "member", homeId: verified.projection.homeId, localHead });
    const adoptionId = await store.adoptTrustBranch({
      ...verified,
      ...(resumed?.adoptionId && canonicalize(resumed.point) === canonicalize(verified.from) ? { adoptionId: resumed.adoptionId } : {}),
      beforePublish: async (id) => {
        if (!superseded) throw new Error("Trust branch publication requires its superseded segment");
        await recordSupersededTrustPending(store.authorityLog(), {
          adoptionId: id, ancestor, superseded: localHead, branch: superseded.branch, self: superseded.self,
        });
        await input.beforePublish?.();
      },
    });
    if (!verified.complete) {
      await recordDiscoveryProgress(store.authorityLog(), {
        purpose: "member",
        homeId: verified.projection.homeId,
        localHead,
        point: verified.projection.chainHead,
        projection: verified.projection,
        ancestor: verified.ancestor!,
        adoptionId,
      });
      return;
    }
  } else {
    let previous = verified.from;
    let group: HomeTrustEvent[] = [];
    for (const page of verified.pages) {
      group.push(...page.events);
      if (!page.record) continue;
      await store.reconcileTrustPage({ homeId: verified.projection.homeId, previous, events: group, record: page.record });
      previous = page.record.chainHead;
      group = [];
    }
    if (group.length > 0) throw new Error("Discovered trust suffix does not end at a signed record");
    // 未完时本机链头已前进到截断点：下一次会话从本机链给出候选即可接着
    if (!verified.complete) return;
  }
  await store.acceptTransportPeer(verified.issuer);
  if (verified.endpoint) await store.acceptEndpoint(verified.endpoint);
}

/**
 * 本机被取代的旧分支段（祖先, 链头]：分页按键读，不读祖先之前。本机在段内被撤销则拒绝（不因换视图复活）；
 * 本机被拿掉的祖先角色记为自身降权事实（旧分支上先加后减的角色不算）。返回旧分支身份（首条摘要）与这些事实。
 */
async function readSupersededSegment(
  store: FileMeshBootstrapStore,
  ancestor: HomeTrustChainPoint,
  localHead: HomeTrustChainPoint,
  deviceId: string,
): Promise<{ readonly branch: string; readonly self: readonly SupersededTrustFact[] }> {
  const atAncestor = (await store.trustProjectionAt(ancestor))?.members.find((member) => member.device.deviceId === deviceId);
  if (!atAncestor) throw new Error("This device was not a member at the common ancestor");
  let roles: readonly DeviceRole[] = atAncestor.roles;
  let branch: string | undefined;
  const self: SupersededTrustFact[] = [];
  for (let after = ancestor.seq; after < localHead.seq;) {
    const page = await store.trustEventsAfter(after, SEGMENT_PAGE);
    if (page.length === 0) throw new Error("Local superseded trust segment is incomplete");
    for (const event of page) {
      branch ??= homeTrustEventDigest(event);
      const body = event.body;
      if (body.t === "revoke" && body.deviceId === deviceId) {
        throw new Error("This device was revoked on its own trust chain and cannot rejoin by discovery");
      }
      if (body.t !== "role-change" || body.deviceId !== deviceId) continue;
      const removedRoles = roles.filter((role) => atAncestor.roles.includes(role) && !body.roles.includes(role));
      if (removedRoles.length > 0) self.push(Object.freeze({ deviceId, event, reportedBy: deviceId, ancestor, removedRoles }));
      roles = body.roles;
    }
    after = page.at(-1)!.seq;
  }
  if (!branch) throw new Error("A forked local chain has no superseded events");
  return { branch, self };
}

/** 成员发现的续做点：本机链头未变时取上次未完会话的已验证进度。 */
export async function memberDiscoveryResume(store: FileMeshBootstrapStore): Promise<HomeDiscoveryResumePoint | undefined> {
  const [current, localHead] = await Promise.all([store.loadCurrentTrust(), store.localTrustHead()]);
  if (!current || !localHead) return undefined;
  const progress = await readDiscoveryProgress(store.authorityLog(), { purpose: "member", homeId: current.homeId, localHead });
  return progress ? resumePointOf(progress) : undefined;
}

export interface HomeDiscoveryService {
  readonly secrets: { readonly member: string; readonly terminal: string };
  readonly ports: HomeDiscoveryServerPorts;
}

/**
 * 家级发现服务：只有本机是现任 issuer 且持有当前 issuer key 时提供，否则返回 undefined。证明端口按键读信任链
 * 与安装索引（灾备转移的根签 commit），签名用当前 issuer key；恢复证据交给移除权威核对或补做。
 */
export async function createHomeDiscoveryService(input: {
  readonly deviceId: string;
  readonly identityKey: DeviceKey;
  readonly issuerKey: DeviceKey | undefined;
  readonly authority: CurrentIssuerDeviceRemovalAuthority | undefined;
  readonly store: FileMeshBootstrapStore;
  readonly secretStore: SecretStorePort;
  readonly trust: () => CurrentTrustProjection;
  readonly localEndpoint?: MeshEndpointDescriptor;
}): Promise<HomeDiscoveryService | undefined> {
  const { issuerKey, authority, store } = input;
  const trust = input.trust();
  if (
    !issuerKey || !authority ||
    trust.issuer.deviceId !== input.deviceId ||
    trust.issuer.issuerKeyId !== issuerKey.deviceId
  ) {
    return undefined;
  }
  const material = await loadOrCreateHomeRouteMaterial(input.secretStore, trust.homeId);
  return {
    secrets: { member: material.discovery, terminal: material.terminal },
    ports: {
      homeId: trust.homeId,
      findBase: (points) => store.findTrustBase(points),
      page: (from) => store.discoveryTrustPage(trust.homeId, from),
      issuer: async () => {
        const current = input.trust();
        const self = current.members.find((member) => member.device.deviceId === input.deviceId);
        if (!self || current.issuer.deviceId !== input.deviceId || current.issuer.issuerKeyId !== issuerKey.deviceId) {
          throw new Error("This device is no longer the current issuer");
        }
        return {
          peer: { identity: self.device, rootCertificatePem: input.identityKey.rootCertificatePem },
          ...(input.localEndpoint ? { endpoint: input.localEndpoint } : {}),
          anchorEpoch: current.anchorEpoch,
          signer: issuerKey,
        };
      },
      recoveryCommit: async (transition) =>
        await readDisasterRecoveryCommit(store.authorityLog(), homeTrustEventDigest(transition)) as
          | DisasterRecoveryCommitProof
          | undefined,
      acceptEvidence: ({ evidence, transcript }) => authority.acceptRecoveryEvidence(evidence, transcript),
    },
  };
}
