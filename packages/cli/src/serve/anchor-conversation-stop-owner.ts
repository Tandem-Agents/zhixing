import { isLocalConversationId } from "@zhixing-ai/core/conversation";
import {
  admittedConversationRunLifecycleSource,
  parseAdmittedConversationRunSource,
  type DeliveryLifecycleSourcePermit,
} from "@zhixing-ai/core/delivery";
import { canonicalize, protocolDigest, type StopStrategy } from "@zhixing-ai/core/protocol";
import type { ConversationManager } from "@zhixing-ai/owner-kernel/conversation-manager";
import type { ConversationProtocolRuntime } from "./conversation-protocol-runtime.js";
import {
  HostStopAcceptedWorkPendingError,
  hostStopDeliveryLifecycleSources,
  type HostStopAcceptedWorkItem,
  type HostStopAcceptedWorkPort,
  type HostStopAcceptedWorkSnapshot,
} from "./host-stop-lifecycle.js";

export const CONVERSATION_HOST_STOP_OWNERS = [
  "conversation",
  "intent",
  "final",
  "assignment",
  "lease",
  "permit",
] as const;

export type ConversationHostStopOwner = typeof CONVERSATION_HOST_STOP_OWNERS[number];

export interface ConversationHostStopOwnerItem {
  readonly owner: ConversationHostStopOwner;
  readonly id: string;
  readonly revision: string;
}

const CONVERSATION_OWNER_SET = new Set<string>(CONVERSATION_HOST_STOP_OWNERS);

export interface AnchorConversationStopOwnerDeps {
  readonly manager: ConversationManager;
  readonly protocol: ConversationProtocolRuntime;
  readonly advancementRecovery?: {
    beginDrain(): Promise<void>;
    recoverAllOpenSessions(): Promise<unknown>;
  };
}

export interface LocalConversationStopParticipant {
  closeHostStopAdmission(operationId: string): Promise<void>;
  restoreHostStopAcceptedWork(
    operationId: string,
    ownerItems: readonly ConversationHostStopOwnerItem[],
    alreadySettled?: boolean,
  ): void;
  hostStopAcceptedWorkItems(
    operationId: string,
    owner: ConversationHostStopOwner,
  ): readonly HostStopAcceptedWorkItem[];
  settleHostStopAcceptedWork(
    operationId: string,
    strategy: StopStrategy,
    timeoutMs: number,
  ): Promise<void>;
  assertHostStopAcceptedWorkSettled(
    operationId: string,
    owner: ConversationHostStopOwner,
    strategy: StopStrategy,
    frozen: readonly HostStopAcceptedWorkItem[],
  ): Promise<void>;
  releaseHostStopAdmission(operationId: string): Promise<void>;
  recoverAcceptedWorkForLifecycle(): Promise<void>;
  ownsConversation(conversationId: string): Promise<boolean>;
  ownsDeferredIntent(intentId: string): Promise<boolean>;
  assignmentLifecycleProvenance(
    assignmentId: string,
    candidateConversationIds?: readonly string[],
  ): Promise<Awaited<ReturnType<ConversationProtocolRuntime["assignmentLifecycleProvenance"]>>>;
  ownsReservation(
    reservationId: string,
    candidateConversationIds?: readonly string[],
  ): Promise<boolean>;
}

function assertExactItems(
  expected: readonly HostStopAcceptedWorkItem[],
  actual: readonly HostStopAcceptedWorkItem[],
  label: string,
): void {
  const normalize = (items: readonly HostStopAcceptedWorkItem[]) =>
    [...items]
      .map(({ id, revision }) => ({ id, revision }))
      .sort((left, right) => left.id.localeCompare(right.id, "en-US"));
  if (canonicalize(normalize(expected)) !== canonicalize(normalize(actual))) {
    throw new Error(`${label} does not match the frozen accepted-work exact-set`);
  }
}

function assertSubsetItems(
  current: readonly HostStopAcceptedWorkItem[],
  frozen: readonly HostStopAcceptedWorkItem[],
  label: string,
): void {
  const expected = new Map(frozen.map((item) => [item.id, item.revision]));
  for (const item of current) {
    if (expected.get(item.id) !== item.revision) {
      throw new Error(`${label} observed an unowned or successor accepted-work item`);
    }
  }
}

export function anchorConversationHostStopRevision(
  conversationId: string,
  sessionId = conversationId,
): string {
  return protocolDigest("HostStopConversation", 1, {
    conversationId,
    sessionId,
  });
}

export class AnchorConversationStopOwner {
  readonly #manager: ConversationManager;
  readonly #protocol: ConversationProtocolRuntime;
  readonly #advancementRecovery: AnchorConversationStopOwnerDeps["advancementRecovery"];
  #hostStopOperationId: string | undefined;
  #hostStopSnapshot: readonly ConversationHostStopOwnerItem[] | undefined;
  #legacyIdleConversations: ReadonlySet<string> | undefined;
  #hostStopSettlement: Promise<void> | undefined;
  #hostStopSettledOperationId: string | undefined;

  constructor(deps: AnchorConversationStopOwnerDeps) {
    this.#manager = deps.manager;
    this.#protocol = deps.protocol;
    this.#advancementRecovery = deps.advancementRecovery;
  }

  conversationStopRevision(conversationId: string): string {
    const sessionId =
      this.#manager.getSession(conversationId)?.runtime.sessionId ?? conversationId;
    return anchorConversationHostStopRevision(conversationId, sessionId);
  }

  async openClosedStartup(
    operationId: string,
    options: { readonly alreadySettled: boolean },
  ): Promise<void> {
    if (this.#hostStopOperationId && this.#hostStopOperationId !== operationId) {
      throw new Error("Another host-stop operation owns the anchor conversation gate");
    }
    this.#hostStopOperationId = operationId;
    await this.#advancementRecovery?.beginDrain();
    await this.#manager.closeExternalAdmission(operationId);
    if (options.alreadySettled) {
      this.#protocol.beginShutdownDrain();
      this.#hostStopSettledOperationId = operationId;
    }
  }

  async closeHostStopAdmission(operationId: string): Promise<void> {
    if (this.#hostStopOperationId && this.#hostStopOperationId !== operationId) {
      throw new Error("Another host-stop operation owns the anchor conversation gate");
    }
    this.#hostStopOperationId = operationId;
    await this.#advancementRecovery?.beginDrain();
    await this.#manager.closeExternalAdmission(operationId);
    this.#hostStopSnapshot ??= await this.#protocol.whileRecoveryPaused(() =>
      this.#captureOwnerItems(),
    );
  }

  async restoreHostStopAcceptedWork(
    operationId: string,
    ownerItems: readonly ConversationHostStopOwnerItem[],
    alreadySettled = false,
  ): Promise<void> {
    if (this.#hostStopOperationId !== operationId) {
      throw new Error("Host-stop artifact does not own the anchor conversation gate");
    }
    const frozen = Object.freeze(
      ownerItems
        .filter((item) => CONVERSATION_OWNER_SET.has(item.owner))
        .map((item) => Object.freeze({ ...item }))
        .sort((left, right) =>
          `${left.owner}:${left.id}`.localeCompare(`${right.owner}:${right.id}`, "en-US"),
        ),
    );
    for (const item of frozen) {
      if (item.owner !== "conversation") continue;
      if (!(await this.ownsConversation(item.id))) {
        throw new Error(`Unrecognized or unowned frozen conversation work item for ${item.id}`);
      }
      if (item.revision !== this.conversationStopRevision(item.id)) {
        throw new Error(
          `Frozen anchor conversation ${item.id} revision does not match authoritative HostStopConversation identity`,
        );
      }
    }
    if (this.#hostStopSnapshot) {
      assertExactItems(
        this.#hostStopSnapshot.map((item) => ({
          id: `${item.owner}:${item.id}`,
          revision: item.revision,
        })),
        frozen.map((item) => ({ id: `${item.owner}:${item.id}`, revision: item.revision })),
        "anchor host-stop restored artifact",
      );
    } else {
      const frozenConversationIds = new Set(
        frozen.filter((item) => item.owner === "conversation").map((item) => item.id),
      );
      const legacyIdle = new Set<string>();
      await this.#protocol.whileRecoveryPaused(async () => {
        const durableSessions = await this.#protocol.listSessions();
        for (const conversationId of durableSessions) {
          if (frozenConversationIds.has(conversationId)) continue;
          if (this.#manager.has(conversationId)) {
            throw new Error(
              `Restored anchor host-stop artifact omits active conversation ${conversationId}`,
            );
          }
          const closure = await this.#protocol.pendingClosureWork(conversationId);
          if (
            closure.pendingAdmittedRuns !== 0 ||
            closure.pendingFinals !== 0 ||
            closure.pendingAssignments !== 0 ||
            closure.recoveryBacklog !== 0 ||
            closure.activeLocalLeases !== 0
          ) {
            throw new Error(
              `Restored anchor host-stop artifact omits conversation ${conversationId} with pending accepted work`,
            );
          }
          legacyIdle.add(conversationId);
        }
      });
      this.#legacyIdleConversations = legacyIdle.size > 0 ? legacyIdle : undefined;
      this.#hostStopSnapshot = frozen;
    }
    if (alreadySettled) {
      this.#protocol.beginShutdownDrain();
      this.#hostStopSettledOperationId = operationId;
    }
  }

  hostStopAcceptedWorkItems(
    operationId: string,
    owner: ConversationHostStopOwner,
  ): readonly HostStopAcceptedWorkItem[] {
    const snapshot = this.#requireHostStopSnapshot(operationId);
    return Object.freeze(
      snapshot
        .filter((item) => item.owner === owner)
        .map(({ id, revision }) => Object.freeze({ id, revision })),
    );
  }

  async recoverAcceptedWorkForLifecycle(): Promise<void> {
    await this.#protocol.recoverReadinessProjections();
    await this.#protocol.recover();
    await this.#advancementRecovery?.recoverAllOpenSessions();
  }

  async settleHostStopAcceptedWork(
    operationId: string,
    strategy: StopStrategy,
    timeoutMs: number,
  ): Promise<void> {
    this.#requireHostStopSnapshot(operationId);
    if (this.#hostStopSettledOperationId === operationId) return;
    if (this.#hostStopSettlement) return this.#hostStopSettlement;
    const settlement = (async () => {
      const deadline = Date.now() + timeoutMs;
      if (strategy === "immediate") {
        this.#protocol.beginShutdownDrain();
        await this.#advancementRecovery?.beginDrain();
        await this.#protocol.stopRecoveryLoop();
        while (true) {
          const closure = await this.#protocol.pendingClosureWork();
          if (!this.#manager.hasActiveWork() && closure.activeLocalLeases === 0) {
            this.#hostStopSettledOperationId = operationId;
            return;
          }
          if (Date.now() >= deadline) {
            const pendingOwner = this.#manager.hasActiveWork() ? "conversation" : "lease";
            throw new HostStopAcceptedWorkPendingError(
              pendingOwner,
              "Host stop could not reach the anchor durable safe point before its deadline",
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      if (strategy === "cancel") {
        this.#protocol.beginShutdownDrain();
        await this.#advancementRecovery?.beginDrain();
        await this.#manager.abortAllAndWait(
          { kind: "external", origin: "server-shutdown" },
          Math.max(1, deadline - Date.now()),
        );
      }
      while (true) {
        await this.#protocol.recover();
        await this.#advancementRecovery?.recoverAllOpenSessions();
        const closure = await this.#protocol.pendingClosureWork();
        if (
          !this.#manager.hasActiveWork() &&
          closure.pendingAdmittedRuns === 0 &&
          closure.pendingFinals === 0 &&
          closure.pendingAssignments === 0 &&
          closure.recoveryBacklog === 0 &&
          closure.activeLocalLeases === 0
        ) {
          this.#protocol.beginShutdownDrain();
          await this.#advancementRecovery?.beginDrain();
          await this.#protocol.stopRecoveryLoop();
          this.#hostStopSettledOperationId = operationId;
          return;
        }
        if (Date.now() >= deadline) {
          const pendingOwner: ConversationHostStopOwner = this.#manager.hasActiveWork()
            ? "conversation"
            : closure.pendingFinals !== 0
              ? "final"
              : closure.pendingAssignments !== 0
                ? "assignment"
                : closure.pendingAdmittedRuns !== 0 || closure.recoveryBacklog !== 0
                  ? "intent"
                  : "lease";
          throw new HostStopAcceptedWorkPendingError(
            pendingOwner,
            "Host stop could not settle anchor accepted work before its deadline",
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    })();
    this.#hostStopSettlement = settlement;
    try {
      await settlement;
    } catch (error) {
      if (this.#hostStopSettlement === settlement) this.#hostStopSettlement = undefined;
      throw error;
    }
  }

  async assertHostStopAcceptedWorkSettled(
    operationId: string,
    owner: ConversationHostStopOwner,
    strategy: StopStrategy,
    frozen: readonly HostStopAcceptedWorkItem[],
  ): Promise<void> {
    const expected = this.hostStopAcceptedWorkItems(operationId, owner);
    assertExactItems(expected, frozen, `anchor host-stop ${owner} frozen input`);
    const current = await this.#protocol.whileRecoveryPaused(async () =>
      (await this.#captureOwnerItems())
        .filter((item) => item.owner === owner)
        .map(({ id, revision }) => ({ id, revision })),
    );
    assertSubsetItems(current, frozen, `anchor host-stop ${owner}`);
    if (owner === "conversation") {
      assertExactItems(current, frozen, "anchor host-stop conversation read-back");
      if (this.#manager.hasActiveWork()) {
        throw new HostStopAcceptedWorkPendingError(
          "conversation",
          "Anchor conversation accepted work is still active",
        );
      }
      return;
    }
    if (
      strategy === "immediate" &&
      (owner === "intent" || owner === "final" || owner === "assignment")
    ) {
      return;
    }
    if (current.length !== 0) {
      throw new HostStopAcceptedWorkPendingError(
        owner,
        `Anchor ${owner} accepted work is not settled`,
      );
    }
  }

  async currentOwnerItemsPaused(
    owner: ConversationHostStopOwner,
  ): Promise<readonly HostStopAcceptedWorkItem[]> {
    return this.#protocol.whileRecoveryPaused(async () =>
      (await this.#captureOwnerItems())
        .filter((item) => item.owner === owner)
        .map(({ id, revision }) => Object.freeze({ id, revision })),
    );
  }

  async releaseHostStopAdmission(operationId: string): Promise<void> {
    if (this.#hostStopOperationId === undefined) return;
    if (this.#hostStopOperationId !== operationId) {
      throw new Error("Host-stop release does not own the anchor conversation gate");
    }
    this.#manager.releaseExternalAdmission(operationId);
    this.#protocol.resumeAfterShutdownDrain();
    this.#hostStopOperationId = undefined;
    this.#hostStopSnapshot = undefined;
    this.#legacyIdleConversations = undefined;
    this.#hostStopSettlement = undefined;
    this.#hostStopSettledOperationId = undefined;
  }

  listConversations(): Promise<readonly string[]> {
    return this.#protocol.listSessions();
  }

  ownsConversation(conversationId: string): Promise<boolean> {
    return this.#protocol.sessionExists(conversationId);
  }

  async ownsFinal(
    conversationId: string,
    runId: string,
    revision: string,
  ): Promise<boolean> {
    const commitRevision = Number(revision);
    if (!Number.isSafeInteger(commitRevision) || commitRevision <= 0) return false;
    if (!(await this.ownsConversation(conversationId))) return false;
    const history = await this.#protocol.finalHistory(
      conversationId,
      Math.max(0, commitRevision - 1),
    );
    return history.some(
      ({ frame }) =>
        frame.conversationId === conversationId &&
        frame.runId === runId &&
        frame.commitRevision === commitRevision,
    );
  }

  async assignmentLifecycleProvenance(
    assignmentId: string,
    candidateConversationIds?: readonly string[],
  ): Promise<Awaited<ReturnType<ConversationProtocolRuntime["assignmentLifecycleProvenance"]>>> {
    const checked = new Set<string>();
    const candidates = candidateConversationIds ?? (await this.#protocol.listSessions());
    for (const conversationId of candidates) {
      checked.add(conversationId);
      if (!(await this.ownsConversation(conversationId))) continue;
      const provenance = await this.#protocol.assignmentLifecycleProvenance(
        conversationId,
        assignmentId,
      );
      if (provenance) return provenance;
    }
    if (candidateConversationIds) {
      for (const conversationId of await this.#protocol.listSessions()) {
        if (checked.has(conversationId)) continue;
        if (!(await this.ownsConversation(conversationId))) continue;
        const provenance = await this.#protocol.assignmentLifecycleProvenance(
          conversationId,
          assignmentId,
        );
        if (provenance) return provenance;
      }
    }
    return undefined;
  }

  async ownsReservation(
    reservationId: string,
    candidateConversationIds?: readonly string[],
  ): Promise<boolean> {
    const scopedConversationId = await this.#protocol.reservationConversationScope(reservationId);
    if (scopedConversationId !== undefined) {
      return (
        (await this.ownsConversation(scopedConversationId)) &&
        (await this.#protocol.ownsReservation(scopedConversationId, reservationId))
      );
    }
    const checked = new Set<string>();
    const candidates = candidateConversationIds ?? (await this.#protocol.listSessions());
    for (const conversationId of candidates) {
      checked.add(conversationId);
      if (!(await this.ownsConversation(conversationId))) continue;
      if (await this.#protocol.ownsReservation(conversationId, reservationId)) return true;
    }
    if (candidateConversationIds) {
      for (const conversationId of await this.#protocol.listSessions()) {
        if (checked.has(conversationId)) continue;
        if (!(await this.ownsConversation(conversationId))) continue;
        if (await this.#protocol.ownsReservation(conversationId, reservationId)) return true;
      }
    }
    return false;
  }

  #requireHostStopSnapshot(operationId: string): readonly ConversationHostStopOwnerItem[] {
    if (this.#hostStopOperationId !== operationId || !this.#hostStopSnapshot) {
      throw new Error("Host-stop snapshot is not captured for the anchor conversation owner");
    }
    return this.#hostStopSnapshot;
  }

  async #captureOwnerItems(): Promise<readonly ConversationHostStopOwnerItem[]> {
    const conversations = await this.#protocol.listSessions();
    const ownerItems: ConversationHostStopOwnerItem[] = [];
    for (const conversationId of conversations) {
      const closure = await this.#protocol.pendingClosureWork(conversationId);
      const hasClosureWork =
        closure.items.finals.length > 0 ||
        closure.items.assignments.length > 0 ||
        closure.items.admittedRuns.length > 0 ||
        closure.items.recovery.length > 0 ||
        closure.items.leases.length > 0;
      const skipLegacyIdleConversation =
        this.#legacyIdleConversations?.has(conversationId) === true &&
        !this.#manager.has(conversationId) &&
        !hasClosureWork;
      if (!skipLegacyIdleConversation) {
        ownerItems.push(
          Object.freeze({
            owner: "conversation",
            id: conversationId,
            revision: this.conversationStopRevision(conversationId),
          }),
        );
      }
      for (const item of closure.items.finals) {
        ownerItems.push(Object.freeze({ owner: "final", ...item }));
      }
      for (const item of closure.items.assignments) {
        ownerItems.push(Object.freeze({ owner: "assignment", ...item }));
      }
      for (const item of closure.items.admittedRuns) {
        ownerItems.push(Object.freeze({ owner: "intent", ...item }));
      }
      for (const item of closure.items.recovery) {
        ownerItems.push(Object.freeze({ owner: "intent", ...item }));
      }
      for (const item of closure.items.leases) {
        ownerItems.push(Object.freeze({ owner: "lease", ...item }));
        ownerItems.push(Object.freeze({ owner: "permit", ...item }));
      }
    }
    return Object.freeze(
      ownerItems.sort((left, right) =>
        `${left.owner}:${left.id}`.localeCompare(`${right.owner}:${right.id}`, "en-US"),
      ),
    );
  }
}

export function createAnchorConversationStopOwner(input: {
  readonly manager?: ConversationManager;
  readonly protocol?: ConversationProtocolRuntime;
  readonly advancementRecovery?: AnchorConversationStopOwnerDeps["advancementRecovery"];
}): AnchorConversationStopOwner | undefined {
  if (!input.manager || !input.protocol) return undefined;
  return new AnchorConversationStopOwner({
    manager: input.manager,
    protocol: input.protocol,
    advancementRecovery: input.advancementRecovery,
  });
}

export interface ConversationHostStopParticipants {
  readonly anchor?: AnchorConversationStopOwner;
  readonly local?: LocalConversationStopParticipant;
}

async function resolveConversationDomain(
  conversationId: string,
  participants: ConversationHostStopParticipants,
): Promise<"anchor" | "local"> {
  const [ownedByAnchor, ownedByLocal] = await Promise.all([
    participants.anchor ? participants.anchor.ownsConversation(conversationId) : false,
    participants.local ? participants.local.ownsConversation(conversationId) : false,
  ]);
  if (ownedByAnchor && ownedByLocal) {
    throw new Error(`Conflicting conversation stop ownership for ${conversationId}`);
  }
  if (!ownedByAnchor && !ownedByLocal) {
    throw new Error(`Unrecognized or unowned frozen conversation work item for ${conversationId}`);
  }
  return ownedByAnchor ? "anchor" : "local";
}

async function classifyConversationOwnerItem(
  owner: ConversationHostStopOwner,
  item: HostStopAcceptedWorkItem,
  participants: ConversationHostStopParticipants,
  candidateConversationIds?: readonly string[],
): Promise<"anchor" | "local"> {
  if (owner === "conversation") {
    const domain = await resolveConversationDomain(item.id, participants);
    if (domain === "anchor") {
      if (!participants.anchor) {
        throw new Error(`Anchor participant is required for frozen conversation item ${item.id}`);
      }
      if (item.revision !== participants.anchor.conversationStopRevision(item.id)) {
        throw new Error(
          `Frozen anchor conversation ${item.id} revision does not match authoritative HostStopConversation identity`,
        );
      }
    }
    return domain;
  }
  if (owner === "intent") {
    const admitted = parseAdmittedConversationRunSource(item.id);
    if (admitted) {
      return resolveConversationDomain(admitted.conversationId, participants);
    }
    if (
      item.id.startsWith("queued:") ||
      item.id.startsWith("claimed:") ||
      item.id.startsWith("worker:")
    ) {
      const target = item.id.slice(item.id.indexOf(":") + 1);
      if (target.length === 0 || target === "all") {
        throw new Error(`Ambiguous non-partitionable recovery backlog item ${item.id}`);
      }
      return resolveConversationDomain(target, participants);
    }
    const ownedByLocal = participants.local
      ? await participants.local.ownsDeferredIntent(item.id)
      : false;
    if (ownedByLocal) return "local";
    throw new Error(`Unrecognized or unowned frozen intent item ${item.id}`);
  }
  if (owner === "final") {
    const firstColon = item.id.indexOf(":");
    if (firstColon <= 0 || firstColon === item.id.length - 1) {
      throw new Error(`Malformed frozen final item ${item.id}`);
    }
    const prefix = item.id.slice(0, firstColon);
    if (isLocalConversationId(prefix)) {
      return resolveConversationDomain(prefix, participants);
    }
    if (!participants.anchor) {
      throw new Error(`Unowned frozen final item ${item.id}: anchor participant is absent`);
    }
    const anchorSessions = candidateConversationIds
      ? candidateConversationIds.filter((id) => !isLocalConversationId(id))
      : await participants.anchor.listConversations();
    const candidates = anchorSessions.filter(
      (convId) => item.id.startsWith(`${convId}:`) && item.id.length > convId.length + 1,
    );
    if (candidates.length === 1) {
      const convId = candidates[0]!;
      const runId = item.id.slice(convId.length + 1);
      if (await participants.anchor.ownsFinal(convId, runId, item.revision)) {
        return "anchor";
      }
    } else if (candidates.length > 1) {
      const verified: string[] = [];
      for (const convId of candidates) {
        const runId = item.id.slice(convId.length + 1);
        if (await participants.anchor.ownsFinal(convId, runId, item.revision)) {
          verified.push(convId);
        }
      }
      if (verified.length === 1) return "anchor";
    }
    // Fallback across full Anchor session list in case candidateConversationIds omitted an Anchor session
    if (candidateConversationIds) {
      const allAnchor = await participants.anchor.listConversations();
      const matched: string[] = [];
      for (const convId of allAnchor) {
        if (!item.id.startsWith(`${convId}:`) || item.id.length <= convId.length + 1) continue;
        const runId = item.id.slice(convId.length + 1);
        if (await participants.anchor.ownsFinal(convId, runId, item.revision)) {
          matched.push(convId);
        }
      }
      if (matched.length === 1) return "anchor";
    }
    throw new Error(`Unrecognized or unowned frozen final item ${item.id}`);
  }
  if (owner === "assignment") {
    if (!item.id.startsWith("local:") && !item.id.startsWith("relay:")) {
      throw new Error(`Malformed frozen assignment item ${item.id}`);
    }
    const assignmentId = item.id.slice(item.id.indexOf(":") + 1);
    if (assignmentId.length === 0) {
      throw new Error(`Malformed frozen assignment item ${item.id}`);
    }
    const [anchorProv, localProv] = await Promise.all([
      participants.anchor
        ? participants.anchor.assignmentLifecycleProvenance(
            assignmentId,
            candidateConversationIds,
          )
        : undefined,
      participants.local
        ? participants.local.assignmentLifecycleProvenance(
            assignmentId,
            candidateConversationIds,
          )
        : undefined,
    ]);
    const anchorMatches =
      anchorProv !== undefined &&
      anchorProv.assignmentItemId === item.id &&
      anchorProv.dispatchDigest === item.revision;
    const localMatches =
      localProv !== undefined &&
      localProv.assignmentItemId === item.id &&
      localProv.dispatchDigest === item.revision;
    if (anchorMatches && localMatches) {
      throw new Error(`Conflicting assignment stop ownership for ${item.id}`);
    }
    if (!anchorMatches && !localMatches) {
      throw new Error(`Unrecognized or unowned frozen assignment item ${item.id}`);
    }
    return anchorMatches ? "anchor" : "local";
  }
  // lease / permit
  const [ownedByAnchor, ownedByLocal] = await Promise.all([
    participants.anchor
      ? participants.anchor.ownsReservation(item.id, candidateConversationIds)
      : false,
    participants.local
      ? participants.local.ownsReservation(item.id, candidateConversationIds)
      : false,
  ]);
  if (ownedByAnchor && ownedByLocal) {
    throw new Error(`Conflicting ${owner} stop ownership for ${item.id}`);
  }
  if (!ownedByAnchor && !ownedByLocal) {
    throw new Error(`Unrecognized or unowned frozen ${owner} item ${item.id}`);
  }
  return ownedByAnchor ? "anchor" : "local";
}

export async function partitionConversationOwnerSlice(
  owner: ConversationHostStopOwner,
  items: readonly HostStopAcceptedWorkItem[],
  participants: ConversationHostStopParticipants,
  candidateConversationIds?: readonly string[],
): Promise<{
  readonly anchorItems: readonly HostStopAcceptedWorkItem[];
  readonly localItems: readonly HostStopAcceptedWorkItem[];
}> {
  const anchorItems: HostStopAcceptedWorkItem[] = [];
  const localItems: HostStopAcceptedWorkItem[] = [];
  for (const item of items) {
    const domain = await classifyConversationOwnerItem(
      owner,
      item,
      participants,
      candidateConversationIds,
    );
    if (domain === "anchor") {
      if (!participants.anchor) {
        throw new Error(`Anchor participant is required for frozen ${owner} item ${item.id}`);
      }
      anchorItems.push(Object.freeze({ id: item.id, revision: item.revision }));
    } else {
      if (!participants.local) {
        throw new Error(`Local participant is required for frozen ${owner} item ${item.id}`);
      }
      localItems.push(Object.freeze({ id: item.id, revision: item.revision }));
    }
  }
  const sortItems = (list: HostStopAcceptedWorkItem[]) =>
    Object.freeze(list.sort((left, right) => left.id.localeCompare(right.id, "en-US")));
  return Object.freeze({
    anchorItems: sortItems(anchorItems),
    localItems: sortItems(localItems),
  });
}

export async function restoreConversationHostStopSnapshot(
  snapshot: HostStopAcceptedWorkSnapshot,
  participants: ConversationHostStopParticipants,
  alreadySettled = false,
): Promise<void> {
  const candidateConversationIds = snapshot.owners.conversation.map((item) => item.id);
  const anchorOwnerItems: ConversationHostStopOwnerItem[] = [];
  const localOwnerItems: ConversationHostStopOwnerItem[] = [];
  for (const owner of CONVERSATION_HOST_STOP_OWNERS) {
    const { anchorItems, localItems } = await partitionConversationOwnerSlice(
      owner,
      snapshot.owners[owner],
      participants,
      candidateConversationIds,
    );
    for (const item of anchorItems) {
      anchorOwnerItems.push(Object.freeze({ owner, ...item }));
    }
    for (const item of localItems) {
      localOwnerItems.push(Object.freeze({ owner, ...item }));
    }
  }
  await participants.anchor?.restoreHostStopAcceptedWork(
    snapshot.operationId,
    anchorOwnerItems,
    alreadySettled,
  );
  participants.local?.restoreHostStopAcceptedWork(
    snapshot.operationId,
    localOwnerItems,
    alreadySettled,
  );
}

export async function resolveHostStopDeliveryLifecycleSources(
  snapshot: HostStopAcceptedWorkSnapshot,
  participants: ConversationHostStopParticipants,
): Promise<readonly DeliveryLifecycleSourcePermit[]> {
  const base = hostStopDeliveryLifecycleSources(snapshot);
  const merged = new Map<string, DeliveryLifecycleSourcePermit>();
  for (const source of base) {
    merged.set(`${source.owner}\u0000${source.id}`, source);
  }
  if (snapshot.owners.assignment.length > 0) {
    const candidateConversationIds = snapshot.owners.conversation.map((item) => item.id);
    for (const item of snapshot.owners.assignment) {
      if (!item.id.startsWith("local:") && !item.id.startsWith("relay:")) {
        throw new Error(`Malformed frozen assignment item ${item.id}`);
      }
      const assignmentId = item.id.slice(item.id.indexOf(":") + 1);
      const [anchorProv, localProv] = await Promise.all([
        participants.anchor
          ? participants.anchor.assignmentLifecycleProvenance(
              assignmentId,
              candidateConversationIds,
            )
          : undefined,
        participants.local
          ? participants.local.assignmentLifecycleProvenance(
              assignmentId,
              candidateConversationIds,
            )
          : undefined,
      ]);
      const anchorMatches =
        anchorProv !== undefined &&
        anchorProv.assignmentItemId === item.id &&
        anchorProv.dispatchDigest === item.revision;
      const localMatches =
        localProv !== undefined &&
        localProv.assignmentItemId === item.id &&
        localProv.dispatchDigest === item.revision;
      if (anchorMatches && localMatches) {
        throw new Error(`Conflicting assignment stop ownership for ${item.id}`);
      }
      const matched = anchorMatches ? anchorProv : localMatches ? localProv : undefined;
      if (!matched) {
        throw new Error(`Unrecognized or unowned frozen assignment item ${item.id}`);
      }
      const derived = admittedConversationRunLifecycleSource({
        conversationId: matched.conversationId,
        runId: matched.runId,
        queuedPosition: matched.queuedPosition,
      });
      const key = `${derived.owner}\u0000${derived.id}`;
      const previous = merged.get(key);
      if (previous && previous.revision !== derived.revision) {
        throw new Error("Lifecycle accepted-work contains conflicting delivery source revisions");
      }
      merged.set(key, derived);
    }
  }
  return Object.freeze(
    [...merged.values()].sort((left, right) =>
      `${left.owner}:${left.id}`.localeCompare(`${right.owner}:${right.id}`, "en-US"),
    ),
  );
}

export function composeConversationHostStopPorts(
  participants: ConversationHostStopParticipants,
): Readonly<Record<ConversationHostStopOwner, HostStopAcceptedWorkPort>> {
  const makePort = (owner: ConversationHostStopOwner): HostStopAcceptedWorkPort => ({
    freeze: async (operationId) => {
      const anchorItems = participants.anchor
        ? participants.anchor.hostStopAcceptedWorkItems(operationId, owner)
        : [];
      const localItems = participants.local
        ? participants.local.hostStopAcceptedWorkItems(operationId, owner)
        : [];
      const byId = new Map<string, HostStopAcceptedWorkItem>();
      for (const item of anchorItems) {
        byId.set(item.id, Object.freeze({ id: item.id, revision: item.revision }));
      }
      for (const item of localItems) {
        if (byId.has(item.id)) {
          throw new Error(`Conflicting ${owner} accepted-work identity across domains: ${item.id}`);
        }
        byId.set(item.id, Object.freeze({ id: item.id, revision: item.revision }));
      }
      return Object.freeze(
        [...byId.values()].sort((left, right) => left.id.localeCompare(right.id, "en-US")),
      );
    },
    settle: async ({ operationId, strategy, timeoutMs, frozen }) => {
      const deadline = Date.now() + timeoutMs;
      const { anchorItems, localItems } = await partitionConversationOwnerSlice(
        owner,
        frozen,
        participants,
      );
      if (participants.anchor) {
        const expected = participants.anchor.hostStopAcceptedWorkItems(operationId, owner);
        assertExactItems(expected, anchorItems, `anchor host-stop ${owner} settlement`);
        const current = await participants.anchor.currentOwnerItemsPaused(owner);
        assertSubsetItems(current, anchorItems, `anchor host-stop ${owner} settlement`);
        await participants.anchor.settleHostStopAcceptedWork(
          operationId,
          strategy,
          Math.max(0, deadline - Date.now()),
        );
      } else if (anchorItems.length > 0) {
        throw new Error(`Cannot settle anchor ${owner} accepted work without anchor participant`);
      }
      if (participants.local) {
        const expected = participants.local.hostStopAcceptedWorkItems(operationId, owner);
        assertExactItems(expected, localItems, `local host-stop ${owner} settlement`);
        await participants.local.settleHostStopAcceptedWork(
          operationId,
          strategy,
          Math.max(0, deadline - Date.now()),
        );
      } else if (localItems.length > 0) {
        throw new Error(`Cannot settle local ${owner} accepted work without local participant`);
      }
    },
    readBack: async ({ operationId, strategy, frozen }) => {
      const { anchorItems, localItems } = await partitionConversationOwnerSlice(
        owner,
        frozen,
        participants,
      );
      if (participants.anchor) {
        await participants.anchor.assertHostStopAcceptedWorkSettled(
          operationId,
          owner,
          strategy,
          anchorItems,
        );
      } else if (anchorItems.length > 0) {
        throw new Error(`Cannot verify anchor ${owner} accepted work without anchor participant`);
      }
      if (participants.local) {
        await participants.local.assertHostStopAcceptedWorkSettled(
          operationId,
          owner,
          strategy,
          localItems,
        );
      } else if (localItems.length > 0) {
        throw new Error(`Cannot verify local ${owner} accepted work without local participant`);
      }
    },
  });

  return Object.freeze({
    conversation: makePort("conversation"),
    intent: makePort("intent"),
    final: makePort("final"),
    assignment: makePort("assignment"),
    lease: makePort("lease"),
    permit: makePort("permit"),
  });
}
