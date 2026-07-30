import { Buffer } from "node:buffer";
import {
  FileDurableProjectionIndex,
  type DurableProjectionCheckpoints,
  type DurableProjectionMutation,
} from "../authority/index.js";
import type { JsonValue } from "../contracts/index.js";
import { SerialTaskQueue } from "../persistence/index.js";
import { canonicalize, protocolDigest } from "../protocol/index.js";
import type { StorageMaintenanceGovernorPort } from "../resources/index.js";

const ACTIVITY_KEY_PREFIX = "activity:";
const ACTIVITY_KEY_LIMIT = "activity;";
const ACTIVITY_PAGE_SIZE = 128;

export interface WorksceneSessionActivity {
  readonly conversationId: string;
  readonly lastActiveAt: string;
}

export interface WorksceneActivitySnapshot {
  readonly sceneId: string;
  readonly sessions: readonly WorksceneSessionActivity[];
}

export interface WorksceneActivityProjectionOptions {
  readonly rootDir: string;
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
}

/**
 * Durable read model for workscene recency.
 *
 * Session metadata remains the only activity fact. Each sync treats the
 * canonical, sorted SessionMeta set as a logical verified source prefix; the
 * index may be deleted or rebuilt without losing activity. Projection failure
 * therefore degrades ordering only and never blocks scene lifecycle operations.
 */
export class WorksceneActivityProjection {
  readonly #index: FileDurableProjectionIndex;
  readonly #queue = new SerialTaskQueue();

  constructor(options: WorksceneActivityProjectionOptions) {
    this.#index = new FileDurableProjectionIndex({
      rootDir: options.rootDir,
      projectionId: "workscene-session-activity",
      reducerVersion: 1,
      storageMaintenance: options.storageMaintenance,
    });
  }

  async synchronize(
    snapshots: readonly WorksceneActivitySnapshot[],
  ): Promise<void> {
    const normalized = normalizeSnapshots(snapshots);
    return this.#queue.run(async () => {
      const checkpoints = activityCheckpoints(normalized);
      await this.#index.initialize(checkpoints);

      const desired = new Map<string, JsonValue>();
      for (const snapshot of normalized) {
        const lastActiveAt = latestActivity(snapshot.sessions);
        if (!lastActiveAt) continue;
        desired.set(activityKey(snapshot.sceneId), {
          sceneId: snapshot.sceneId,
          lastActiveAt,
        });
      }

      const mutations: DurableProjectionMutation[] = [...desired].map(
        ([key, value]) => ({ kind: "put", key, value }),
      );
      let continuation: string | undefined;
      do {
        const page = await this.#index.scan(
          { gte: ACTIVITY_KEY_PREFIX, lt: ACTIVITY_KEY_LIMIT },
          ACTIVITY_PAGE_SIZE,
          continuation,
        );
        for (const entry of page.entries) {
          if (!desired.has(entry.key)) {
            mutations.push({ kind: "tombstone", key: entry.key });
          }
        }
        continuation = page.continuation;
      } while (continuation);

      const prepared = await this.#index.prepare(mutations);
      this.#index.publish(prepared, checkpoints);
      await this.#index.flush();
    });
  }

  async get(sceneId: string): Promise<string | undefined> {
    const value = await this.#index.get(activityKey(requireId(sceneId)));
    if (value === undefined) return undefined;
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "lastActiveAt,sceneId" ||
      value.sceneId !== sceneId ||
      typeof value.lastActiveAt !== "string" ||
      new Date(value.lastActiveAt).toISOString() !== value.lastActiveAt
    ) {
      throw new Error("Workscene activity projection value is invalid");
    }
    return value.lastActiveAt;
  }

  stop(): void {
    this.#index.stopStorageMaintenance();
  }
}

function normalizeSnapshots(
  snapshots: readonly WorksceneActivitySnapshot[],
): WorksceneActivitySnapshot[] {
  const seen = new Set<string>();
  return snapshots
    .map((snapshot) => {
      const sceneId = requireId(snapshot.sceneId);
      if (seen.has(sceneId)) {
        throw new TypeError("Workscene activity snapshot contains duplicates");
      }
      seen.add(sceneId);
      return {
        sceneId,
        sessions: snapshot.sessions
          .map((session) => ({
            conversationId: requireId(session.conversationId),
            lastActiveAt: requireTime(session.lastActiveAt),
          }))
          .sort((left, right) =>
            left.conversationId.localeCompare(right.conversationId, "en-US"),
          ),
      };
    })
    .sort((left, right) => left.sceneId.localeCompare(right.sceneId, "en-US"));
}

function activityCheckpoints(
  snapshots: readonly WorksceneActivitySnapshot[],
): DurableProjectionCheckpoints {
  const catalog = snapshots.map(({ sceneId }) => sceneId);
  const checkpoints: Record<
    string,
    DurableProjectionCheckpoints[string]
  > = {
    catalog: {
      logId: "workscene-session-meta-catalog",
      lsn: catalog.length,
      frameEndOffset: Buffer.byteLength(canonicalize(catalog)),
      prefixDigest: protocolDigest("WorksceneSessionMetaCatalog", 1, {
        sceneIds: catalog,
      }),
    },
  };
  for (const snapshot of snapshots) {
    const identity = protocolDigest("WorksceneActivitySource", 1, {
      sceneId: snapshot.sceneId,
    });
    checkpoints[`scene:${identity.slice("sha256:".length)}`] = {
      logId: `workscene-session-meta:${identity}`,
      lsn: snapshot.sessions.length,
      frameEndOffset: Buffer.byteLength(canonicalize(snapshot.sessions)),
      prefixDigest: protocolDigest("WorksceneSessionMetaPrefix", 1, {
        sceneId: snapshot.sceneId,
        sessions: snapshot.sessions,
      }),
    };
  }
  return checkpoints;
}

function latestActivity(
  sessions: readonly WorksceneSessionActivity[],
): string | undefined {
  let latest: string | undefined;
  for (const session of sessions) {
    if (!latest || Date.parse(session.lastActiveAt) > Date.parse(latest)) {
      latest = session.lastActiveAt;
    }
  }
  return latest;
}

function activityKey(sceneId: string): string {
  return `${ACTIVITY_KEY_PREFIX}${protocolDigest("WorksceneActivityKey", 1, {
    sceneId,
  })}`;
}

function requireId(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError("Workscene activity identity is invalid");
  }
  return value;
}

function requireTime(value: string): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError("Workscene activity time is invalid");
  }
  return value;
}
