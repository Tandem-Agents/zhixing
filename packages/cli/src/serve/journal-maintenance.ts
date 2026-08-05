import {
  MemoryMutationConflictError,
  planJournalLifecycle,
  type JournalAuthorityLifecyclePlan,
  type JournalLifecycleEntry,
  type MemoryLogicalEntry,
} from "@zhixing/core";
import { protocolDigest } from "@zhixing/core/protocol";
import type {
  GlobalControlCallContext,
  GlobalReadCallContext,
  GlobalStatePort,
} from "@zhixing/core/contracts";
import { randomUUID } from "node:crypto";

export interface JournalMaintenanceResult {
  condensed: number;
  expired: number;
}

export interface JournalMaintenance {
  scan(): Promise<JournalAuthorityLifecyclePlan>;
  run(
    callText: (prompt: string, role?: "main" | "light") => Promise<string>,
  ): Promise<JournalMaintenanceResult>;
}

export function createAnchorJournalMaintenance(deps: {
  state: () => GlobalStatePort | undefined;
  anchorEpoch: () => number | undefined;
  clock?: () => Date;
}): JournalMaintenance {
  let running: Promise<JournalMaintenanceResult> | undefined;

  const authority = (): { state: GlobalStatePort; anchorEpoch: number } => {
    const state = deps.state();
    const anchorEpoch = deps.anchorEpoch();
    if (!state || !Number.isSafeInteger(anchorEpoch) || anchorEpoch! <= 0) {
      throw new Error("Anchor journal authority is not ready");
    }
    return { state, anchorEpoch: anchorEpoch! };
  };

  const readEntries = async (): Promise<JournalLifecycleEntry[]> => {
    const owner = authority();
    const result = await owner.state.read(
      { kind: "memory-list", scope: { kind: "personal" }, domain: "journal" },
      readContext(owner.anchorEpoch),
    );
    if (result.kind !== "memory-list") {
      throw new TypeError("Journal authority returned another result type");
    }
    return result.entries.map(toLifecycleEntry);
  };

  const scan = async (): Promise<JournalAuthorityLifecyclePlan> =>
    planJournalLifecycle(await readEntries(), { now: deps.clock?.() });

  const execute = async (
    callText: (prompt: string, role?: "main" | "light") => Promise<string>,
  ): Promise<JournalMaintenanceResult> => {
    const owner = authority();
    const plan = await scan();
    let expired = 0;
    let condensed = 0;

    // Condense first: an expired monthly target may be replaced by warm daily
    // sources in the same month. Its later digest-bound expiry then conflicts
    // harmlessly instead of deleting the fresh summary.
    for (const month of plan.condense) {
      const combined = month.sources
        .map((source) => source.content)
        .filter(Boolean)
        .join("\n\n---\n\n");
      if (!combined) continue;
      const summary = await callText(
        `请将以下日志内容凝练为简洁的月度摘要，保留关键事实和决策，去掉冗余细节。\n\n${combined}`,
        "light",
      );
      const mutation = {
        kind: "memory-journal-condense" as const,
        scope: { kind: "personal" as const },
        month: month.month,
        ...(month.target ? { targetExpectedDigest: month.target.digest } : {}),
        sources: month.sources.map((source) => ({
          id: source.id,
          expectedDigest: source.digest,
        })),
        summary,
      };
      try {
        await owner.state.mutate(
          mutation,
          controlContext(owner.anchorEpoch, stableRequestId("condense", mutation)),
        );
        condensed++;
      } catch (error) {
        if (!(error instanceof MemoryMutationConflictError)) throw error;
      }
    }
    for (const entry of plan.expired) {
      const mutation = {
        kind: "memory-delete" as const,
        scope: { kind: "personal" as const },
        domain: "journal" as const,
        id: entry.id,
        expectedDigest: entry.digest,
      };
      try {
        await owner.state.mutate(
          mutation,
          controlContext(owner.anchorEpoch, stableRequestId("expire", mutation)),
        );
        expired++;
      } catch (error) {
        if (!(error instanceof MemoryMutationConflictError)) throw error;
      }
    }
    return { condensed, expired };
  };

  return {
    scan,
    run(callText) {
      running ??= execute(callText).finally(() => {
        running = undefined;
      });
      return running;
    },
  };
}

function toLifecycleEntry(entry: MemoryLogicalEntry): JournalLifecycleEntry {
  if (entry.domain !== "journal" || entry.scope.kind !== "personal") {
    throw new TypeError("Journal lifecycle received a non-personal journal entry");
  }
  return {
    id: entry.id,
    meta: structuredClone(entry.meta),
    content: entry.content,
    digest: entry.digest,
  };
}

function readContext(anchorEpoch: number): GlobalReadCallContext {
  return {
    principal: { kind: "host", component: "memory-journal-maintenance" },
    requestId: `journal-read:${randomUUID()}`,
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    authority: { domain: "global", anchorEpoch },
  };
}

function controlContext(
  anchorEpoch: number,
  requestId: string,
): GlobalControlCallContext {
  return {
    principal: { kind: "host", component: "memory-journal-maintenance" },
    requestId,
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    authority: { domain: "global", anchorEpoch },
  };
}

function stableRequestId(prefix: string, mutation: object): string {
  return `journal-${prefix}:${protocolDigest("JournalMaintenanceRequest", 1, mutation).slice("sha256:".length)}`;
}
