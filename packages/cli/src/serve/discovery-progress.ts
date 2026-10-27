import type { AuthorityCommitLog, DurableProjectionMutation, DurableProjectionReadContext } from "@zhixing/core/authority";
import type { JsonValue } from "@zhixing/core/contracts";
import { canonicalize, protocolDigest } from "@zhixing/core/protocol";
import type {
  HomeDiscoveryPurpose,
  HomeDiscoveryResumePoint,
  HomeTrustChainPoint,
} from "@zhixing/mesh/home-discovery";
import type { TrustProjection } from "@zhixing/mesh/trust-chain";

/**
 * 家级发现的已验证进度：后缀超出单次会话预算时，本机把逐条验过原签名的前缀到达的点与该点投影耐久下来，
 * 下一次会话以它为第一候选、从该投影接着验。它只是本机已验证过的事实，不授予任何资格；按用途与 home 各一条，
 * 记录时本机信任链头变了即失效（本机链前进或换了分支之后，从本机链重新给出候选）。
 */
export const DISCOVERY_PROGRESS_STREAM = "discovery-progress";
export const DISCOVERY_PROGRESS_PROJECTION_ID = "discovery-progress-v1";

export interface DiscoveryProgress {
  readonly purpose: HomeDiscoveryPurpose;
  readonly homeId: string;
  /** 记录时本机信任链头。 */
  readonly localHead: HomeTrustChainPoint;
  readonly point: HomeTrustChainPoint;
  readonly projection: TrustProjection;
  readonly ancestor?: HomeTrustChainPoint;
  /** 成员按页暂存的分支接续标识：续做会话里看不到分支首条，发布时据此找回暂存。 */
  readonly adoptionId?: string;
}

interface ProgressRecord {
  readonly v: 1;
  readonly t: "discovery-progress";
  readonly progress: DiscoveryProgress;
}

export type DiscoveryProgressLog =Pick<AuthorityCommitLog, "durableProjection" | "transactDurableProjection">;

const progressKey = (purpose: HomeDiscoveryPurpose, homeId: string) =>
  `progress/${purpose}/${protocolDigest("DiscoveryProgressHome", 1, { homeId }).slice("sha256:".length)}`;

export function registerDiscoveryProgressIndex(log: Pick<DiscoveryProgressLog, "durableProjection">): void {
  log.durableProjection({
    projectionId: DISCOVERY_PROGRESS_PROJECTION_ID,
    reducerVersion: 1,
    authenticated: true,
    inputs: { streams: [DISCOVERY_PROGRESS_STREAM] },
    reduce: async (envelope) => {
      const changes: DurableProjectionMutation[] = [];
      for (const entry of envelope.entries) {
        if (entry.stream !== DISCOVERY_PROGRESS_STREAM) continue;
        const record = entry.body as unknown as ProgressRecord;
        if (!record || record.v !== 1 || record.t !== "discovery-progress" || !record.progress ||
            (record.progress.purpose !== "member" && record.progress.purpose !== "terminal") ||
            typeof record.progress.homeId !== "string") {
          throw new TypeError("Discovery progress record is invalid");
        }
        changes.push({
          kind: "put",
          key: progressKey(record.progress.purpose, record.progress.homeId),
          value: record.progress as unknown as JsonValue,
        });
      }
      return changes;
    },
  });
}

export async function recordDiscoveryProgress(log: DiscoveryProgressLog, progress: DiscoveryProgress): Promise<void> {
  registerDiscoveryProgressIndex(log);
  const record: ProgressRecord = { v: 1, t: "discovery-progress", progress };
  await log.transactDurableProjection<JsonValue, void>(DISCOVERY_PROGRESS_PROJECTION_ID, async () => ({
    kind: "append",
    entries: [{ stream: DISCOVERY_PROGRESS_STREAM, body: record as unknown as JsonValue }],
    value: undefined,
  }));
}

/** 仍有效的进度（记录时的本机链头等于当前链头）；没有或已失效返回 undefined。 */
export async function readDiscoveryProgress(
  log: DiscoveryProgressLog,
  input: { readonly purpose: HomeDiscoveryPurpose; readonly homeId: string; readonly localHead: HomeTrustChainPoint },
): Promise<DiscoveryProgress | undefined> {
  registerDiscoveryProgressIndex(log);
  const stored = (await log.transactDurableProjection(DISCOVERY_PROGRESS_PROJECTION_ID, async (view: DurableProjectionReadContext) => ({
    kind: "return" as const,
    value: await view.get(progressKey(input.purpose, input.homeId)),
  }))).value as unknown as DiscoveryProgress | undefined;
  if (!stored || canonicalize(stored.localHead) !== canonicalize(input.localHead)) return undefined;
  return stored;
}

export function resumePointOf(progress: DiscoveryProgress): HomeDiscoveryResumePoint {
  return {
    point: progress.point,
    projection: progress.projection,
    ...(progress.ancestor ? { ancestor: progress.ancestor } : {}),
  };
}
