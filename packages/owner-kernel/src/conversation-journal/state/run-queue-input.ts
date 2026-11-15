import { Buffer } from "node:buffer";
import { userMessageFromTurnInput, type Message } from "@zhixing-ai/core";
import type { ArtifactStore } from "@zhixing-ai/core/authority";
import type {
  ArtifactRef,
  ConversationRunState,
  IngressContext,
  UserTurnInput,
} from "@zhixing-ai/core/contracts";
import {
  byteDigest,
  canonicalize,
  protocolDigest,
  validateNonEmptyUserTurnInput,
} from "@zhixing-ai/core/protocol";
import {
  assertAdmissionReplayContract,
  corruptRunJournal,
  type ConversationRunJournalRecord,
} from "../../conversation-run-contracts.js";
import type { AdmittedProjection, ConversationFactGroup } from "../contracts.js";

export interface QueuedRunIndex {
  readonly queuedRunByPosition: Map<number, string>;
  readonly queuedPositionHeap: number[];
  readonly queuedPositionHeapIndex: Map<number, number>;
}

export interface AppendedInputEntry {
  readonly record: Omit<
    Extract<ConversationRunJournalRecord, { t: "run-input-appended" }>,
    "input"
  >;
  readonly input?: UserTurnInput;
  readonly lsn: number;
}

export interface RunQueueInputMutableSlice extends QueuedRunIndex {
  readonly admittedByRun: Map<string, AdmittedProjection>;
  readonly appendedInputs: Map<string, AppendedInputEntry>;
  readonly appendedInputKeysByRun: Map<string, Set<string>>;
  readonly openInputAssignments: Map<string, string>;
  readonly closedInputAssignments: Set<string>;
  readonly inputConsumptions: Map<
    string,
    Extract<ConversationRunJournalRecord, { t: "run-input-consumed" }>
  >;
  readonly runByIngress: Map<string, string>;
}

export interface GuardAdmittedEntry {
  readonly ingressKey: string;
  readonly queuedPosition: number;
  readonly ingress: IngressContext;
}

export interface GuardQueueInputMutableSlice extends QueuedRunIndex {
  readonly admittedByRun: Map<string, GuardAdmittedEntry>;
  readonly runByIngress: Map<string, string>;
}

export interface QueuedRunEntry {
  readonly queuedPosition: number;
  readonly runId: string;
}

function swapQueuedHeap(
  heap: number[],
  indexes: Map<number, number>,
  left: number,
  right: number,
): void {
  const leftValue = heap[left]!;
  const rightValue = heap[right]!;
  heap[left] = rightValue;
  heap[right] = leftValue;
  indexes.set(leftValue, right);
  indexes.set(rightValue, left);
}

function addQueuedRun(state: QueuedRunIndex, position: number, runId: string): void {
  const existing = state.queuedRunByPosition.get(position);
  if (existing !== undefined || state.queuedPositionHeapIndex.has(position)) {
    throw corruptRunJournal("Queued position belongs to more than one run");
  }
  state.queuedRunByPosition.set(position, runId);
  const heap = state.queuedPositionHeap;
  const indexes = state.queuedPositionHeapIndex;
  let index = heap.length;
  heap.push(position);
  indexes.set(position, index);
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (heap[parent]! <= heap[index]!) break;
    swapQueuedHeap(heap, indexes, parent, index);
    index = parent;
  }
}

function removeQueuedRun(state: QueuedRunIndex, position: number, runId: string): void {
  if (state.queuedRunByPosition.get(position) !== runId) {
    throw corruptRunJournal("Queued run index does not match the durable state");
  }
  const index = state.queuedPositionHeapIndex.get(position);
  if (index === undefined) {
    throw corruptRunJournal("Queued run heap is missing its durable position");
  }
  state.queuedRunByPosition.delete(position);
  const heap = state.queuedPositionHeap;
  const indexes = state.queuedPositionHeapIndex;
  const last = heap.length - 1;
  if (index !== last) swapQueuedHeap(heap, indexes, index, last);
  heap.pop();
  indexes.delete(position);
  if (index >= heap.length) return;
  let cursor = index;
  const parent = Math.floor((cursor - 1) / 2);
  if (cursor > 0 && heap[cursor]! < heap[parent]!) {
    while (cursor > 0) {
      const nextParent = Math.floor((cursor - 1) / 2);
      if (heap[nextParent]! <= heap[cursor]!) break;
      swapQueuedHeap(heap, indexes, nextParent, cursor);
      cursor = nextParent;
    }
    return;
  }
  while (true) {
    const left = cursor * 2 + 1;
    const right = left + 1;
    let smallest = cursor;
    if (left < heap.length && heap[left]! < heap[smallest]!) smallest = left;
    if (right < heap.length && heap[right]! < heap[smallest]!) smallest = right;
    if (smallest === cursor) return;
    swapQueuedHeap(heap, indexes, cursor, smallest);
    cursor = smallest;
  }
}

export function applyQueueMembershipDelta(
  state: QueuedRunIndex,
  position: number,
  runId: string,
  previousState: ConversationRunState | undefined,
  nextState: ConversationRunState,
): void {
  if (previousState === "queued") {
    removeQueuedRun(state, position, runId);
  }
  if (nextState === "queued") {
    addQueuedRun(state, position, runId);
  }
}

export function hasQueuedPositionUsed(
  state: Pick<QueuedRunIndex, "queuedRunByPosition">,
  position: number,
): boolean {
  return state.queuedRunByPosition.has(position);
}

export function isEarliestQueuedPosition(
  state: Pick<QueuedRunIndex, "queuedPositionHeap">,
  position: number,
): boolean {
  return state.queuedPositionHeap[0] === position;
}

export function peekEarliestQueuedEntry(
  state: Pick<QueuedRunIndex, "queuedPositionHeap" | "queuedRunByPosition">,
): QueuedRunEntry | undefined {
  const position = state.queuedPositionHeap[0];
  if (position === undefined) return undefined;
  const runId = state.queuedRunByPosition.get(position);
  if (runId === undefined) {
    throw corruptRunJournal("Queued run index does not match the durable state");
  }
  return { queuedPosition: position, runId };
}

export function listOrderedQueuedEntries(
  state: Pick<QueuedRunIndex, "queuedPositionHeap" | "queuedRunByPosition">,
): readonly QueuedRunEntry[] {
  return [...state.queuedPositionHeap]
    .sort((left, right) => left - right)
    .map((position) => {
      const runId = state.queuedRunByPosition.get(position);
      if (runId === undefined) {
        throw corruptRunJournal("Queued run index does not match the durable state");
      }
      return { queuedPosition: position, runId };
    });
}

export function listQueuedEntriesSnapshot(
  state: Pick<QueuedRunIndex, "queuedPositionHeap" | "queuedRunByPosition">,
): readonly QueuedRunEntry[] {
  return state.queuedPositionHeap.map((position) => {
    const runId = state.queuedRunByPosition.get(position);
    if (runId === undefined) {
      throw corruptRunJournal("Queued cancellation projection is inconsistent");
    }
    return { queuedPosition: position, runId };
  });
}

export function requireRetainedRunInput(entry: {
  readonly input?: unknown;
}): UserTurnInput {
  if (!entry.input) throw corruptRunJournal("Active run input payload is unavailable");
  return entry.input as UserTurnInput;
}

export function admittedInputDigest(entry: {
  readonly input?: unknown;
  readonly inputDigest?: string;
}): string {
  return (
    entry.inputDigest ??
    protocolDigest("ConversationAdmittedInput", 1, requireRetainedRunInput(entry))
  );
}

export function admittedInputMatches(
  entry: {
    readonly input?: unknown;
    readonly inputDigest?: string;
    readonly inputRef?: Readonly<ArtifactRef>;
  },
  input: UserTurnInput,
): boolean {
  if (entry.inputRef && !entry.inputDigest) {
    const bytes = Buffer.from(canonicalize(input), "utf8");
    return (
      bytes.byteLength === entry.inputRef.bytes &&
      byteDigest(bytes) === entry.inputRef.digest
    );
  }
  return (
    admittedInputDigest(entry) ===
    protocolDigest("ConversationAdmittedInput", 1, input)
  );
}

export function compactAdmittedRecordMetadata(
  state: Pick<RunQueueInputMutableSlice, "admittedByRun">,
  runId: string,
): void {
  const admitted = state.admittedByRun.get(runId);
  if (!admitted) return;
  const { input: _input, ...metadata } =
    admitted.record as Extract<ConversationRunJournalRecord, { t: "admitted" }>;
  state.admittedByRun.set(runId, { ...admitted, record: metadata });
}

export function compactAppendedInputRecordMetadata(
  state: Pick<
    RunQueueInputMutableSlice,
    "appendedInputs" | "appendedInputKeysByRun"
  >,
  runId: string,
  ingressKey: string,
): void {
  const appended = state.appendedInputs.get(ingressKey);
  if (!appended) return;
  const { input: _input, ...metadata } =
    appended.record as Extract<
      ConversationRunJournalRecord,
      { t: "run-input-appended" }
    >;
  state.appendedInputs.set(ingressKey, { ...appended, record: metadata });
  const keys = state.appendedInputKeysByRun.get(runId) ?? new Set<string>();
  keys.add(ingressKey);
  state.appendedInputKeysByRun.set(runId, keys);
}

export function compactTerminalRunInput(
  state: Pick<
    RunQueueInputMutableSlice,
    "admittedByRun" | "appendedInputs" | "appendedInputKeysByRun"
  >,
  runId: string,
  terminalState: ConversationRunState | undefined,
): void {
  if (
    terminalState !== "committed" &&
    terminalState !== "cancelled" &&
    terminalState !== "failed" &&
    terminalState !== "expired"
  ) {
    return;
  }
  const admitted = state.admittedByRun.get(runId);
  if (admitted?.input) {
    const digest = admittedInputDigest(admitted);
    const { input: _input, ...retained } = admitted;
    state.admittedByRun.set(runId, { ...retained, inputDigest: digest });
  }
  for (const key of state.appendedInputKeysByRun.get(runId) ?? []) {
    const appended = state.appendedInputs.get(key);
    if (appended?.input) {
      const { input: _input, ...retained } = appended;
      state.appendedInputs.set(key, retained);
    }
  }
  state.appendedInputKeysByRun.delete(runId);
}

export function expectedRunInputMessages(
  state: Pick<
    RunQueueInputMutableSlice,
    "admittedByRun" | "inputConsumptions" | "appendedInputs"
  >,
  runId: string,
  assignmentId: string,
): Message[] {
  const initial = state.admittedByRun.get(runId)!;
  const initialIdentity = initial.record.ingress.turnOrigin?.messageIdentity;
  const consumed = [...state.inputConsumptions.values()]
    .filter((entry) => entry.assignmentId === assignmentId)
    .sort((a, b) => a.boundary - b.boundary)
    .flatMap((entry) =>
      entry.ingressKeys.map((key) => state.appendedInputs.get(key)!),
    );
  return [
    ...(initialIdentity
      ? [
          {
            ...userMessageFromTurnInput(requireRetainedRunInput(initial)),
            inputIdentity: initialIdentity,
          },
        ]
      : []),
    ...consumed.map((entry) => ({
      ...userMessageFromTurnInput(requireRetainedRunInput(entry)),
      inputIdentity: entry.record.ingress.turnOrigin!.messageIdentity!,
    })),
  ];
}

export function assertRunInputCommit(
  state: Pick<
    RunQueueInputMutableSlice,
    "openInputAssignments" | "admittedByRun" | "inputConsumptions" | "appendedInputs"
  >,
  runId: string,
  assignmentId: string,
  messages: readonly Message[],
): void {
  if (state.openInputAssignments.get(runId) === assignmentId) {
    throw new Error("Run input must close before commit");
  }
  const expected = expectedRunInputMessages(state, runId, assignmentId);
  const actual = messages.filter((message) => message.inputIdentity !== undefined);
  if (canonicalize(expected) !== canonicalize(actual)) {
    throw new Error(
      "Run record does not match admitted and consumed message identities/content",
    );
  }
}

export interface RunQueueInputCrossFacts {
  readonly sessionDeleted: boolean;
  readonly domainRevision: number;
  readonly currentAssignmentIdForRun?: string;
  readonly currentRunState?: ConversationRunState;
}

export async function reduceRunQueueInputRecord(input: {
  readonly state: RunQueueInputMutableSlice;
  readonly crossFacts: RunQueueInputCrossFacts;
  readonly body: Extract<
    ConversationRunJournalRecord,
    {
      t:
        | "admitted"
        | "run-input-opened"
        | "run-input-closed"
        | "run-input-appended"
        | "run-input-consumed";
    }
  >;
  readonly envelope: ConversationFactGroup;
  readonly conversationId: string;
  readonly lsn: number;
  readonly artifacts: ArtifactStore;
  readonly loadStoredInput: (
    stored: Extract<ConversationRunJournalRecord, { t: "admitted" }>["input"],
    artifacts: ArtifactStore,
  ) => Promise<UserTurnInput>;
  readonly hasAtomicQueuedState: boolean;
}): Promise<void> {
  const { state, crossFacts, body } = input;
  switch (body.t) {
    case "run-input-opened": {
      if (
        crossFacts.currentAssignmentIdForRun !== body.assignmentId ||
        state.closedInputAssignments.has(body.assignmentId) ||
        crossFacts.currentRunState !== "running"
      ) {
        throw corruptRunJournal("Invalid input opening");
      }
      state.openInputAssignments.set(body.runId, body.assignmentId);
      return;
    }
    case "run-input-closed": {
      if (state.openInputAssignments.get(body.runId) !== body.assignmentId) {
        throw corruptRunJournal("Invalid input closing");
      }
      state.openInputAssignments.delete(body.runId);
      state.closedInputAssignments.add(body.assignmentId);
      return;
    }
    case "run-input-appended": {
      if (
        !state.openInputAssignments.has(body.runId) ||
        state.runByIngress.has(body.ingressKey) ||
        crossFacts.currentRunState !== "running"
      ) {
        throw corruptRunJournal("Invalid appended input");
      }
      const turnInput = validateNonEmptyUserTurnInput(
        await input.loadStoredInput(body.input, input.artifacts),
      );
      state.appendedInputs.set(body.ingressKey, {
        record: body,
        input: turnInput,
        lsn: input.lsn,
      });
      state.runByIngress.set(body.ingressKey, body.runId);
      return;
    }
    case "run-input-consumed": {
      const key = `${body.assignmentId}/${body.boundary}`;
      const prior = [...state.inputConsumptions.values()].filter(
        (value) => value.assignmentId === body.assignmentId,
      );
      if (
        state.openInputAssignments.get(body.runId) !== body.assignmentId ||
        state.inputConsumptions.has(key) ||
        prior.some((value) => value.boundary >= body.boundary) ||
        body.ingressKeys.some(
          (id) =>
            state.appendedInputs.get(id)?.record.runId !== body.runId ||
            prior.some((value) => value.ingressKeys.includes(id)),
        )
      ) {
        throw corruptRunJournal("Invalid input consumption");
      }
      state.inputConsumptions.set(key, body);
      return;
    }
    case "admitted": {
      if (crossFacts.sessionDeleted) {
        throw corruptRunJournal("Deleted conversation contains a later admitted run");
      }
      assertAdmissionReplayContract({
        runAlreadyAdmitted: state.admittedByRun.has(body.runId),
        ingressAlreadyAdmitted: state.runByIngress.has(body.ingressKey),
        queuedPositionAlreadyUsed: hasQueuedPositionUsed(state, body.queuedPosition),
        hasAtomicQueuedState: input.hasAtomicQueuedState,
      });
      const turnInput = await input.loadStoredInput(body.input, input.artifacts);
      try {
        validateNonEmptyUserTurnInput(turnInput);
      } catch {
        throw corruptRunJournal("Run journal contains invalid user input");
      }
      state.admittedByRun.set(body.runId, {
        record: body,
        input: turnInput,
        lsn: input.lsn,
        domainRevision: crossFacts.domainRevision,
      });
      state.runByIngress.set(body.ingressKey, body.runId);
      return;
    }
  }
}

export function reduceGuardAdmittedRecord(input: {
  readonly state: GuardQueueInputMutableSlice;
  readonly body: Extract<ConversationRunJournalRecord, { t: "admitted" }>;
  readonly hasAtomicQueuedState: boolean;
}): void {
  const { state, body } = input;
  assertAdmissionReplayContract({
    runAlreadyAdmitted: state.admittedByRun.has(body.runId),
    ingressAlreadyAdmitted: state.runByIngress.has(body.ingressKey),
    queuedPositionAlreadyUsed: hasQueuedPositionUsed(state, body.queuedPosition),
    hasAtomicQueuedState: input.hasAtomicQueuedState,
  });
  state.admittedByRun.set(body.runId, {
    ingressKey: body.ingressKey,
    queuedPosition: body.queuedPosition,
    ingress: body.ingress,
  });
  state.runByIngress.set(body.ingressKey, body.runId);
}
