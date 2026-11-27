import { Buffer } from "node:buffer";
import { extractText, normalizeUserTurnInput } from "@zhixing-ai/core";
import { isOpenAdvancementSession } from "@zhixing-ai/core/advancement";
import type {
  ConversationBodyCursor,
  ConversationBodyFragment,
  ConversationBodyPage,
  ConversationRunOutcomesPage,
} from "@zhixing-ai/core/contracts";
import {
  assertLocalConversationIdForDevice,
  isLocalConversationId,
  parseConversationId,
  worksceneConversationId,
} from "@zhixing-ai/core/conversation";
import {
  classifyConversationDirectoryScope,
  computeDirectoryEntriesDigest,
  ConversationDirectoryPageCollector,
  coordinateConversationDirectoryPage,
  decodeProgramBodyCursor,
  encodeProgramBodyCursor,
  PROGRAM_MAX_WAIT_SLICE_MS,
  PROGRAM_SAFE_PAYLOAD_BUDGET_BYTES,
  PROGRAM_SURFACE_PRINCIPAL,
  PROGRAM_TURN_CHANNEL,
  ProgramConversationError,
  programConversationTurnId,
  sliceTextWithinJsonByteBudget,
  type ConversationDirectoryPageRequest,
  type ConversationDirectorySourceVersion,
  type ConversationShellOptions,
  type DirectorySourceProvider,
  type ProgramConversationApplication,
  type ProgramConversationExistingEntry,
  type ProgramConversationListInput,
  type ProgramConversationListResult,
  type ProgramConversationNewInput,
  type ProgramConversationNewResult,
  type ProgramConversationPendingInputEntry,
  type ProgramConversationReadInput,
  type ProgramConversationReadMessageEntry,
  type ProgramConversationReadResult,
  type ProgramConversationResultInput,
  type ProgramConversationResultOutput,
  type ProgramConversationSendInput,
  type ProgramConversationSendResult,
  type RawDirectoryCandidate,
} from "@zhixing-ai/core/conversation/application";
import { formatPersistedFileMaterial } from "../input-material-registry.js";
import { SerialTaskQueue } from "@zhixing-ai/core/persistence";
import { isProtocolIdentifier, protocolDigest } from "@zhixing-ai/core/protocol";
import {
  WORKSCENE_MANAGEMENT_LIST_QUERY,
  type WorksceneManagementListResult,
} from "@zhixing-ai/core/workscene/application";
import { createInitialControlEnvelope } from "@zhixing-ai/owner-kernel/control-admission";
import {
  WorksceneBusyError,
  type ConversationManager,
} from "@zhixing-ai/owner-kernel/conversation-manager";
import {
  DurableConversationAdmissionRejectedError,
} from "@zhixing-ai/owner-kernel/run-turn";
import { projectSessionTurn } from "@zhixing-ai/rpc/session-turn-stream";
import type { ConversationProtocolRuntime } from "./conversation-protocol-runtime.js";
import type { LocalConversationOwnerPort } from "./local-conversation-owner.js";
import type {
  OwnedDirectoryRecord,
  OwnedListRequest,
  OwnedListResponse,
  OwnedProbeResponse,
  OwnedRichMetadata,
  ProgramConversationEntryRemotePort,
  ProgramConversationLocalOwnedHandler,
  ProgramConversationOwnedRemotePort,
} from "./program-conversation-mesh.js";

function isDeterministicCallerProgramError(
  err: unknown,
): err is ProgramConversationError {
  return (
    err instanceof ProgramConversationError &&
    (err.code === "invalid_params" ||
      err.code === "invalid_ticket" ||
      err.code === "invalid_cursor" ||
      err.code === "payload_too_large" ||
      err.code === "idempotency_conflict")
  );
}

function isBodyCursorCoordinateError(err: unknown): boolean {
  return (
    err instanceof Error &&
    /^conversation-body-(?:cursor-run|(?:message|block)-cursor)$/u.test(
      err.message,
    )
  );
}

export interface HostAnchorDirectoryPort {
  listPage?(input: ConversationDirectoryPageRequest): Promise<{
    readonly records: readonly {
      readonly conversationId: string;
      readonly name: string;
      readonly createdAt: string;
      readonly lastActiveAt: string;
    }[];
    readonly next?: {
      readonly conversationId: string;
      readonly lastActiveAt: string;
    };
    readonly version?: ConversationDirectorySourceVersion;
  }>;
  exists(conversationId: string): Promise<boolean>;
  ensure(
    conversationId: string,
    options?: ConversationShellOptions & { readonly name?: string },
  ): Promise<unknown>;
  getStoredConversation(conversationId: string): Promise<{
    readonly id: string;
    readonly name: string;
    readonly lastActiveAt: string;
  } | null>;
  listWorksceneConversations(sceneId: string): Promise<
    readonly {
      readonly conversationId: string;
      readonly localId: string;
      readonly name: string;
      readonly createdAt: string;
      readonly lastActiveAt: string;
    }[]
  >;
}

export interface HostWorksceneQueryPort {
  query(
    descriptor: typeof WORKSCENE_MANAGEMENT_LIST_QUERY,
    input: { readonly kind: "list" },
  ): Promise<WorksceneManagementListResult>;
}

export interface HostAnchorProgramDeps {
  readonly protocol: ConversationProtocolRuntime;
  readonly manager: ConversationManager;
  readonly directory: HostAnchorDirectoryPort;
  readonly workscenes: HostWorksceneQueryPort;
  readonly emitSessionNotification?: (
    conversationId: string,
    method: string,
    params: unknown,
  ) => void;
  readonly isStopping?: () => boolean;
  readonly onAdmissionActivity?: () => void;
}

export interface HostLocalProgramDeps {
  readonly owner: LocalConversationOwnerPort;
  readonly isStopping?: () => boolean;
  readonly onAdmissionActivity?: () => void;
}

export interface HostTopologyProgramDeps {
  readonly deviceId: string;
  readonly currentTrust?: () => {
    readonly members: readonly {
      readonly state: string;
      readonly roles: readonly string[];
      readonly device: { readonly deviceId: string };
    }[];
  };
  readonly remoteOwnedFor?: (
    deviceId: string,
  ) => ProgramConversationOwnedRemotePort | undefined;
}

export interface CreateHostProgramConversationOptions {
  readonly anchor: HostAnchorProgramDeps;
  readonly localExecutor?: HostLocalProgramDeps;
  readonly topology?: HostTopologyProgramDeps;
}

export interface ExecutorProgramConversationController
  extends ProgramConversationApplication {
  readonly localOwned: ProgramConversationLocalOwnedHandler;
  discoverInternal(
    input: ProgramConversationListInput,
    signal?: AbortSignal,
  ): Promise<Awaited<ReturnType<HostProgramConversationController["discoverInternal"]>>>;
}

export interface HostProgramConversationController
  extends ProgramConversationApplication {
  createForPrincipal(
    creatorPrincipal: string,
    input: ProgramConversationNewInput,
    signal?: AbortSignal,
  ): Promise<ProgramConversationNewResult>;
  discoverInternal(
    input: ProgramConversationListInput,
    signal?: AbortSignal,
  ): Promise<{
    readonly conversations: readonly {
      readonly conversationId: string;
      readonly name: string;
      readonly scope: string;
      readonly sceneId?: string;
      readonly sceneName?: string;
      readonly workspaceLabel?: string;
      readonly active: boolean;
      readonly busy: boolean;
      readonly pendingCount: number;
      readonly summary: string;
      readonly summaryTruncated: boolean;
      readonly lastActiveAt: string;
    }[];
    readonly worksceneCandidates: readonly {
      readonly canonicalKey: string;
      readonly sceneId: string;
      readonly sceneName: string;
      readonly workspaceLabel?: string;
      readonly initialized: false;
      readonly lastActiveAt: string;
    }[];
    readonly nextCursor?: string;
    readonly partial: boolean;
  }>;
}

function slugifyMainName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function isSafeMainConversationId(candidate: string): boolean {
  return (
    candidate.length > 0 &&
    candidate.length <= 96 &&
    isProtocolIdentifier(candidate) &&
    parseConversationId(candidate).scope.kind === "user" &&
    classifyConversationDirectoryScope(candidate) === "main" &&
    !isLocalConversationId(candidate) &&
    !candidate.toLowerCase().startsWith("local-") &&
    !candidate.toLowerCase().startsWith("ws:")
  );
}

function deterministicMainCandidateId(
  normalizedName: string | undefined,
  canonicalRequestId: string,
  atIso: string,
  collisionAttempt: number,
): string {
  const date = atIso.slice(0, 10).replace(/-/g, "");
  const hashSuffix = protocolDigest("ProgramMainConversationId", 1, {
    canonicalRequestId,
    collisionAttempt,
  }).slice(7, 13);
  const slug = normalizedName ? slugifyMainName(normalizedName) : "";
  if (slug) {
    const direct = collisionAttempt === 0 ? slug : `${slug}-${hashSuffix}`;
    if (isSafeMainConversationId(direct)) {
      return direct;
    }
    const prefixed = `chat-${slug.slice(0, 40)}-${hashSuffix}`;
    if (isSafeMainConversationId(prefixed)) {
      return prefixed;
    }
  }
  return `chat-${date}-${hashSuffix}`;
}

function matchesDirectoryQuery(
  query: string | undefined,
  fields: readonly (string | undefined)[],
): boolean {
  const needle = query?.trim().toLowerCase();
  if (!needle) return true;
  return fields.some(
    (field) => field !== undefined && field.toLowerCase().includes(needle),
  );
}

function delayWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function collapseSummaryLine(text: string): {
  readonly summary: string;
  readonly summaryTruncated: boolean;
} {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= 160) {
    return { summary: collapsed, summaryTruncated: false };
  }
  return { summary: `${collapsed.slice(0, 160)}...`, summaryTruncated: true };
}

async function summarizeFromRecoveryPage(
  conversationId: string,
  recoveryPage: (
    req: Parameters<ConversationProtocolRuntime["recoveryPage"]>[0],
  ) => Promise<unknown>,
): Promise<{ readonly summary: string; readonly summaryTruncated: boolean }> {
  try {
    const page = (await recoveryPage({
      conversationId,
      mode: "body-page",
      includeInputs: true,
    })) as ConversationBodyPage;
    for (const fragment of page.fragments) {
      if (fragment.type === "text" && fragment.text.trim().length > 0) {
        return collapseSummaryLine(fragment.text);
      }
    }
  } catch {
    // Fall back to empty summary if conversation has 0 runs or is preparing.
  }
  return { summary: "", summaryTruncated: false };
}

async function readOpenAdvancementFromSessionState(
  conversationId: string,
  sessionState: Pick<ConversationProtocolRuntime["sessionState"], "readAdvancementState">,
): Promise<string | undefined> {
  try {
    const adv = await sessionState.readAdvancementState(conversationId, {
      principal: { kind: "host", component: "program-directory" },
      requestId: `program-adv:${conversationId}`,
      deadlineAt: new Date(Date.now() + 10_000).toISOString(),
    });
    return adv && isOpenAdvancementSession(adv) ? adv.status : undefined;
  } catch {
    return undefined;
  }
}

async function readCommittedAssistantPage(input: {
  readonly conversationId: string;
  readonly requestId: string;
  readonly runId: string;
  readonly cursorToken?: string;
  readonly recoveryPage: (
    req: Parameters<ConversationProtocolRuntime["recoveryPage"]>[0],
  ) => Promise<unknown>;
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
}): Promise<
  | {
      readonly kind: "ready";
      readonly answer: string | null;
      readonly answerTruncated: boolean;
      readonly emptyReason?: "no_assistant_text";
      readonly nextCursor?: string;
    }
  | { readonly kind: "preparing" }
  | { readonly kind: "reset" }
> {
  let cursor: ConversationBodyCursor | undefined;
  let previousBlock = -1;

  if (input.cursorToken !== undefined) {
    const decoded = decodeProgramBodyCursor(
      input.cursorToken,
      "result-answer",
      input.conversationId,
      input.runId,
    );
    cursor = decoded.bodyCursor;
    previousBlock = decoded.previousBlock ?? -1;
  } else {
    for (;;) {
      const page = (await input.recoveryPage({
        conversationId: input.conversationId,
        mode: "body-page",
        runId: input.runId,
        ...(cursor ? { cursor } : {}),
      })) as ConversationBodyPage;
      if (page.reset) return { kind: "reset" };
      if (page.preparing) {
        if (Date.now() >= input.deadlineMs || input.signal?.aborted) {
          return { kind: "preparing" };
        }
        cursor = page.cursor;
        await delayWithSignal(
          Math.min(25, Math.max(1, input.deadlineMs - Date.now())),
          input.signal,
        );
        continue;
      }
      const assistant = page.fragments.find((item) => item.role === "assistant");
      if (assistant) {
        cursor = { ...assistant.cursor, block: 0, offset: 0 };
        break;
      }
      const first = page.fragments[0];
      if (first) {
        cursor = { ...first.cursor, block: -1, offset: 0 };
      } else if (page.hasMore) {
        cursor = page.cursor;
      } else {
        return {
          kind: "ready",
          answer: null,
          answerTruncated: false,
          emptyReason: "no_assistant_text",
        };
      }
    }
  }

  let answer = "";
  let answerBytes = 0;
  let textBlocks = 0;
  const budget = PROGRAM_SAFE_PAYLOAD_BUDGET_BYTES;

  while (cursor) {
    const page = (await input.recoveryPage({
      conversationId: input.conversationId,
      mode: "body-page",
      runId: input.runId,
      direction: "forward",
      cursor,
    })) as ConversationBodyPage;
    if (page.reset) return { kind: "reset" };
    if (page.preparing) {
      if (answer.length > 0) {
        return {
          kind: "ready",
          answer,
          answerTruncated: true,
          nextCursor: encodeProgramBodyCursor({
            v: 1,
            kind: "result-answer",
            runId: input.runId,
            previousBlock,
            bodyCursor: cursor,
          }),
        };
      }
      if (Date.now() >= input.deadlineMs || input.signal?.aborted) {
        return { kind: "preparing" };
      }
      await delayWithSignal(
        Math.min(25, Math.max(1, input.deadlineMs - Date.now())),
        input.signal,
      );
      continue;
    }

    for (const item of page.fragments) {
      if (item.type !== "text") continue;
      let prefix = "";
      const nextBlock = item.block;
      if (nextBlock !== previousBlock) {
        if (textBlocks > 0 || (input.cursorToken !== undefined && previousBlock >= 0)) {
          prefix = "\n";
        }
      }
      const prefixBytes = prefix
        ? Buffer.byteLength(JSON.stringify(prefix), "utf8") - 2
        : 0;
      const remainingBudget = budget - answerBytes - prefixBytes;
      if (remainingBudget <= 0) {
        const resumeCursor: ConversationBodyCursor = {
          ...item.cursor,
          offset: item.offset,
        };
        return {
          kind: "ready",
          answer,
          answerTruncated: true,
          nextCursor: encodeProgramBodyCursor({
            v: 1,
            kind: "result-answer",
            runId: input.runId,
            previousBlock,
            bodyCursor: resumeCursor,
          }),
        };
      }
      const sliced = sliceTextWithinJsonByteBudget(
        item.text,
        0,
        remainingBudget,
      );
      if (sliced.chunk.length === 0 && item.text.length > 0) {
        const resumeCursor: ConversationBodyCursor = {
          ...item.cursor,
          offset: item.offset,
        };
        return {
          kind: "ready",
          answer,
          answerTruncated: true,
          nextCursor: encodeProgramBodyCursor({
            v: 1,
            kind: "result-answer",
            runId: input.runId,
            previousBlock,
            bodyCursor: resumeCursor,
          }),
        };
      }
      const encodedBytes =
        Buffer.byteLength(JSON.stringify(sliced.chunk), "utf8") - 2;
      answer += prefix + sliced.chunk;
      answerBytes += prefixBytes + encodedBytes;
      if (nextBlock !== previousBlock) {
        textBlocks += 1;
        previousBlock = nextBlock;
      }
      if (sliced.nextOffset < item.text.length) {
        const resumeCursor: ConversationBodyCursor = {
          ...item.cursor,
          offset: item.offset + sliced.nextOffset,
        };
        return {
          kind: "ready",
          answer,
          answerTruncated: true,
          nextCursor: encodeProgramBodyCursor({
            v: 1,
            kind: "result-answer",
            runId: input.runId,
            previousBlock,
            bodyCursor: resumeCursor,
          }),
        };
      }
    }

    if (!page.hasMore) break;
    if (!page.cursor) break;
    cursor = page.cursor;
  }

  if (answer.length === 0 && textBlocks === 0 && input.cursorToken === undefined) {
    return {
      kind: "ready",
      answer: null,
      answerTruncated: false,
      emptyReason: "no_assistant_text",
    };
  }

  return {
    kind: "ready",
    answer,
    answerTruncated: false,
  };
}

function projectEntriesForInternalDiscover(
  page: ProgramConversationListResult,
): Awaited<ReturnType<HostProgramConversationController["discoverInternal"]>> {
  const conversations: Array<{
    readonly conversationId: string;
    readonly name: string;
    readonly scope: string;
    readonly sceneId?: string;
    readonly sceneName?: string;
    readonly workspaceLabel?: string;
    readonly active: boolean;
    readonly busy: boolean;
    readonly pendingCount: number;
    readonly summary: string;
    readonly summaryTruncated: boolean;
    readonly lastActiveAt: string;
  }> = [];
  const worksceneCandidates: Array<{
    readonly canonicalKey: string;
    readonly sceneId: string;
    readonly sceneName: string;
    readonly workspaceLabel?: string;
    readonly initialized: false;
    readonly lastActiveAt: string;
  }> = [];
  for (const entry of page.entries) {
    if (entry.entryKind === "conversation") {
      conversations.push({
        conversationId: entry.conversationId,
        name: entry.name,
        scope: entry.scope,
        ...(entry.sceneId ? { sceneId: entry.sceneId } : {}),
        ...(entry.sceneName ? { sceneName: entry.sceneName } : {}),
        ...(entry.workspaceLabel
          ? { workspaceLabel: entry.workspaceLabel }
          : {}),
        active: entry.active,
        busy: entry.busy,
        pendingCount: entry.pendingCount,
        summary: entry.summary,
        summaryTruncated: entry.summaryTruncated,
        lastActiveAt: entry.lastActiveAt,
      });
    } else {
      worksceneCandidates.push({
        canonicalKey: entry.canonicalKey,
        sceneId: entry.sceneId,
        sceneName: entry.sceneName,
        ...(entry.workspaceLabel
          ? { workspaceLabel: entry.workspaceLabel }
          : {}),
        initialized: false,
        lastActiveAt: entry.lastActiveAt,
      });
    }
  }
  return {
    conversations,
    worksceneCandidates,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    partial: page.partial,
  };
}

export function createLocalOwnedProgramConversationHandler(options: {
  readonly deviceId: string;
  readonly local: HostLocalProgramDeps;
  readonly isAdoptedByAnchor?: (conversationId: string) => Promise<boolean>;
}): ProgramConversationLocalOwnedHandler {
  const { deviceId, local, isAdoptedByAnchor } = options;

  function assertOwnedScope(conversationId: string): void {
    if (!isLocalConversationId(conversationId)) {
      throw new ProgramConversationError(
        "unauthorized",
        `conversation.program owned 操作仅允许访问本机作用域对话: ${conversationId}`,
        { retryable: false, exitCode: 1 },
      );
    }
    try {
      assertLocalConversationIdForDevice(conversationId, deviceId);
    } catch {
      throw new ProgramConversationError(
        "unauthorized",
        `conversation.program owned 操作目标不属于当前设备的本机对话持有范围: ${conversationId}`,
        { retryable: false, exitCode: 1 },
      );
    }
  }

  async function mapLocalDurableRejection(
    conversationId: string,
    requestId: string,
    err: DurableConversationAdmissionRejectedError,
  ): Promise<ProgramConversationSendResult> {
    if (err.code === "idempotency-conflict") {
      return {
        v: 1,
        admitted: false,
        conversationId,
        requestId,
        error: {
          code: "idempotency_conflict",
          message: err.message,
          retryable: false,
        },
      };
    }
    if (/does not bind the current conversation owner and ingress/iu.test(err.message)) {
      const auth = await local.owner.currentAuthority(conversationId).catch(() => undefined);
      throw new ProgramConversationError(
        "temporarily_unavailable",
        "目标对话权威换代中，请保留票据稍后重试",
        {
          retryable: true,
          exitCode: 3,
          ...(auth ? { details: { leafAuthorityState: auth.state } } : {}),
        },
      );
    }
    const latestStatus = await local.owner
      .conversationAdoptionStatus(conversationId)
      .catch(() => undefined);
    if (latestStatus?.deleted || /deleted/iu.test(err.message)) {
      return {
        v: 1,
        admitted: false,
        conversationId,
        requestId,
        error: {
          code: "target_deleted",
          message: `目标对话已被删除: ${conversationId}`,
          retryable: false,
        },
      };
    }
    if (latestStatus?.unavailableTransfer || /lifecycle projection/iu.test(err.message)) {
      throw new ProgramConversationError(
        "temporarily_unavailable",
        "目标对话正在完成生命周期投影，请保留票据稍后重试",
        { retryable: true, exitCode: 3 },
      );
    }
    if (
      (await local.owner.hasOpenAdvancementSession(conversationId).catch(() => false)) ||
      /契约推进|独立验收/u.test(err.message)
    ) {
      return {
        v: 1,
        admitted: false,
        conversationId,
        requestId,
        error: {
          code: "needs_attention",
          message: "目标对话当前存在未终结的契约推进会话，请先在终端处理",
          retryable: false,
        },
      };
    }
    return {
      v: 1,
      admitted: false,
      conversationId,
      requestId,
      error: {
        code: "not_found",
        message: err.message,
        retryable: false,
      },
    };
  }

  async function ownedList(
    input: OwnedListRequest,
    signal?: AbortSignal,
  ): Promise<OwnedListResponse> {
    signal?.throwIfAborted();
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit)));
    const sourceId = `local:${deviceId}`;
    const authorities = await local.owner.listConversationAuthorities();
    const allVisible: Array<
      Extract<RawDirectoryCandidate, { entryKind: "conversation" }>
    > = [];
    for (const { conversationId, authority } of authorities) {
      if (authority.state !== "current") continue;
      if (isAdoptedByAnchor && (await isAdoptedByAnchor(conversationId))) {
        continue;
      }
      const meta = await local.owner.sessionState.readSessionMeta(
        conversationId,
        {
          principal: { kind: "host", component: "program-local-directory" },
          requestId: `program-local-dir:${conversationId}`,
          deadlineAt: new Date(Date.now() + 30_000).toISOString(),
        },
      );
      const name = meta.name ?? conversationId;
      if (!matchesDirectoryQuery(input.query, [conversationId, name])) {
        continue;
      }
      allVisible.push({
        entryKind: "conversation",
        canonicalKey: conversationId,
        conversationId,
        scope: "local",
        name,
        lastActiveAt: meta.lastActiveAt,
        ownerSourceId: sourceId,
      });
    }
    const version: ConversationDirectorySourceVersion = {
      kind: "direct" as const,
      entriesDigest: computeDirectoryEntriesDigest(
        allVisible.map((item) => ({
          canonicalKey: item.canonicalKey,
          lastActiveAt: item.lastActiveAt,
          name: item.name,
        })),
      ),
    };
    const collector = new ConversationDirectoryPageCollector<
      (typeof allVisible)[number]
    >({
      limit,
      ...(input.after
        ? {
            after: {
              conversationId: input.after.canonicalKey,
              lastActiveAt: input.after.lastActiveAt,
            },
          }
        : {}),
    });
    for (const item of allVisible) {
      collector.add(item);
    }
    const page = collector.result();
    const records: OwnedDirectoryRecord[] = await Promise.all(
      page.records.map(async (candidate) => {
        const rt = local.owner.runtimeState(candidate.conversationId);
        const [snippet, advancementStatus] = await Promise.all([
          summarizeFromRecoveryPage(candidate.conversationId, (req) =>
            local.owner.recoveryPage(req),
          ),
          readOpenAdvancementFromSessionState(
            candidate.conversationId,
            local.owner.sessionState,
          ),
        ]);
        const rich: OwnedRichMetadata = {
          active: rt.active,
          busy: rt.busy,
          pendingCount: rt.pendingCount,
          ...(advancementStatus ? { advancementStatus } : {}),
          summary: snippet.summary,
          summaryTruncated: snippet.summaryTruncated,
        };
        return { candidate, rich };
      }),
    );
    return {
      records,
      hasMore: page.next !== undefined,
      version,
    };
  }

  async function ownedProbe(
    conversationId: string,
    signal?: AbortSignal,
  ): Promise<OwnedProbeResponse> {
    signal?.throwIfAborted();
    assertOwnedScope(conversationId);
    if (isAdoptedByAnchor && (await isAdoptedByAnchor(conversationId))) {
      return { state: "absent" };
    }
    const [status, authority] = await Promise.all([
      local.owner.conversationAdoptionStatus(conversationId),
      local.owner.currentAuthority(conversationId),
    ]);
    if (status.unavailableTransfer || authority.state !== "current") {
      return { state: "migrating" };
    }
    if (status.deleted) {
      return { state: "deleted" };
    }
    if (status.hasDurableIdentity) {
      return { state: "current" };
    }
    return { state: "absent" };
  }

  async function ownedSend(
    input: ProgramConversationSendInput,
    _signal?: AbortSignal,
  ): Promise<ProgramConversationSendResult> {
    const { conversationId, requestId, text } = input;
    assertOwnedScope(conversationId);
    const normalizedInput = normalizeUserTurnInput(text);
    const physicalTurnId = programConversationTurnId(conversationId, requestId);

    const [status, authority] = await Promise.all([
      local.owner.conversationAdoptionStatus(conversationId),
      local.owner.currentAuthority(conversationId),
    ]);
    if (status.unavailableTransfer || authority.state !== "current") {
      throw new ProgramConversationError(
        "temporarily_unavailable",
        "目标本机对话正处于接管迁移中，请保留票据稍后重试",
        {
          retryable: true,
          exitCode: 3,
          details: { leafAuthorityState: authority.state },
        },
      );
    }

    const inspectReceipt = async () => {
      try {
        return await local.owner.inspectProgramInputReceipt(conversationId, {
          physicalTurnId,
          expectedInput: normalizedInput,
        });
      } catch (err) {
        if (
          err &&
          typeof err === "object" &&
          (err as { code?: unknown }).code === "CONVERSATION_BASE_UNAVAILABLE"
        ) {
          throw new ProgramConversationError(
            "temporarily_unavailable",
            "目标对话迁入基底尚未就绪，请保留票据稍后重试",
            { retryable: true, exitCode: 3 },
          );
        }
        throw err;
      }
    };

    const existing = await inspectReceipt();
    if (existing.status === "accepted") {
      local.onAdmissionActivity?.();
      return {
        v: 1,
        admitted: true,
        conversationId,
        requestId,
        runId: existing.runId,
        replayed: true,
      };
    }
    if (existing.status === "idempotency-conflict") {
      return {
        v: 1,
        admitted: false,
        conversationId,
        requestId,
        error: {
          code: "idempotency_conflict",
          message: "同一 requestId 已绑定不同的消息内容",
          retryable: false,
        },
      };
    }
    if (status.deleted || existing.deleted) {
      return {
        v: 1,
        admitted: false,
        conversationId,
        requestId,
        error: {
          code: "target_deleted",
          message: `目标对话已被删除: ${conversationId}`,
          retryable: false,
        },
      };
    }
    if (!status.hasDurableIdentity) {
      return {
        v: 1,
        admitted: false,
        conversationId,
        requestId,
        error: {
          code: "not_found",
          message: `目标对话不存在: ${conversationId}`,
          retryable: false,
        },
      };
    }

    const isStopping = () =>
      (local.isStopping?.() ?? false) || local.owner.isShuttingDown();
    if (isStopping()) {
      return {
        v: 1,
        admitted: false,
        conversationId,
        requestId,
        error: {
          code: "host_draining",
          message: "宿主正在排空停机，未接纳新的运行请求",
          retryable: false,
        },
      };
    }
    if (await local.owner.hasOpenAdvancementSession(conversationId)) {
      return {
        v: 1,
        admitted: false,
        conversationId,
        requestId,
        error: {
          code: "needs_attention",
          message: "目标对话当前存在未终结的契约推进会话，请先在终端处理",
          retryable: false,
        },
      };
    }

    local.onAdmissionActivity?.();
    const turnOrigin = {
      channel: PROGRAM_TURN_CHANNEL,
      triggeredBy: requestId,
      messageIdentity: {
        id: physicalTurnId,
        source: { kind: "program" as const },
      },
    } as const;
    let localEarlyRejection: ProgramConversationSendResult | undefined;
    try {
      const executionHandle = local.owner.createAgentTurnExecution({
        input: normalizedInput,
        turnOrigin,
        surfacePrincipal: PROGRAM_SURFACE_PRINCIPAL,
        notify: () => {},
      });
      const admitted = await local.owner.agentTurnAdmission.admit({
        identity: {
          kind: "existing",
          conversationId,
          exists: async () =>
            (await local.owner.conversationAdoptionStatus(conversationId))
              .hasDurableIdentity,
        },
        invocation: { kind: "agent" },
        caller: {
          kind: "surface",
          surfacePrincipal: PROGRAM_SURFACE_PRINCIPAL,
          connectionId: `program:${requestId}`,
        },
        observe: false,
        turnId: physicalTurnId,
        turnOrigin,
        input: normalizedInput,
        execution: executionHandle.execution,
        beforeDurableAdmit: async ({ conversationId: managedConversationId }) => {
          const rechecked = await inspectReceipt();
          if (rechecked.status === "accepted") {
            return { shouldEnqueue: false, runId: rechecked.runId };
          }
          if (rechecked.status === "idempotency-conflict") {
            localEarlyRejection = {
              v: 1,
              admitted: false,
              conversationId,
              requestId,
              error: {
                code: "idempotency_conflict",
                message: "同一 requestId 已绑定不同的消息内容",
                retryable: false,
              },
            };
            throw new Error("program-early-rejection");
          }
          const [latestStatus, latestAuthority] = await Promise.all([
            local.owner.conversationAdoptionStatus(managedConversationId),
            local.owner.currentAuthority(managedConversationId),
          ]);
          if (
            latestStatus.unavailableTransfer ||
            latestAuthority.state !== "current"
          ) {
            throw new ProgramConversationError(
              "temporarily_unavailable",
              "目标本机对话正处于接管迁移中，请保留票据稍后重试",
              {
                retryable: true,
                exitCode: 3,
                details: { leafAuthorityState: latestAuthority.state },
              },
            );
          }
          if (latestStatus.deleted || rechecked.deleted) {
            localEarlyRejection = {
              v: 1,
              admitted: false,
              conversationId,
              requestId,
              error: {
                code: "target_deleted",
                message: `目标对话已被删除: ${conversationId}`,
                retryable: false,
              },
            };
            throw new Error("program-early-rejection");
          }
          if (isStopping()) {
            localEarlyRejection = {
              v: 1,
              admitted: false,
              conversationId,
              requestId,
              error: {
                code: "host_draining",
                message: "宿主正在排空停机，未接纳新的运行请求",
                retryable: false,
              },
            };
            throw new Error("program-early-rejection");
          }
          if (await local.owner.hasOpenAdvancementSession(conversationId)) {
            localEarlyRejection = {
              v: 1,
              admitted: false,
              conversationId,
              requestId,
              error: {
                code: "needs_attention",
                message: "目标对话当前存在未终结的契约推进会话，请先在终端处理",
                retryable: false,
              },
            };
            throw new Error("program-early-rejection");
          }
          return undefined;
        },
      });
      if (admitted.status === "lifecycle-busy") {
        throw new ProgramConversationError(
          "temporarily_unavailable",
          "目标本机对话正处于变更或移除静默期，请保留票据稍后重试",
          { retryable: true, exitCode: 3 },
        );
      }
      if (admitted.status === "full") {
        const rechecked = await inspectReceipt();
        if (rechecked.status === "accepted") {
          return {
            v: 1,
            admitted: true,
            conversationId,
            requestId,
            runId: rechecked.runId,
            replayed: true,
          };
        }
        return {
          v: 1,
          admitted: false,
          conversationId,
          requestId,
          error: {
            code: "queue_full",
            message: "目标对话待处理队列已满",
            retryable: true,
          },
        };
      }
      if (admitted.status === "not-found") {
        return {
          v: 1,
          admitted: false,
          conversationId,
          requestId,
          error: {
            code: "not_found",
            message: `目标对话不存在: ${conversationId}`,
            retryable: false,
          },
        };
      }
      if (admitted.status === "immediate") {
        void admitted.start().catch(() => undefined);
      }
      void executionHandle.outcome.catch(() => undefined);
      return {
        v: 1,
        admitted: true,
        conversationId,
        requestId,
        runId: admitted.runId!,
        ...(admitted.status === "replayed" ? { replayed: true } : {}),
      };
    } catch (err) {
      if (localEarlyRejection) return localEarlyRejection;
      if (err instanceof WorksceneBusyError) {
        throw new ProgramConversationError(
          "temporarily_unavailable",
          "目标本机对话正忙于目录或迁移切换，请保留票据稍后重试",
          { retryable: true, exitCode: 3 },
        );
      }
      if (err instanceof DurableConversationAdmissionRejectedError) {
        return await mapLocalDurableRejection(conversationId, requestId, err);
      }
      throw err;
    }
  }

  async function ownedResult(
    input: ProgramConversationResultInput,
    signal?: AbortSignal,
  ): Promise<ProgramConversationResultOutput> {
    const { conversationId, requestId } = input;
    assertOwnedScope(conversationId);
    if (input.cursor !== undefined) {
      decodeProgramBodyCursor(input.cursor, "result-answer", conversationId);
    }
    const waitMs = Math.min(
      Math.max(0, input.waitMs ?? 0),
      PROGRAM_MAX_WAIT_SLICE_MS,
    );
    const startMs = Date.now();
    const deadlineMs = startMs + waitMs;
    const prepareGraceDeadlineMs = Math.max(deadlineMs, startMs + 1_500);
    const physicalTurnId = programConversationTurnId(conversationId, requestId);

    for (;;) {
      const [status, authority] = await Promise.all([
        local.owner.conversationAdoptionStatus(conversationId),
        local.owner.currentAuthority(conversationId),
      ]);
      if (status.unavailableTransfer || authority.state !== "current") {
        throw new ProgramConversationError(
          "temporarily_unavailable",
          "目标本机对话正处于接管迁移中，请保留票据稍后重试",
          {
            retryable: true,
            exitCode: 3,
            details: { leafAuthorityState: authority.state },
          },
        );
      }

      let receipt: Awaited<
        ReturnType<LocalConversationOwnerPort["inspectProgramInputReceipt"]>
      >;
      try {
        receipt = await local.owner.inspectProgramInputReceipt(conversationId, {
          physicalTurnId,
        });
      } catch (err) {
        if (
          err &&
          typeof err === "object" &&
          (err as { code?: unknown }).code === "CONVERSATION_BASE_UNAVAILABLE"
        ) {
          return {
            v: 1,
            state: "temporarily_unavailable",
            conversationId,
            requestId,
            error: {
              code: "temporarily_unavailable",
              message: "目标对话迁入基底尚未就绪，请保留票据稍后重试",
              retryable: true,
            },
          };
        }
        throw err;
      }

      if (receipt.status === "idempotency-conflict") {
        throw new ProgramConversationError(
          "idempotency_conflict",
          "该请求标识存在幂等冲突",
          { retryable: false, exitCode: 1 },
        );
      }

      if (receipt.status === "unknown") {
        if (receipt.deleted || status.deleted) {
          return {
            v: 1,
            state: "target_deleted",
            conversationId,
            requestId,
            error: {
              code: "target_deleted",
              message: `目标对话已被删除: ${conversationId}`,
              retryable: false,
            },
          };
        }
        return {
          v: 1,
          state: "unknown",
          conversationId,
          requestId,
          error: {
            code: "unknown",
            message: "尚未在当前权威查到该请求的入账记录",
            retryable: true,
          },
        };
      }

      const runId = receipt.runId;
      if (input.cursor !== undefined) {
        decodeProgramBodyCursor(
          input.cursor,
          "result-answer",
          conversationId,
          runId,
        );
      }
      if (receipt.deleted || status.deleted) {
        return {
          v: 1,
          state: "target_deleted",
          conversationId,
          requestId,
          runId,
          error: {
            code: "target_deleted",
            message: `目标对话已被删除: ${conversationId}`,
            retryable: false,
          },
        };
      }
      if (receipt.clearCovered) {
        return {
          v: 1,
          state: "cleared",
          conversationId,
          requestId,
          runId,
          error: {
            code: "cleared",
            message: "目标对话已执行清空并覆盖本次运行",
            retryable: false,
          },
        };
      }

      const recoveryPage = (
        req: Parameters<ConversationProtocolRuntime["recoveryPage"]>[0],
      ) => local.owner.recoveryPage(req);

      const recheckTerminal = async (): Promise<
        ProgramConversationResultOutput | undefined
      > => {
        try {
          const recheck = await local.owner.inspectProgramInputReceipt(
            conversationId,
            { physicalTurnId },
          );
          if (recheck.status === "accepted" && recheck.deleted) {
            return {
              v: 1,
              state: "target_deleted",
              conversationId,
              requestId,
              runId,
              error: {
                code: "target_deleted",
                message: `目标对话已被删除: ${conversationId}`,
                retryable: false,
              },
            };
          }
          if (recheck.status === "accepted" && recheck.clearCovered) {
            return {
              v: 1,
              state: "cleared",
              conversationId,
              requestId,
              runId,
              error: {
                code: "cleared",
                message: "目标对话已执行清空并覆盖本次运行",
                retryable: false,
              },
            };
          }
        } catch {
          // Fall back below.
        }
        return undefined;
      };

      let outcomes: ConversationRunOutcomesPage;
      try {
        outcomes = (await recoveryPage({
          conversationId,
          mode: "run-outcomes",
          runIds: [runId],
        })) as ConversationRunOutcomesPage;
      } catch (err) {
        if (err instanceof ProgramConversationError) throw err;
        const terminal = await recheckTerminal();
        if (terminal) return terminal;
        return {
          v: 1,
          state: "temporarily_unavailable",
          conversationId,
          requestId,
          runId,
          error: {
            code: "temporarily_unavailable",
            message: `对话运行状态当前暂不可读: ${err instanceof Error ? err.message : String(err)}`,
            retryable: true,
          },
        };
      }
      const runOutcome = outcomes.entries[0];
      const runState = runOutcome?.state ?? "unknown";

      if (runState === "committed") {
        let bodyResult: Awaited<ReturnType<typeof readCommittedAssistantPage>>;
        try {
          bodyResult = await readCommittedAssistantPage({
            conversationId,
            requestId,
            runId,
            ...(input.cursor !== undefined ? { cursorToken: input.cursor } : {}),
            recoveryPage,
            deadlineMs: prepareGraceDeadlineMs,
            signal,
          });
        } catch (err) {
          if (err instanceof ProgramConversationError) throw err;
          if (isBodyCursorCoordinateError(err)) {
            throw new ProgramConversationError(
              "invalid_cursor",
              "正文游标位置与目标不匹配。",
              { retryable: false, exitCode: 1 },
            );
          }
          const terminal = await recheckTerminal();
          if (terminal) return terminal;
          return {
            v: 1,
            state: "temporarily_unavailable",
            conversationId,
            requestId,
            runId,
            runState: "committed",
            error: {
              code: "temporarily_unavailable",
              message: `已提交回复正文当前暂不可读: ${err instanceof Error ? err.message : String(err)}`,
              retryable: true,
            },
          };
        }
        if (bodyResult.kind === "preparing") {
          return {
            v: 1,
            state: "pending",
            conversationId,
            requestId,
            runId,
            runState: "committed",
          };
        }
        if (bodyResult.kind === "reset") {
          const terminal = await recheckTerminal();
          if (terminal) return terminal;
          if (input.cursor !== undefined) {
            return {
              v: 1,
              state: "cursor_expired",
              conversationId,
              requestId,
              runId,
              runState: "committed",
              error: {
                code: "cursor_expired",
                message: "结果续读游标已因权威换代失效，请从头重读",
                retryable: true,
              },
            };
          }
          if (Date.now() < prepareGraceDeadlineMs && !signal?.aborted) {
            await delayWithSignal(25, signal);
            continue;
          }
          return {
            v: 1,
            state: "temporarily_unavailable",
            conversationId,
            requestId,
            runId,
            runState: "committed",
            error: {
              code: "temporarily_unavailable",
              message: "对话权威换代中，请持原票据重试",
              retryable: true,
            },
          };
        }
        return {
          v: 1,
          state: "completed",
          conversationId,
          requestId,
          runId,
          runState: "committed",
          answer: bodyResult.answer,
          answerTruncated: bodyResult.answerTruncated,
          ...(bodyResult.emptyReason
            ? { emptyReason: bodyResult.emptyReason }
            : {}),
          ...(bodyResult.nextCursor
            ? { nextCursor: bodyResult.nextCursor }
            : {}),
        };
      }

      if (runState === "failed" || runState === "expired") {
        return {
          v: 1,
          state: "failed",
          conversationId,
          requestId,
          runId,
          runState,
          error: {
            code: "invalid_params",
            message: runOutcome?.reason ?? "对话运行失败",
            retryable: false,
          },
        };
      }
      if (runState === "cancelled") {
        return {
          v: 1,
          state: "cancelled",
          conversationId,
          requestId,
          runId,
          runState: "cancelled",
          error: {
            code: "invalid_params",
            message: runOutcome?.reason ?? "对话运行已取消",
            retryable: false,
          },
        };
      }
      if (runState === "uncertain") {
        return {
          v: 1,
          state: "uncertain",
          conversationId,
          requestId,
          runId,
          runState: "uncertain",
          error: {
            code: "uncertain",
            message: "对话运行处于待消歧状态",
            retryable: true,
          },
        };
      }
      if (
        runState !== "queued" &&
        runState !== "dispatched" &&
        runState !== "running" &&
        runState !== "cancel-requested"
      ) {
        return {
          v: 1,
          state: "unknown",
          conversationId,
          requestId,
          runId,
          runState: runState === "missing" ? "missing" : "unknown",
          error: {
            code: "unknown",
            message: "已查到请求接纳收据，但当前权威尚未确认运行状态，请保留票据稍后重试",
            retryable: true,
          },
        };
      }

      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0 || signal?.aborted) {
        return {
          v: 1,
          state: "pending",
          conversationId,
          requestId,
          runId,
          runState,
        };
      }

      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          unsub();
          signal?.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, Math.min(150, remainingMs));
        timer.unref?.();
        const unsub = local.owner.subscribeRunNotifications((notification) => {
          if (notification.conversationId === conversationId) finish();
        });
        signal?.addEventListener("abort", finish, { once: true });
      });
    }
  }

  async function ownedRead(
    input: ProgramConversationReadInput,
    signal?: AbortSignal,
  ): Promise<ProgramConversationReadResult> {
    const { conversationId } = input;
    assertOwnedScope(conversationId);
    const limit = input.limit ?? 20;
    const [status, authority] = await Promise.all([
      local.owner.conversationAdoptionStatus(conversationId),
      local.owner.currentAuthority(conversationId),
    ]);
    if (status.unavailableTransfer || authority.state !== "current") {
      throw new ProgramConversationError(
        "temporarily_unavailable",
        "目标本机对话正处于接管迁移中，请稍后重试",
        {
          retryable: true,
          exitCode: 3,
          details: { leafAuthorityState: authority.state },
        },
      );
    }
    if (status.deleted) {
      throw new ProgramConversationError(
        "target_deleted",
        `目标对话已被删除: ${conversationId}`,
        { retryable: false, exitCode: 1 },
      );
    }
    if (!status.hasDurableIdentity) {
      throw new ProgramConversationError(
        "not_found",
        `目标对话不存在: ${conversationId}`,
        { retryable: false, exitCode: 1 },
      );
    }

    let cursor: ConversationBodyCursor | undefined;
    if (input.before !== undefined) {
      const decoded = decodeProgramBodyCursor(
        input.before,
        "read-before",
        conversationId,
      );
      cursor = decoded.bodyCursor;
    }

    const recoveryPage = (
      req: Parameters<ConversationProtocolRuntime["recoveryPage"]>[0],
    ) => local.owner.recoveryPage(req);

    const recheckDeleted = async () => {
      try {
        const latest =
          await local.owner.conversationAdoptionStatus(conversationId);
        if (latest.deleted) {
          throw new ProgramConversationError(
            "target_deleted",
            `目标对话已被删除: ${conversationId}`,
            { retryable: false, exitCode: 1 },
          );
        }
      } catch (recheckErr) {
        if (recheckErr instanceof ProgramConversationError) throw recheckErr;
      }
    };

    const entries: ProgramConversationReadMessageEntry[] = [];
    const seenRuns = new Set<string>();
    let hasMore = false;
    let nextBefore: string | undefined;
    let usedBytes = 0;
    const budget = Math.floor(PROGRAM_SAFE_PAYLOAD_BUDGET_BYTES * 0.8);
    const prepareDeadline = Date.now() + 2_500;
    let resetRetried = false;

    for (;;) {
      let page: ConversationBodyPage;
      try {
        page = (await recoveryPage({
          conversationId,
          mode: "body-page",
          includeInputs: true,
          ...(cursor ? { cursor } : {}),
        })) as ConversationBodyPage;
      } catch (err) {
        if (err instanceof ProgramConversationError) throw err;
        if (isBodyCursorCoordinateError(err)) {
          throw new ProgramConversationError(
            "invalid_cursor",
            "正文游标位置与目标不匹配。",
            { retryable: false, exitCode: 1 },
          );
        }
        await recheckDeleted();
        if (
          cursor !== undefined &&
          err instanceof Error &&
          /^conversation-history-/u.test(err.message)
        ) {
          throw new ProgramConversationError(
            "cursor_expired",
            "before 游标已失效，请从头重读",
            { retryable: true, exitCode: 3 },
          );
        }
        throw new ProgramConversationError(
          "temporarily_unavailable",
          `对话历史当前暂不可读，请稍后重试: ${err instanceof Error ? err.message : String(err)}`,
          { retryable: true, exitCode: 3 },
        );
      }

      if (page.reset) {
        if (input.before !== undefined || entries.length > 0) {
          throw new ProgramConversationError(
            "cursor_expired",
            "历史分页游标已因权威换代或清空失效，请从头重读",
            { retryable: true, exitCode: 3 },
          );
        }
        if (!resetRetried) {
          resetRetried = true;
          cursor = undefined;
          continue;
        }
        throw new ProgramConversationError(
          "temporarily_unavailable",
          "目标对话正在换代或清空同步中，请稍后重试",
          { retryable: true, exitCode: 3 },
        );
      }

      if (page.preparing && page.fragments.length === 0) {
        if (entries.length > 0 && cursor) {
          hasMore = true;
          nextBefore = encodeProgramBodyCursor({
            v: 1,
            kind: "read-before",
            bodyCursor: cursor,
          });
          break;
        }
        if (Date.now() >= prepareDeadline || signal?.aborted) {
          throw new ProgramConversationError(
            "temporarily_unavailable",
            "对话历史索引正在准备中，请稍后重试",
            { retryable: true, exitCode: 3 },
          );
        }
        cursor = page.cursor;
        await delayWithSignal(25, signal);
        continue;
      }

      let stoppedMidPage = false;
      let lastConsumedFragmentCursor: ConversationBodyCursor | undefined;
      for (let i = 0; i < page.fragments.length; i += 1) {
        const frag: ConversationBodyFragment = page.fragments[i]!;
        if (!seenRuns.has(frag.runId) && seenRuns.size >= limit) {
          hasMore = true;
          const resumeAt = lastConsumedFragmentCursor ?? cursor ?? frag.cursor;
          nextBefore = encodeProgramBodyCursor({
            v: 1,
            kind: "read-before",
            bodyCursor: resumeAt,
          });
          stoppedMidPage = true;
          break;
        }
        const displayText = frag.material
          ? formatPersistedFileMaterial(frag.material)
          : frag.tool
            ? frag.tool.kind === "call"
              ? `[tool_use:${frag.tool.name}]`
              : `[tool_result:${frag.tool.call?.name ?? "tool"}]`
            : frag.text;
        const mapped: ProgramConversationReadMessageEntry = {
          runId: frag.runId,
          runIndex: frag.runIndex,
          messageIndex: frag.message,
          blockIndex: frag.block,
          role: frag.role,
          type: frag.type,
          text: displayText,
          offset: frag.offset,
          length: frag.material || frag.tool ? displayText.length : frag.length,
          final: frag.final,
          ...(frag.sourceConversationId
            ? { sourceConversationId: frag.sourceConversationId }
            : {}),
          ...(frag.programOrigin ? { programOrigin: true } : {}),
        };
        const itemBytes = Buffer.byteLength(JSON.stringify(mapped), "utf8");
        if (entries.length > 0 && usedBytes + itemBytes > budget) {
          hasMore = true;
          const resumeAt = lastConsumedFragmentCursor ?? cursor ?? frag.cursor;
          nextBefore = encodeProgramBodyCursor({
            v: 1,
            kind: "read-before",
            bodyCursor: resumeAt,
          });
          stoppedMidPage = true;
          break;
        }
        seenRuns.add(frag.runId);
        entries.push(mapped);
        usedBytes += itemBytes;
        lastConsumedFragmentCursor = frag.cursor;
      }

      if (stoppedMidPage) break;
      if (!page.hasMore || !page.cursor) {
        hasMore = false;
        break;
      }
      cursor = page.cursor;
    }

    const orderedEntries = [...entries].reverse();
    let inputsOutsideHistory: ProgramConversationPendingInputEntry[] = [];
    let inputsOutsideHistoryTruncated = false;
    if (input.before === undefined) {
      let outside: {
        readonly inputs: readonly import("@zhixing-ai/core/conversation/application").ConversationMessageStatus[];
        readonly truncated: boolean;
      };
      try {
        outside =
          await local.owner.communicationMessages.inputsOutsideHistory(
            conversationId,
          );
      } catch (err) {
        if (err instanceof ProgramConversationError) throw err;
        if (isBodyCursorCoordinateError(err)) {
          throw new ProgramConversationError(
            "invalid_cursor",
            "正文游标位置与目标不匹配。",
            { retryable: false, exitCode: 1 },
          );
        }
        await recheckDeleted();
        throw new ProgramConversationError(
          "temporarily_unavailable",
          `待处理消息当前暂不可读，请稍后重试: ${err instanceof Error ? err.message : String(err)}`,
          { retryable: true, exitCode: 3 },
        );
      }
      inputsOutsideHistoryTruncated = outside.truncated;
      const remaining = PROGRAM_SAFE_PAYLOAD_BUDGET_BYTES - usedBytes;
      let outsideBytes = 0;
      for (const item of outside.inputs) {
        const sourceId =
          item.message.inputIdentity?.source.kind === "conversation"
            ? item.message.inputIdentity.source.conversationId
            : undefined;
        const mapped: ProgramConversationPendingInputEntry = {
          runId: item.runId,
          state: item.state,
          consumed: item.consumed,
          disposition: item.disposition,
          text: extractText(item.message),
          ...(sourceId ? { sourceConversationId: sourceId } : {}),
          ...(item.programOrigin ? { programOrigin: true } : {}),
        };
        const bytes = Buffer.byteLength(JSON.stringify(mapped), "utf8");
        if (outsideBytes + bytes > remaining) {
          inputsOutsideHistoryTruncated = true;
          break;
        }
        outsideBytes += bytes;
        inputsOutsideHistory.push(mapped);
      }
    }

    return {
      v: 1,
      conversationId,
      scope: "local",
      entries: orderedEntries,
      inputsOutsideHistory,
      inputsOutsideHistoryTruncated,
      hasMore,
      ...(hasMore && nextBefore ? { nextBefore } : {}),
    };
  }

  return Object.freeze({
    ownedList,
    ownedProbe,
    ownedRead,
    ownedSend,
    ownedResult,
  });
}

export function createExecutorProgramConversationApplication(options: {
  readonly deviceId: string;
  readonly currentAnchorDeviceId: () => string;
  readonly local: HostLocalProgramDeps;
  readonly anchorRemote: () => ProgramConversationEntryRemotePort | undefined;
  readonly isAnchorReachable?: () => boolean;
}): ExecutorProgramConversationController {
  const localOwned = createLocalOwnedProgramConversationHandler({
    deviceId: options.deviceId,
    local: options.local,
  });

  function anchorOrThrow(): ProgramConversationEntryRemotePort {
    if (options.isAnchorReachable?.() === false) {
      throw new ProgramConversationError(
        "temporarily_unavailable",
        "当值主控设备暂不可达，请稍后重试",
        { retryable: true, exitCode: 3 },
      );
    }
    const remote = options.anchorRemote();
    if (!remote) {
      throw new ProgramConversationError(
        "temporarily_unavailable",
        "当值主控设备暂不可达，请稍后重试",
        { retryable: true, exitCode: 3 },
      );
    }
    return remote;
  }

  function matchesSelfLocalPrefix(conversationId: string): boolean {
    if (!isLocalConversationId(conversationId)) return false;
    try {
      assertLocalConversationIdForDevice(conversationId, options.deviceId);
      return true;
    } catch {
      return false;
    }
  }

  async function resolvePureExecutorDecision(
    conversationId: string,
  ): Promise<"local" | "anchor"> {
    try {
      parseConversationId(conversationId);
    } catch {
      throw new ProgramConversationError(
        "not_found",
        `目标对话不存在: ${conversationId}`,
        { retryable: false, exitCode: 1 },
      );
    }
    if (!matchesSelfLocalPrefix(conversationId)) {
      return "anchor";
    }
    const [status, authority] = await Promise.all([
      options.local.owner.conversationAdoptionStatus(conversationId),
      options.local.owner.currentAuthority(conversationId),
    ]);
    if (
      status.unavailableTransfer ||
      authority.state === "frozen" ||
      authority.state === "importing"
    ) {
      throw new ProgramConversationError(
        "temporarily_unavailable",
        "目标本机对话正处于接管迁移中，请保留票据稍后重试",
        { retryable: true, exitCode: 3 },
      );
    }
    if (authority.state === "current" && (status.hasDurableIdentity || status.deleted)) {
      return "local";
    }
    // Either `fenced` (transferred to Anchor) or no positive local record (may live on Anchor or same-prefix peer):
    return "anchor";
  }

  async function listLocalFallback(
    input: ProgramConversationListInput,
    signal?: AbortSignal,
  ): Promise<ProgramConversationListResult> {
    const scope = input.scope ?? "all";
    const anchorId = options.currentAnchorDeviceId();
    const sources: DirectorySourceProvider[] = [
      {
        sourceId: `anchor:${anchorId}`,
        readPage: async () => ({
          sourceId: `anchor:${anchorId}`,
          reachable: false,
          unreachableDeviceId: anchorId,
          records: [],
          hasMore: false,
        }),
      },
    ];
    if (scope === "all" || scope === "local") {
      const localSourceId = `local:${options.deviceId}`;
      const richById = new Map<string, OwnedRichMetadata>();
      let lastQuery = "";
      sources.unshift({
        sourceId: localSourceId,
        enrichConversation: async (candidate) => {
          const rich = richById.get(candidate.conversationId);
          return {
            entryKind: "conversation",
            canonicalKey: candidate.canonicalKey,
            conversationId: candidate.conversationId,
            scope: "local",
            name: candidate.name,
            active: rich?.active ?? false,
            busy: rich?.busy ?? false,
            pendingCount: rich?.pendingCount ?? 0,
            ...(rich?.advancementStatus
              ? { advancementStatus: rich.advancementStatus }
              : {}),
            summary: rich?.summary ?? "",
            summaryTruncated: rich?.summaryTruncated ?? false,
            lastActiveAt: candidate.lastActiveAt,
          };
        },
        recheckVersion: async (sig) =>
          (
            await localOwned.ownedList(
              { ...(lastQuery ? { query: lastQuery } : {}), limit: 1 },
              sig,
            )
          ).version,
        readPage: async (req) => {
          lastQuery = req.query;
          const res = await localOwned.ownedList(
            {
              ...(req.query ? { query: req.query } : {}),
              limit: req.limit,
              ...(req.after
                ? {
                    after: {
                      lastActiveAt: req.after.lastActiveAt,
                      canonicalKey: req.after.conversationId,
                    },
                  }
                : {}),
            },
            req.signal,
          );
          for (const item of res.records) {
            richById.set(item.candidate.conversationId, item.rich);
          }
          return {
            sourceId: localSourceId,
            reachable: true,
            records: res.records.map((r) => ({
              ...r.candidate,
              ownerSourceId: localSourceId,
            })),
            hasMore: res.hasMore,
            version: res.version,
          };
        },
      });
    }
    return coordinateConversationDirectoryPage({
      request: input,
      sources,
      ...(signal ? { signal } : {}),
    });
  }

  async function list(
    input: ProgramConversationListInput,
    signal?: AbortSignal,
  ): Promise<ProgramConversationListResult> {
    if (options.isAnchorReachable?.() === false) {
      return listLocalFallback(input, signal);
    }
    const remote = options.anchorRemote();
    if (!remote) {
      return listLocalFallback(input, signal);
    }
    try {
      return await remote.list(input, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      if (
        err instanceof ProgramConversationError &&
        (err.code === "temporarily_unavailable" || err.code === "unknown")
      ) {
        return listLocalFallback(input, signal);
      }
      throw err;
    }
  }

  async function create(
    input: ProgramConversationNewInput,
    signal?: AbortSignal,
  ): Promise<ProgramConversationNewResult> {
    return anchorOrThrow().create(input, signal);
  }

  async function read(
    input: ProgramConversationReadInput,
    signal?: AbortSignal,
  ): Promise<ProgramConversationReadResult> {
    const decision = await resolvePureExecutorDecision(input.conversationId);
    if (decision === "local") {
      return localOwned.ownedRead(input, signal);
    }
    return anchorOrThrow().read(input, signal);
  }

  async function send(
    input: ProgramConversationSendInput,
    signal?: AbortSignal,
  ): Promise<ProgramConversationSendResult> {
    const decision = await resolvePureExecutorDecision(input.conversationId);
    if (decision === "local") {
      return localOwned.ownedSend(input, signal);
    }
    return anchorOrThrow().send(input, signal);
  }

  async function result(
    input: ProgramConversationResultInput,
    signal?: AbortSignal,
  ): Promise<ProgramConversationResultOutput> {
    if (input.cursor !== undefined) {
      decodeProgramBodyCursor(
        input.cursor,
        "result-answer",
        input.conversationId,
      );
    }
    const startMs = Date.now();
    let decision: "local" | "anchor";
    try {
      decision = await resolvePureExecutorDecision(input.conversationId);
    } catch (err) {
      if (
        err instanceof ProgramConversationError &&
        err.code === "temporarily_unavailable"
      ) {
        return {
          v: 1,
          state: "temporarily_unavailable",
          conversationId: input.conversationId,
          requestId: input.requestId,
          error: {
            code: "temporarily_unavailable",
            message: err.message,
            retryable: true,
          },
        };
      }
      if (err instanceof ProgramConversationError && err.code === "not_found") {
        return {
          v: 1,
          state: "unknown",
          conversationId: input.conversationId,
          requestId: input.requestId,
          error: {
            code: "unknown",
            message: "尚未在当前权威查到该请求的入账记录",
            retryable: true,
          },
        };
      }
      throw err;
    }

    if (decision === "local") {
      const remainingWaitMs = Math.max(
        0,
        Math.min(PROGRAM_MAX_WAIT_SLICE_MS, (input.waitMs ?? 0) - (Date.now() - startMs)),
      );
      try {
        return await localOwned.ownedResult(
          { ...input, waitMs: remainingWaitMs },
          signal,
        );
      } catch (err) {
        if (
          err instanceof ProgramConversationError &&
          err.options?.details?.leafAuthorityState === "fenced"
        ) {
          decision = "anchor";
        } else if (isDeterministicCallerProgramError(err)) {
          throw err;
        } else if (err instanceof ProgramConversationError) {
          return {
            v: 1,
            state: "temporarily_unavailable",
            conversationId: input.conversationId,
            requestId: input.requestId,
            error: {
              code: err.code,
              message: err.message,
              retryable: err.options?.retryable === true,
            },
          };
        } else {
          throw err;
        }
      }
    }

    let remote: ProgramConversationEntryRemotePort;
    try {
      remote = anchorOrThrow();
    } catch (err) {
      return {
        v: 1,
        state: "temporarily_unavailable",
        conversationId: input.conversationId,
        requestId: input.requestId,
        error: {
          code: "temporarily_unavailable",
          message: err instanceof Error ? err.message : String(err),
          retryable: true,
        },
      };
    }
    const remainingWaitMs = Math.max(
      0,
      Math.min(PROGRAM_MAX_WAIT_SLICE_MS, (input.waitMs ?? 0) - (Date.now() - startMs)),
    );
    try {
      return await remote.result(
        { ...input, waitMs: remainingWaitMs },
        signal,
      );
    } catch (err) {
      if (isDeterministicCallerProgramError(err)) {
        throw err;
      }
      return {
        v: 1,
        state:
          err instanceof ProgramConversationError && err.code === "unknown"
            ? "unknown"
            : "temporarily_unavailable",
        conversationId: input.conversationId,
        requestId: input.requestId,
        error: {
          code:
            err instanceof ProgramConversationError
              ? err.code
              : "temporarily_unavailable",
          message: err instanceof Error ? err.message : String(err),
          retryable:
            err instanceof ProgramConversationError
              ? err.options?.retryable === true
              : true,
        },
      };
    }
  }

  return Object.freeze({
    localOwned,
    list,
    create,
    read,
    send,
    result,
    discoverInternal: async (input: ProgramConversationListInput, signal?: AbortSignal) =>
      projectEntriesForInternalDiscover(await list(input, signal)),
  });
}

export function createHostProgramConversationApplication(
  options: CreateHostProgramConversationOptions,
): HostProgramConversationController {
  const { anchor, localExecutor, topology } = options;
  const creationGate = new SerialTaskQueue();

  const recordActivity = () => {
    anchor.onAdmissionActivity?.();
    localExecutor?.onAdmissionActivity?.();
  };

  async function summarizeConversation(
    conversationId: string,
    ownerKind: "anchor" | "local",
  ): Promise<{ readonly summary: string; readonly summaryTruncated: boolean }> {
    try {
      const recoveryPage =
        ownerKind === "local" && localExecutor
          ? (req: Parameters<ConversationProtocolRuntime["recoveryPage"]>[0]) =>
              localExecutor.owner.recoveryPage(req)
          : (req: Parameters<ConversationProtocolRuntime["recoveryPage"]>[0]) =>
              anchor.protocol.recoveryPage(req);
      const page = (await recoveryPage({
        conversationId,
        mode: "body-page",
        includeInputs: true,
      })) as ConversationBodyPage;
      for (const fragment of page.fragments) {
        if (fragment.type === "text" && fragment.text.trim().length > 0) {
          return collapseSummaryLine(fragment.text);
        }
      }
    } catch {
      // Fall back to empty summary if conversation has 0 runs or is preparing.
    }
    return { summary: "", summaryTruncated: false };
  }

  function buildDirectorySources(
    scope: NonNullable<ProgramConversationListInput["scope"]>,
  ): readonly DirectorySourceProvider[] {
    const sources: DirectorySourceProvider[] = [];

    const readOpenAdvancementStatus = async (
      conversationId: string,
      ownerKind: "anchor" | "local",
    ): Promise<string | undefined> => {
      try {
        const sessionState =
          ownerKind === "local" && localExecutor
            ? localExecutor.owner.sessionState
            : anchor.protocol.sessionState;
        const adv = await sessionState.readAdvancementState(conversationId, {
          principal: { kind: "host", component: "program-directory" },
          requestId: `program-adv:${conversationId}`,
          deadlineAt: new Date(Date.now() + 10_000).toISOString(),
        });
        return adv && isOpenAdvancementSession(adv) ? adv.status : undefined;
      } catch {
        return undefined;
      }
    };

    const enrichAnchorConversation = async (
      candidate: Extract<RawDirectoryCandidate, { entryKind: "conversation" }>,
    ): Promise<ProgramConversationExistingEntry> => {
      const [snippet, advancementStatus] = await Promise.all([
        summarizeConversation(candidate.conversationId, "anchor"),
        readOpenAdvancementStatus(candidate.conversationId, "anchor"),
      ]);
      return {
        entryKind: "conversation",
        canonicalKey: candidate.canonicalKey,
        conversationId: candidate.conversationId,
        scope: candidate.scope,
        name: candidate.name,
        ...(candidate.sceneId ? { sceneId: candidate.sceneId } : {}),
        ...(candidate.sceneName ? { sceneName: candidate.sceneName } : {}),
        ...(candidate.workspaceLabel
          ? { workspaceLabel: candidate.workspaceLabel }
          : {}),
        active: anchor.manager.has(candidate.conversationId),
        busy: anchor.manager.getSession(candidate.conversationId)?.busy ?? false,
        pendingCount: anchor.manager.pendingCount(candidate.conversationId),
        ...(advancementStatus ? { advancementStatus } : {}),
        summary: snippet.summary,
        summaryTruncated: snippet.summaryTruncated,
        lastActiveAt: candidate.lastActiveAt,
      };
    };

    if (scope === "all" || scope === "main" || scope === "channel") {
      const scopeFilter =
        scope === "main" || scope === "channel" ? scope : undefined;
      const sourceId = "anchor:user";
      let lastQuery = "";
      sources.push({
        sourceId,
        enrichConversation: enrichAnchorConversation,
        recheckVersion: async () => {
          const check = await anchor.directory.listPage!({
            limit: 1,
            includeVersion: true,
            ...(lastQuery ? { query: lastQuery } : {}),
            ...(scopeFilter ? { scopeFilter } : {}),
          });
          return check.version;
        },
        readPage: async (req) => {
          lastQuery = req.query;
          const page = await anchor.directory.listPage!({
            limit: req.limit,
            includeVersion: true,
            ...(req.after ? { after: req.after } : {}),
            ...(req.query ? { query: req.query } : {}),
            ...(scopeFilter ? { scopeFilter } : {}),
          });
          const records: RawDirectoryCandidate[] = page.records.map((conv) => ({
            entryKind: "conversation",
            canonicalKey: conv.conversationId,
            conversationId: conv.conversationId,
            scope: classifyConversationDirectoryScope(conv.conversationId),
            name: conv.name,
            lastActiveAt: conv.lastActiveAt,
            ownerSourceId: sourceId,
          }));
          if (!page.version) {
            throw new ProgramConversationError(
              "temporarily_unavailable",
              "用户对话目录版本证据暂不可用",
              { retryable: true, exitCode: 3 },
            );
          }
          return {
            sourceId,
            reachable: true,
            records,
            hasMore: page.next !== undefined,
            version: page.version,
          };
        },
      });
    }

    if (scope === "all" || scope === "workscene") {
      const sourceId = "anchor:workscenes";
      const loadWorksceneItems = async (query: string) => {
        const listed = await anchor.workscenes.query(
          WORKSCENE_MANAGEMENT_LIST_QUERY,
          { kind: "list" },
        );
        const allVisible: Array<
          RawDirectoryCandidate & {
            readonly conversationId: string;
            readonly name: string;
          }
        > = [];
        for (const scene of listed.scenes) {
          const primaryGlobalId = worksceneConversationId(
            scene.sceneId,
            "primary",
          );
          const sceneConvs =
            await anchor.directory.listWorksceneConversations(scene.sceneId);
          const workspaceLabel =
            scene.workspace?.workspaceName ?? scene.workspace?.bindingRef;
          let hasPrimary = false;
          for (const conv of sceneConvs) {
            const globalId = conv.conversationId;
            if (conv.localId === "primary") hasPrimary = true;
            const displayName =
              conv.localId === "primary" && conv.name === "primary"
                ? scene.name
                : conv.name;
            if (
              !matchesDirectoryQuery(query, [
                globalId,
                scene.sceneId,
                scene.name,
                displayName,
              ])
            ) {
              continue;
            }
            allVisible.push({
              entryKind: "conversation",
              canonicalKey: globalId,
              conversationId: globalId,
              scope: "workscene",
              name: displayName,
              sceneId: scene.sceneId,
              sceneName: scene.name,
              ...(workspaceLabel ? { workspaceLabel } : {}),
              lastActiveAt: conv.lastActiveAt,
              ownerSourceId: sourceId,
            });
          }
          if (!hasPrimary) {
            if (
              matchesDirectoryQuery(query, [
                primaryGlobalId,
                scene.sceneId,
                scene.name,
              ])
            ) {
              const candidateLastActiveAt =
                scene.lastActiveAt ?? "1970-01-01T00:00:00.000Z";
              allVisible.push({
                entryKind: "workscene-candidate",
                canonicalKey: primaryGlobalId,
                conversationId: primaryGlobalId,
                scope: "workscene",
                sceneId: scene.sceneId,
                sceneName: scene.name,
                name: scene.name,
                ...(workspaceLabel ? { workspaceLabel } : {}),
                initialized: false,
                lastActiveAt: candidateLastActiveAt,
                ownerSourceId: sourceId,
              });
            }
          }
        }
        const version: ConversationDirectorySourceVersion = {
          kind: "direct" as const,
          entriesDigest: computeDirectoryEntriesDigest(
            allVisible.map((item) => ({
              canonicalKey: item.canonicalKey,
              lastActiveAt: item.lastActiveAt,
              name: `${item.entryKind}:${item.name}`,
            })),
          ),
        };
        return { allVisible, version };
      };
      let lastWsQuery = "";
      sources.push({
        sourceId,
        enrichConversation: enrichAnchorConversation,
        recheckVersion: async () => (await loadWorksceneItems(lastWsQuery)).version,
        readPage: async (req) => {
          lastWsQuery = req.query;
          const { allVisible, version } = await loadWorksceneItems(req.query);
          const collector = new ConversationDirectoryPageCollector<
            (typeof allVisible)[number]
          >({
            limit: req.limit,
            ...(req.after ? { after: req.after } : {}),
          });
          for (const item of allVisible) {
            collector.add(item);
          }
          const page = collector.result();
          return {
            sourceId,
            reachable: true,
            records: page.records,
            hasMore: page.next !== undefined,
            version,
          };
        },
      });
    }

    if (scope === "all" || scope === "local") {
      const adoptedSourceId = "anchor:adopted-local";
      const loadAdoptedItems = async (query: string) => {
        const adoptedIds = await anchor.protocol.listAdoptedConversationIds();
        const items: Array<
          Extract<RawDirectoryCandidate, { entryKind: "conversation" }>
        > = [];
        for (const id of adoptedIds) {
          if (!isLocalConversationId(id)) continue;
          const status = await anchor.protocol.conversationAdoptionStatus(id);
          if (status.unavailableTransfer || status.deleted) continue;
          const meta = await anchor.protocol.sessionState.readSessionMeta(id, {
            principal: { kind: "host", component: "program-directory" },
            requestId: `program-dir:${id}`,
            deadlineAt: new Date(Date.now() + 30_000).toISOString(),
          });
          const name = meta.name ?? id;
          if (!matchesDirectoryQuery(query, [id, name])) continue;
          items.push({
            entryKind: "conversation",
            canonicalKey: id,
            conversationId: id,
            scope: "local",
            name,
            lastActiveAt: meta.lastActiveAt,
            ownerSourceId: adoptedSourceId,
          });
        }
        const version: ConversationDirectorySourceVersion = {
          kind: "direct" as const,
          entriesDigest: computeDirectoryEntriesDigest(
            items.map((item) => ({
              canonicalKey: item.canonicalKey,
              lastActiveAt: item.lastActiveAt,
              name: item.name,
            })),
          ),
        };
        return { items, version };
      };
      let lastAdoptedQuery = "";
      sources.push({
        sourceId: adoptedSourceId,
        enrichConversation: enrichAnchorConversation,
        recheckVersion: async () =>
          (await loadAdoptedItems(lastAdoptedQuery)).version,
        readPage: async (req) => {
          lastAdoptedQuery = req.query;
          const { items, version } = await loadAdoptedItems(req.query);
          const collector = new ConversationDirectoryPageCollector<
            (typeof items)[number]
          >({
            limit: req.limit,
            ...(req.after ? { after: req.after } : {}),
          });
          for (const item of items) collector.add(item);
          const page = collector.result();
          return {
            sourceId: adoptedSourceId,
            reachable: true,
            records: page.records,
            hasMore: page.next !== undefined,
            version,
          };
        },
      });

      if (localExecutor) {
        const localSourceId = `local:${topology?.deviceId ?? anchor.protocol.deviceId}`;
        const loadLocalItems = async (query: string) => {
          const adoptedSet = new Set(
            await anchor.protocol.listAdoptedConversationIds(),
          );
          const authorities =
            await localExecutor.owner.listConversationAuthorities();
          const items: Array<
            Extract<RawDirectoryCandidate, { entryKind: "conversation" }>
          > = [];
          for (const { conversationId, authority } of authorities) {
            if (authority.state !== "current" || adoptedSet.has(conversationId)) {
              continue;
            }
            const meta =
              await localExecutor.owner.sessionState.readSessionMeta(
                conversationId,
                {
                  principal: {
                    kind: "host",
                    component: "program-local-directory",
                  },
                  requestId: `program-local-dir:${conversationId}`,
                  deadlineAt: new Date(Date.now() + 30_000).toISOString(),
                },
              );
            const name = meta.name ?? conversationId;
            if (!matchesDirectoryQuery(query, [conversationId, name])) {
              continue;
            }
            items.push({
              entryKind: "conversation",
              canonicalKey: conversationId,
              conversationId,
              scope: "local",
              name,
              lastActiveAt: meta.lastActiveAt,
              ownerSourceId: localSourceId,
            });
          }
          const version: ConversationDirectorySourceVersion = {
            kind: "direct" as const,
            entriesDigest: computeDirectoryEntriesDigest(
              items.map((item) => ({
                canonicalKey: item.canonicalKey,
                lastActiveAt: item.lastActiveAt,
                name: item.name,
              })),
            ),
          };
          return { items, version };
        };
        let lastLocalQuery = "";
        sources.push({
          sourceId: localSourceId,
          enrichConversation: async (candidate) => {
            const rt = localExecutor.owner.runtimeState(candidate.conversationId);
            const [snippet, advancementStatus] = await Promise.all([
              summarizeConversation(candidate.conversationId, "local"),
              readOpenAdvancementStatus(candidate.conversationId, "local"),
            ]);
            return {
              entryKind: "conversation",
              canonicalKey: candidate.canonicalKey,
              conversationId: candidate.conversationId,
              scope: "local",
              name: candidate.name,
              active: rt.active,
              busy: rt.busy,
              pendingCount: rt.pendingCount,
              ...(advancementStatus ? { advancementStatus } : {}),
              summary: snippet.summary,
              summaryTruncated: snippet.summaryTruncated,
              lastActiveAt: candidate.lastActiveAt,
            };
          },
          recheckVersion: async () =>
            (await loadLocalItems(lastLocalQuery)).version,
          readPage: async (req) => {
            lastLocalQuery = req.query;
            const { items, version } = await loadLocalItems(req.query);
            const collector = new ConversationDirectoryPageCollector<
              (typeof items)[number]
            >({
              limit: req.limit,
              ...(req.after ? { after: req.after } : {}),
            });
            for (const item of items) collector.add(item);
            const page = collector.result();
            return {
              sourceId: localSourceId,
              reachable: true,
              records: page.records,
              hasMore: page.next !== undefined,
              version,
            };
          },
        });
      }

      if (topology?.currentTrust) {
        const selfId = topology.deviceId;
        for (const member of topology.currentTrust().members) {
          if (
            member.state === "active" &&
            member.roles.includes("executor") &&
            member.device.deviceId !== selfId
          ) {
            const remoteDeviceId = member.device.deviceId;
            const remoteSourceId = `remote:${remoteDeviceId}`;
            const richById = new Map<string, OwnedRichMetadata>();
            let lastRemoteQuery = "";
            sources.push({
              sourceId: remoteSourceId,
              enrichConversation: async (candidate) => {
                const rich = richById.get(candidate.conversationId);
                return {
                  entryKind: "conversation",
                  canonicalKey: candidate.canonicalKey,
                  conversationId: candidate.conversationId,
                  scope: "local",
                  name: candidate.name,
                  active: rich?.active ?? false,
                  busy: rich?.busy ?? false,
                  pendingCount: rich?.pendingCount ?? 0,
                  ...(rich?.advancementStatus
                    ? { advancementStatus: rich.advancementStatus }
                    : {}),
                  summary: rich?.summary ?? "",
                  summaryTruncated: rich?.summaryTruncated ?? false,
                  lastActiveAt: candidate.lastActiveAt,
                };
              },
              recheckVersion: async (sig) => {
                const remotePort = topology.remoteOwnedFor?.(remoteDeviceId);
                if (!remotePort) return undefined;
                try {
                  const res = await remotePort.ownedList(
                    {
                      ...(lastRemoteQuery ? { query: lastRemoteQuery } : {}),
                      limit: 1,
                    },
                    sig,
                  );
                  return res.version;
                } catch (err) {
                  if (sig?.aborted) throw err;
                  return undefined;
                }
              },
              readPage: async (req) => {
                lastRemoteQuery = req.query;
                const remotePort = topology.remoteOwnedFor?.(remoteDeviceId);
                if (!remotePort) {
                  return {
                    sourceId: remoteSourceId,
                    reachable: false,
                    unreachableDeviceId: remoteDeviceId,
                    records: [],
                    hasMore: false,
                  };
                }
                try {
                  const adoptedSet = new Set(
                    await anchor.protocol.listAdoptedConversationIds(),
                  );
                  const res = await remotePort.ownedList(
                    {
                      ...(req.query ? { query: req.query } : {}),
                      limit: req.limit,
                      ...(req.after
                        ? {
                            after: {
                              lastActiveAt: req.after.lastActiveAt,
                              canonicalKey: req.after.conversationId,
                            },
                          }
                        : {}),
                    },
                    req.signal,
                  );
                  const records: Array<
                    Extract<RawDirectoryCandidate, { entryKind: "conversation" }>
                  > = [];
                  for (const item of res.records) {
                    if (adoptedSet.has(item.candidate.conversationId)) continue;
                    richById.set(item.candidate.conversationId, item.rich);
                    records.push({
                      ...item.candidate,
                      ownerSourceId: remoteSourceId,
                    });
                  }
                  return {
                    sourceId: remoteSourceId,
                    reachable: true,
                    records,
                    hasMore: res.hasMore,
                    version: res.version,
                  };
                } catch (err) {
                  if (req.signal?.aborted) throw err;
                  return {
                    sourceId: remoteSourceId,
                    reachable: false,
                    unreachableDeviceId: remoteDeviceId,
                    records: [],
                    hasMore: false,
                  };
                }
              },
            });
          }
        }
      }
    }

    return sources;
  }

  async function list(
    input: ProgramConversationListInput,
    signal?: AbortSignal,
  ): Promise<ProgramConversationListResult> {
    const effectiveScope = input.scope ?? "all";
    const sources = buildDirectorySources(effectiveScope);
    return coordinateConversationDirectoryPage({
      request: input,
      sources,
      ...(signal ? { signal } : {}),
    });
  }

  async function createForPrincipal(
    creatorPrincipal: string,
    input: ProgramConversationNewInput,
    _signal?: AbortSignal,
  ): Promise<ProgramConversationNewResult> {
    if (!isProtocolIdentifier(input.requestId)) {
      throw new ProgramConversationError(
        "invalid_params",
        "requestId 必须是非空合法标识",
        { retryable: false, exitCode: 1 },
      );
    }
    if (input.name !== undefined && input.sceneId !== undefined) {
      throw new ProgramConversationError(
        "invalid_params",
        "--name 与 --scene 互斥，不能同时指定",
        { retryable: false, exitCode: 1 },
      );
    }
    const normalizedName =
      input.name !== undefined ? input.name.trim() : undefined;
    if (input.name !== undefined && !normalizedName) {
      throw new ProgramConversationError(
        "invalid_params",
        "name 必须是非空字符串",
        { retryable: false, exitCode: 1 },
      );
    }
    const sceneId = input.sceneId;
    if (sceneId !== undefined && !isProtocolIdentifier(sceneId)) {
      throw new ProgramConversationError(
        "invalid_params",
        "sceneId 必须是合法工作场景标识",
        { retryable: false, exitCode: 1 },
      );
    }

    return creationGate.run(async () => {
      const canonicalRequestId = `program-create:${protocolDigest(
        "ProgramConversationCreate",
        1,
        { creatorPrincipal, requestId: input.requestId },
      )}`;
      const source = {
        principal: {
          surfacePrincipal: creatorPrincipal,
          deviceId: anchor.protocol.deviceId,
          connectionId: creatorPrincipal,
        },
      };
      const nowIso = new Date().toISOString();
      const envelope = createInitialControlEnvelope({
        requestId: canonicalRequestId,
        source,
        at: nowIso,
        body: {
          t: "session-create",
          ...(normalizedName !== undefined
            ? { requestedName: normalizedName }
            : {}),
          ...(sceneId !== undefined ? { sceneId } : {}),
        },
      });

      const prior = await anchor.protocol.controlAdmission.lookup({
        envelope,
        source,
      });
      if (prior.kind === "settled") {
        if (
          prior.outcome.kind === "rejected" ||
          prior.outcome.result.status === "rejected"
        ) {
          throw new ProgramConversationError(
            "idempotency_conflict",
            "同一 requestId 已绑定不同的创建意图或模式",
            { retryable: false, exitCode: 1 },
          );
        }
        if (prior.outcome.result.body.t !== "session-create") {
          throw new Error("Unexpected session-create control result");
        }
      }

      if (anchor.isStopping?.() || anchor.protocol.isShuttingDown()) {
        throw new ProgramConversationError(
          "temporarily_unavailable",
          "宿主正在排空停机，请保留原 requestId 稍后重试",
          { retryable: true, exitCode: 3 },
        );
      }

      recordActivity();
      const tempObserverId = `program-create:${canonicalRequestId}`;

      if (sceneId !== undefined) {
        const scenes = await anchor.workscenes.query(
          WORKSCENE_MANAGEMENT_LIST_QUERY,
          { kind: "list" },
        );
        if (!scenes.scenes.some((s) => s.sceneId === sceneId)) {
          throw new ProgramConversationError(
            prior.kind === "settled" ? "target_deleted" : "not_found",
            prior.kind === "settled"
              ? `工作场景已被删除: ${sceneId}`
              : `工作场景不存在: ${sceneId}`,
            { retryable: false, exitCode: 1 },
          );
        }
        const wsConversationId =
          prior.kind === "settled" &&
          prior.outcome.kind !== "rejected" &&
          prior.outcome.result.status === "ok" &&
          prior.outcome.result.body.t === "session-create"
            ? prior.outcome.result.body.conversationId
            : worksceneConversationId(sceneId, "primary");
        const claimed = anchor.manager.addObserver(
          wsConversationId,
          tempObserverId,
          { allowInactive: true },
        );
        if (!claimed) {
          throw new ProgramConversationError(
            "temporarily_unavailable",
            `工作场景 ${sceneId} 正在变更或移除中，请保留原 requestId 稍后重试`,
            { retryable: true, exitCode: 3 },
          );
        }
        try {
          const status =
            await anchor.protocol.conversationAdoptionStatus(wsConversationId);
          if (status.unavailableTransfer) {
            throw new ProgramConversationError(
              "temporarily_unavailable",
              `工作场景主对话基底暂未就绪: ${wsConversationId}`,
              { retryable: true, exitCode: 3 },
            );
          }
          if (status.deleted) {
            throw new ProgramConversationError(
              "target_deleted",
              `工作场景主对话已被删除: ${wsConversationId}`,
              { retryable: false, exitCode: 1 },
            );
          }
          let created: boolean;
          if (
            prior.kind === "settled" &&
            prior.outcome.kind !== "rejected" &&
            prior.outcome.result.status === "ok"
          ) {
            created = prior.outcome.authorityRevision === 1;
          } else {
            const existingShell =
              await anchor.directory.getStoredConversation(wsConversationId);
            const alreadyExisted =
              existingShell !== null || status.hasDurableIdentity;
            const initialCreated = !alreadyExisted;
            const outcome = await anchor.protocol.controlAdmission.apply({
              envelope,
              source,
              prepare: () => ({
                result: {
                  v: 1,
                  status: "ok",
                  body: { t: "session-create", conversationId: wsConversationId },
                },
                authorityRevision: initialCreated ? 1 : 0,
              }),
            });
            if (
              outcome.kind === "rejected" ||
              outcome.result.status === "rejected"
            ) {
              throw new ProgramConversationError(
                "idempotency_conflict",
                "同一 requestId 已绑定不同的创建意图或模式",
                { retryable: false, exitCode: 1 },
              );
            }
            created = outcome.authorityRevision === 1;
          }
          await anchor.protocol.touchWorksceneSession({
            conversationId: wsConversationId,
            sceneId,
            requestId: canonicalRequestId,
            at: nowIso,
          });
          await anchor.directory.ensure(wsConversationId, { name: "primary" });
          return {
            v: 1,
            conversationId: wsConversationId,
            scope: "workscene",
            sceneId,
            created,
          };
        } finally {
          anchor.manager.removeObserver(wsConversationId, tempObserverId);
        }
      }

      let conversationId: string;
      let created: boolean;
      if (
        prior.kind === "settled" &&
        prior.outcome.kind !== "rejected" &&
        prior.outcome.result.status === "ok" &&
        prior.outcome.result.body.t === "session-create"
      ) {
        conversationId = prior.outcome.result.body.conversationId;
        created = prior.outcome.authorityRevision === 1;
      } else {
        let chosenId = "";
        for (let attempt = 0; attempt < 64; attempt += 1) {
          const candidate = deterministicMainCandidateId(
            normalizedName,
            canonicalRequestId,
            envelope.at,
            attempt,
          );
          const inRepo = await anchor.directory.getStoredConversation(candidate);
          const inControl =
            await anchor.protocol.controlAdmission.hasCreatedConversation(
              candidate,
            );
          if (!inRepo && !inControl) {
            chosenId = candidate;
            break;
          }
        }
        if (!chosenId) {
          throw new Error("Unable to allocate unique main conversation id");
        }

        const outcome = await anchor.protocol.controlAdmission.apply({
          envelope,
          source,
          prepare: () => ({
            result: {
              v: 1,
              status: "ok",
              body: { t: "session-create", conversationId: chosenId },
            },
            authorityRevision: 1,
          }),
        });
        if (outcome.kind === "rejected" || outcome.result.status === "rejected") {
          throw new ProgramConversationError(
            "idempotency_conflict",
            "同一 requestId 已绑定不同的创建意图或模式",
            { retryable: false, exitCode: 1 },
          );
        }
        if (outcome.result.body.t !== "session-create") {
          throw new Error("Unexpected session-create control result");
        }
        conversationId = outcome.result.body.conversationId;
        created = outcome.authorityRevision === 1;
      }

      if (!isSafeMainConversationId(conversationId)) {
        throw new ProgramConversationError(
          "invalid_params",
          `创建收据绑定的对话标识不属于普通主对话命名域: ${conversationId}`,
          { retryable: false, exitCode: 1 },
        );
      }

      const claimed = anchor.manager.addObserver(
        conversationId,
        tempObserverId,
        { allowInactive: true },
      );
      if (!claimed) {
        throw new ProgramConversationError(
          "temporarily_unavailable",
          `目标对话 ${conversationId} 正在变更或清理中，请保留原 requestId 稍后重试`,
          { retryable: true, exitCode: 3 },
        );
      }
      try {
        const adoption =
          await anchor.protocol.conversationAdoptionStatus(conversationId);
        if (adoption.unavailableTransfer) {
          throw new ProgramConversationError(
            "temporarily_unavailable",
            `目标对话基底暂未就绪: ${conversationId}`,
            { retryable: true, exitCode: 3 },
          );
        }
        if (adoption.deleted) {
          throw new ProgramConversationError(
            "target_deleted",
            `目标对话已被删除: ${conversationId}`,
            { retryable: false, exitCode: 1 },
          );
        }
        await anchor.protocol.ensureSession(conversationId);
        await anchor.directory.ensure(conversationId, {
          name: normalizedName ?? conversationId,
        });
        return {
          v: 1,
          conversationId,
          scope: "main",
          created,
        };
      } finally {
        anchor.manager.removeObserver(conversationId, tempObserverId);
      }
    });
  }

  type ResolvedOwner =
    | {
        readonly kind: "anchor";
        readonly adoption: Awaited<
          ReturnType<ConversationProtocolRuntime["conversationAdoptionStatus"]>
        >;
      }
    | {
        readonly kind: "local";
        readonly owner: LocalConversationOwnerPort;
        readonly adoption: Awaited<
          ReturnType<ConversationProtocolRuntime["conversationAdoptionStatus"]>
        >;
      }
    | {
        readonly kind: "remote";
        readonly deviceId: string;
        readonly remote: ProgramConversationOwnedRemotePort;
      };

  type InProcessResolvedOwner = Exclude<ResolvedOwner, { readonly kind: "remote" }>;

  async function resolveTargetOwner(
    conversationId: string,
    signal?: AbortSignal,
  ): Promise<ResolvedOwner> {
    let parsed: ReturnType<typeof parseConversationId>;
    try {
      parsed = parseConversationId(conversationId);
    } catch {
      throw new ProgramConversationError(
        "not_found",
        `目标对话不存在: ${conversationId}`,
        { retryable: false, exitCode: 1 },
      );
    }

    if (!isLocalConversationId(conversationId)) {
      const adoption =
        await anchor.protocol.conversationAdoptionStatus(conversationId);
      if (adoption.unavailableTransfer) {
        throw new ProgramConversationError(
          "temporarily_unavailable",
          "目标对话迁入基底尚未就绪，请稍后重试",
          { retryable: true, exitCode: 3 },
        );
      }
      if (parsed.scope.kind === "workscene") {
        const targetSceneId = parsed.scope.sceneId;
        const scenes = await anchor.workscenes.query(
          WORKSCENE_MANAGEMENT_LIST_QUERY,
          { kind: "list" },
        );
        const sceneExists = scenes.scenes.some(
          (s) => s.sceneId === targetSceneId,
        );
        if (!sceneExists && !adoption.hasDurableIdentity && !adoption.deleted) {
          throw new ProgramConversationError(
            "not_found",
            `工作场景对话不存在: ${conversationId}`,
            { retryable: false, exitCode: 1 },
          );
        }
      }
      return { kind: "anchor", adoption };
    }

    const anchorStatus =
      await anchor.protocol.conversationAdoptionStatus(conversationId);
    if (anchorStatus.unavailableTransfer) {
      throw new ProgramConversationError(
        "temporarily_unavailable",
        "目标本机对话迁入主控基底尚未就绪，请稍后重试",
        { retryable: true, exitCode: 3 },
      );
    }
    if (anchorStatus.adopted) {
      return { kind: "anchor", adoption: anchorStatus };
    }

    if (localExecutor) {
      const [localStatus, authority] = await Promise.all([
        localExecutor.owner.conversationAdoptionStatus(conversationId),
        localExecutor.owner.currentAuthority(conversationId),
      ]);
      if (
        localStatus.unavailableTransfer ||
        authority.state === "frozen" ||
        authority.state === "importing" ||
        authority.state === "fenced"
      ) {
        throw new ProgramConversationError(
          "temporarily_unavailable",
          "目标本机对话正处于接管迁移中，请稍后重试",
          { retryable: true, exitCode: 3 },
        );
      }
      if (localStatus.hasDurableIdentity || localStatus.deleted) {
        return {
          kind: "local",
          owner: localExecutor.owner,
          adoption: localStatus,
        };
      }
    }

    const selfDeviceId = topology?.deviceId ?? anchor.protocol.deviceId;
    if (!topology?.currentTrust) {
      throw new ProgramConversationError(
        "not_found",
        `目标对话不存在: ${conversationId}`,
        { retryable: false, exitCode: 1 },
      );
    }

    const matchingMembers = topology
      .currentTrust()
      .members.filter((member) => {
        try {
          assertLocalConversationIdForDevice(
            conversationId,
            member.device.deviceId,
          );
          return true;
        } catch {
          return false;
        }
      });

    if (matchingMembers.length === 0) {
      throw new ProgramConversationError(
        "not_found",
        `目标对话不存在: ${conversationId}`,
        { retryable: false, exitCode: 1 },
      );
    }

    if (
      matchingMembers.length === 1 &&
      matchingMembers[0]!.device.deviceId === selfDeviceId &&
      localExecutor !== undefined
    ) {
      throw new ProgramConversationError(
        "not_found",
        `目标对话不存在: ${conversationId}`,
        { retryable: false, exitCode: 1 },
      );
    }

    const remoteActiveExecutors = matchingMembers.filter(
      (member) =>
        member.device.deviceId !== selfDeviceId &&
        member.state === "active" &&
        member.roles.includes("executor"),
    );
    const nonActiveRemoteCandidates = matchingMembers.filter(
      (member) =>
        member.device.deviceId !== selfDeviceId &&
        member.state !== "active" &&
        member.roles.includes("executor"),
    );

    if (
      matchingMembers.length === 1 &&
      remoteActiveExecutors.length === 1 &&
      nonActiveRemoteCandidates.length === 0
    ) {
      const soleDeviceId = remoteActiveExecutors[0]!.device.deviceId;
      const remote = topology.remoteOwnedFor?.(soleDeviceId);
      if (!remote) {
        throw new ProgramConversationError(
          "temporarily_unavailable",
          "目标设备本地对话所在执行端当前离线，请保留票据稍后重试",
          { retryable: true, exitCode: 3 },
        );
      }
      return { kind: "remote", deviceId: soleDeviceId, remote };
    }

    if (remoteActiveExecutors.length === 0) {
      if (
        nonActiveRemoteCandidates.length === 0 &&
        matchingMembers.every(
          (m) => m.device.deviceId === selfDeviceId || !m.roles.includes("executor"),
        )
      ) {
        throw new ProgramConversationError(
          "not_found",
          `目标对话不存在: ${conversationId}`,
          { retryable: false, exitCode: 1 },
        );
      }
      throw new ProgramConversationError(
        "temporarily_unavailable",
        "目标设备本地对话所在执行端当前暂不可达，请保留票据稍后重试",
        { retryable: true, exitCode: 3 },
      );
    }

    // Multiple members share the same 8-char devicePrefix: run read-only positive ownership disambiguation!
    let anyUnreachableOrMigrating = nonActiveRemoteCandidates.length > 0;
    const positiveHolders: Array<{
      readonly deviceId: string;
      readonly remote: ProgramConversationOwnedRemotePort;
    }> = [];

    await Promise.all(
      remoteActiveExecutors.map(async (member) => {
        const remote = topology.remoteOwnedFor?.(member.device.deviceId);
        if (!remote) {
          anyUnreachableOrMigrating = true;
          return;
        }
        try {
          const probe = await remote.ownedProbe(conversationId, signal);
          if (probe.state === "migrating") {
            anyUnreachableOrMigrating = true;
          } else if (probe.state === "current" || probe.state === "deleted") {
            positiveHolders.push({
              deviceId: member.device.deviceId,
              remote,
            });
          }
        } catch (err) {
          if (signal?.aborted) throw err;
          anyUnreachableOrMigrating = true;
        }
      }),
    );

    if (anyUnreachableOrMigrating || positiveHolders.length > 1) {
      throw new ProgramConversationError(
        "temporarily_unavailable",
        "同前缀执行端存在离线或在途迁移状态，暂无法唯一确认对话归属，请保留票据稍后重试",
        { retryable: true, exitCode: 3 },
      );
    }
    if (positiveHolders.length === 0) {
      throw new ProgramConversationError(
        "not_found",
        `目标对话不存在: ${conversationId}`,
        { retryable: false, exitCode: 1 },
      );
    }
    return {
      kind: "remote",
      deviceId: positiveHolders[0]!.deviceId,
      remote: positiveHolders[0]!.remote,
    };
  }

  async function anchorConversationStoredExists(
    conversationId: string,
  ): Promise<boolean> {
    try {
      return await anchor.directory.exists(conversationId);
    } catch (err) {
      if (err instanceof ProgramConversationError) throw err;
      throw new ProgramConversationError(
        "temporarily_unavailable",
        `无法确认目标对话目录状态: ${err instanceof Error ? err.message : String(err)}`,
        { retryable: true, exitCode: 3 },
      );
    }
  }

  async function mapDurableAdmissionRejection(
    conversationId: string,
    requestId: string,
    err: DurableConversationAdmissionRejectedError,
    checkOpenAdvancement: () => Promise<boolean>,
    target: InProcessResolvedOwner,
  ): Promise<ProgramConversationSendResult> {
    if (err.code === "idempotency-conflict") {
      return {
        v: 1,
        admitted: false,
        conversationId,
        requestId,
        error: {
          code: "idempotency_conflict",
          message: err.message,
          retryable: false,
        },
      };
    }
    if (/does not bind the current conversation owner and ingress/iu.test(err.message)) {
      throw new ProgramConversationError(
        "temporarily_unavailable",
        "目标对话权威换代中，请保留票据稍后重试",
        { retryable: true, exitCode: 3 },
      );
    }
    const latestStatus = await (
      target.kind === "local"
        ? target.owner.conversationAdoptionStatus(conversationId)
        : anchor.protocol.conversationAdoptionStatus(conversationId)
    ).catch(() => undefined);
    if (latestStatus?.deleted || /deleted/iu.test(err.message)) {
      return {
        v: 1,
        admitted: false,
        conversationId,
        requestId,
        error: {
          code: "target_deleted",
          message: `目标对话已被删除: ${conversationId}`,
          retryable: false,
        },
      };
    }
    if (
      latestStatus?.unavailableTransfer ||
      /lifecycle projection/iu.test(err.message)
    ) {
      throw new ProgramConversationError(
        "temporarily_unavailable",
        "目标对话正在完成生命周期投影，请保留票据稍后重试",
        { retryable: true, exitCode: 3 },
      );
    }
    if (
      (await checkOpenAdvancement().catch(() => false)) ||
      /契约推进|独立验收/u.test(err.message)
    ) {
      return {
        v: 1,
        admitted: false,
        conversationId,
        requestId,
        error: {
          code: "needs_attention",
          message: "目标对话当前存在未终结的契约推进会话，请先在终端处理",
          retryable: false,
        },
      };
    }
    return {
      v: 1,
      admitted: false,
      conversationId,
      requestId,
      error: {
        code: "not_found",
        message: err.message,
        retryable: false,
      },
    };
  }

  async function send(
    input: ProgramConversationSendInput,
    signal?: AbortSignal,
  ): Promise<ProgramConversationSendResult> {
    const { conversationId, requestId, text } = input;
    const normalizedInput = normalizeUserTurnInput(text);
    const physicalTurnId = programConversationTurnId(conversationId, requestId);

    let resolved: ResolvedOwner;
    try {
      resolved = await resolveTargetOwner(conversationId, signal);
    } catch (err) {
      if (
        err instanceof ProgramConversationError &&
        (err.code === "not_found" || err.code === "target_deleted")
      ) {
        return {
          v: 1,
          admitted: false,
          conversationId,
          requestId,
          error: {
            code: err.code,
            message: err.message,
            retryable: false,
          },
        };
      }
      throw err;
    }
    let target: InProcessResolvedOwner;
    if (resolved.kind === "remote") {
      recordActivity();
      try {
        const res = await resolved.remote.ownedSend(input, signal);
        recordActivity();
        return res;
      } catch (err) {
        if (
          err instanceof ProgramConversationError &&
          err.options?.details?.leafAuthorityState === "fenced"
        ) {
          const rechecked =
            await anchor.protocol.conversationAdoptionStatus(conversationId);
          if (rechecked.adopted && !rechecked.unavailableTransfer) {
            target = { kind: "anchor", adoption: rechecked };
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }
    } else {
      target = resolved;
    }
    const inspectReceipt = async () => {
      try {
        return target.kind === "local"
          ? await target.owner.inspectProgramInputReceipt(conversationId, {
              physicalTurnId,
              expectedInput: normalizedInput,
            })
          : await anchor.protocol.inspectProgramInputReceipt(conversationId, {
              physicalTurnId,
              expectedInput: normalizedInput,
            });
      } catch (err) {
        if (
          err &&
          typeof err === "object" &&
          (err as { code?: unknown }).code === "CONVERSATION_BASE_UNAVAILABLE"
        ) {
          throw new ProgramConversationError(
            "temporarily_unavailable",
            "目标对话迁入基底尚未就绪，请保留票据稍后重试",
            { retryable: true, exitCode: 3 },
          );
        }
        throw err;
      }
    };

    const existing = await inspectReceipt();
    if (existing.status === "accepted") {
      recordActivity();
      return {
        v: 1,
        admitted: true,
        conversationId,
        requestId,
        runId: existing.runId,
        replayed: true,
      };
    }
    if (existing.status === "idempotency-conflict") {
      return {
        v: 1,
        admitted: false,
        conversationId,
        requestId,
        error: {
          code: "idempotency_conflict",
          message: "同一 requestId 已绑定不同的消息内容",
          retryable: false,
        },
      };
    }

    if (target.adoption.deleted || existing.deleted) {
      return {
        v: 1,
        admitted: false,
        conversationId,
        requestId,
        error: {
          code: "target_deleted",
          message: `目标对话已被删除: ${conversationId}`,
          retryable: false,
        },
      };
    }

    const exists =
      target.kind === "local"
        ? target.adoption.hasDurableIdentity
        : target.adoption.hasDurableIdentity ||
          (await anchorConversationStoredExists(conversationId));
    if (!exists) {
      return {
        v: 1,
        admitted: false,
        conversationId,
        requestId,
        error: {
          code: "not_found",
          message: `目标对话不存在: ${conversationId}`,
          retryable: false,
        },
      };
    }

    const isOwnerStopping = () =>
      target.kind === "local"
        ? (localExecutor?.isStopping?.() ?? false) ||
          target.owner.isShuttingDown()
        : (anchor.isStopping?.() ?? false) || anchor.protocol.isShuttingDown();

    if (isOwnerStopping()) {
      return {
        v: 1,
        admitted: false,
        conversationId,
        requestId,
        error: {
          code: "host_draining",
          message: "宿主正在排空停机，未接纳新的运行请求",
          retryable: false,
        },
      };
    }

    const checkOpenAdvancement = () =>
      target.kind === "local"
        ? target.owner.hasOpenAdvancementSession(conversationId)
        : anchor.protocol.hasOpenAdvancementSession(conversationId);

    if (await checkOpenAdvancement()) {
      return {
        v: 1,
        admitted: false,
        conversationId,
        requestId,
        error: {
          code: "needs_attention",
          message: "目标对话当前存在未终结的契约推进会话，请先在终端处理",
          retryable: false,
        },
      };
    }

    recordActivity();
    const turnOrigin = {
      channel: PROGRAM_TURN_CHANNEL,
      triggeredBy: requestId,
      messageIdentity: {
        id: physicalTurnId,
        source: { kind: "program" as const },
      },
    } as const;

    if (target.kind === "local") {
      let localEarlyRejection: ProgramConversationSendResult | undefined;
      try {
        const executionHandle = target.owner.createAgentTurnExecution({
          input: normalizedInput,
          turnOrigin,
          surfacePrincipal: PROGRAM_SURFACE_PRINCIPAL,
          notify: () => {},
        });
        const admitted = await target.owner.agentTurnAdmission.admit({
          identity: {
            kind: "existing",
            conversationId,
            exists: async () =>
              (await target.owner.conversationAdoptionStatus(conversationId))
                .hasDurableIdentity,
          },
          invocation: { kind: "agent" },
          caller: {
            kind: "surface",
            surfacePrincipal: PROGRAM_SURFACE_PRINCIPAL,
            connectionId: `program:${requestId}`,
          },
          observe: false,
          turnId: physicalTurnId,
          turnOrigin,
          input: normalizedInput,
          execution: executionHandle.execution,
          beforeDurableAdmit: async ({ conversationId: managedConversationId }) => {
            const rechecked = await inspectReceipt();
            if (rechecked.status === "accepted") {
              return { shouldEnqueue: false, runId: rechecked.runId };
            }
            if (rechecked.status === "idempotency-conflict") {
              localEarlyRejection = {
                v: 1,
                admitted: false,
                conversationId,
                requestId,
                error: {
                  code: "idempotency_conflict",
                  message: "同一 requestId 已绑定不同的消息内容",
                  retryable: false,
                },
              };
              throw new Error("program-early-rejection");
            }
            const [latestStatus, latestAuthority] = await Promise.all([
              target.owner.conversationAdoptionStatus(managedConversationId),
              target.owner.currentAuthority(managedConversationId),
            ]);
            if (
              latestStatus.unavailableTransfer ||
              latestAuthority.state === "frozen" ||
              latestAuthority.state === "importing" ||
              latestAuthority.state === "fenced"
            ) {
              throw new ProgramConversationError(
                "temporarily_unavailable",
                "目标本机对话正处于接管迁移中，请保留票据稍后重试",
                { retryable: true, exitCode: 3 },
              );
            }
            if (latestStatus.deleted || rechecked.deleted) {
              localEarlyRejection = {
                v: 1,
                admitted: false,
                conversationId,
                requestId,
                error: {
                  code: "target_deleted",
                  message: `目标对话已被删除: ${conversationId}`,
                  retryable: false,
                },
              };
              throw new Error("program-early-rejection");
            }
            if (isOwnerStopping()) {
              localEarlyRejection = {
                v: 1,
                admitted: false,
                conversationId,
                requestId,
                error: {
                  code: "host_draining",
                  message: "宿主正在排空停机，未接纳新的运行请求",
                  retryable: false,
                },
              };
              throw new Error("program-early-rejection");
            }
            if (await checkOpenAdvancement()) {
              localEarlyRejection = {
                v: 1,
                admitted: false,
                conversationId,
                requestId,
                error: {
                  code: "needs_attention",
                  message: "目标对话当前存在未终结的契约推进会话，请先在终端处理",
                  retryable: false,
                },
              };
              throw new Error("program-early-rejection");
            }
            return undefined;
          },
        });
        if (admitted.status === "lifecycle-busy") {
          throw new ProgramConversationError(
            "temporarily_unavailable",
            "目标本机对话正处于变更或移除静默期，请保留票据稍后重试",
            { retryable: true, exitCode: 3 },
          );
        }
        if (admitted.status === "full") {
          const rechecked = await inspectReceipt();
          if (rechecked.status === "accepted") {
            return {
              v: 1,
              admitted: true,
              conversationId,
              requestId,
              runId: rechecked.runId,
              replayed: true,
            };
          }
          return {
            v: 1,
            admitted: false,
            conversationId,
            requestId,
            error: {
              code: "queue_full",
              message: "目标对话待处理队列已满",
              retryable: true,
            },
          };
        }
        if (admitted.status === "not-found") {
          return {
            v: 1,
            admitted: false,
            conversationId,
            requestId,
            error: {
              code: "not_found",
              message: `目标对话不存在: ${conversationId}`,
              retryable: false,
            },
          };
        }
        if (admitted.status === "immediate") {
          void admitted.start().catch(() => undefined);
        }
        void executionHandle.outcome.catch(() => undefined);
        return {
          v: 1,
          admitted: true,
          conversationId,
          requestId,
          runId: admitted.runId!,
          ...(admitted.status === "replayed" ? { replayed: true } : {}),
        };
      } catch (err) {
        if (localEarlyRejection) return localEarlyRejection;
        if (err instanceof WorksceneBusyError) {
          throw new ProgramConversationError(
            "temporarily_unavailable",
            "目标本机对话正忙于目录或迁移切换，请保留票据稍后重试",
            { retryable: true, exitCode: 3 },
          );
        }
        if (err instanceof DurableConversationAdmissionRejectedError) {
          return await mapDurableAdmissionRejection(
            conversationId,
            requestId,
            err,
            checkOpenAdvancement,
            target,
          );
        }
        throw err;
      }
    }

    let earlyRejection: ProgramConversationSendResult | undefined;
    try {
      const admission = await anchor.manager.admitTurn({
        conversationId,
        exists: async () =>
          (await anchor.protocol.sessionExists(conversationId)) ||
          (await anchorConversationStoredExists(conversationId)),
        source: "interactive",
        beforeEnqueue: async (managed) => {
          const rechecked = await inspectReceipt();
          if (rechecked.status === "accepted") {
            return { shouldEnqueue: false, runId: rechecked.runId };
          }
          if (rechecked.status === "idempotency-conflict") {
            earlyRejection = {
              v: 1,
              admitted: false,
              conversationId,
              requestId,
              error: {
                code: "idempotency_conflict",
                message: "同一 requestId 已绑定不同的消息内容",
                retryable: false,
              },
            };
            throw new Error("program-early-rejection");
          }
          if (isOwnerStopping()) {
            earlyRejection = {
              v: 1,
              admitted: false,
              conversationId,
              requestId,
              error: {
                code: "host_draining",
                message: "宿主正在排空停机，未接纳新的运行请求",
                retryable: false,
              },
            };
            throw new Error("program-early-rejection");
          }
          if (await checkOpenAdvancement()) {
            earlyRejection = {
              v: 1,
              admitted: false,
              conversationId,
              requestId,
              error: {
                code: "needs_attention",
                message: "目标对话当前存在未终结的契约推进会话，请先在终端处理",
                retryable: false,
              },
            };
            throw new Error("program-early-rejection");
          }
          return anchor.manager.admitDurableTurn({
            conversationId: managed.conversationId,
            input: normalizedInput,
            invocation: { kind: "agent", source: "interactive" },
            options: {
              source: "interactive",
              surfacePrincipal: PROGRAM_SURFACE_PRINCIPAL,
              turnContext: {
                turnId: physicalTurnId,
                turnOrigin,
              },
            },
            surfacePrincipal: PROGRAM_SURFACE_PRINCIPAL,
          });
        },
        makeTask: (managed) => {
          const abort = new AbortController();
          return {
            source: "interactive",
            cancel: () => abort.abort(),
            execute: async () => {
              try {
                await projectSessionTurn({
                  manager: anchor.manager,
                  managed,
                  input: normalizedInput,
                  turnId: physicalTurnId,
                  runOptions: {
                    source: "interactive",
                    abortSignal: abort.signal,
                    surfacePrincipal: PROGRAM_SURFACE_PRINCIPAL,
                    turnContext: {
                      turnId: physicalTurnId,
                      turnOrigin,
                    },
                  },
                  notify: (method, params) => {
                    anchor.emitSessionNotification?.(
                      managed.conversationId,
                      method,
                      params,
                    );
                  },
                });
              } finally {
                anchor.manager.setBusy(managed.conversationId, false);
              }
            },
          };
        },
      });

      if (admission.status === "not-found") {
        return {
          v: 1,
          admitted: false,
          conversationId,
          requestId,
          error: {
            code: "not_found",
            message: `目标对话不存在: ${conversationId}`,
            retryable: false,
          },
        };
      }
      if (admission.status === "full") {
        const rechecked = await inspectReceipt();
        if (rechecked.status === "accepted") {
          return {
            v: 1,
            admitted: true,
            conversationId,
            requestId,
            runId: rechecked.runId,
            replayed: true,
          };
        }
        return {
          v: 1,
          admitted: false,
          conversationId,
          requestId,
          error: {
            code: "queue_full",
            message: "目标对话待处理队列已满",
            retryable: true,
          },
        };
      }
      if (admission.status === "immediate") {
        void admission.task.execute().catch(() => undefined);
      }
      return {
        v: 1,
        admitted: true,
        conversationId,
        requestId,
        runId: admission.runId!,
        ...(admission.status === "replayed" ? { replayed: true } : {}),
      };
    } catch (err) {
      if (earlyRejection) return earlyRejection;
      if (err instanceof WorksceneBusyError) {
        throw new ProgramConversationError(
          "temporarily_unavailable",
          "目标工作场景正处于变更或移除静默期，请保留票据稍后重试",
          { retryable: true, exitCode: 3 },
        );
      }
      if (err instanceof DurableConversationAdmissionRejectedError) {
        return await mapDurableAdmissionRejection(
          conversationId,
          requestId,
          err,
          checkOpenAdvancement,
          target,
        );
      }
      throw err;
    }
  }

  async function readCommittedAssistantPage(input: {
    readonly conversationId: string;
    readonly requestId: string;
    readonly runId: string;
    readonly cursorToken?: string;
    readonly recoveryPage: (
      req: Parameters<ConversationProtocolRuntime["recoveryPage"]>[0],
    ) => Promise<unknown>;
    readonly deadlineMs: number;
    readonly signal?: AbortSignal;
  }): Promise<
    | {
        readonly kind: "ready";
        readonly answer: string | null;
        readonly answerTruncated: boolean;
        readonly emptyReason?: "no_assistant_text";
        readonly nextCursor?: string;
      }
    | { readonly kind: "preparing" }
    | { readonly kind: "reset" }
  > {
    let cursor: ConversationBodyCursor | undefined;
    let previousBlock = -1;

    if (input.cursorToken !== undefined) {
      const decoded = decodeProgramBodyCursor(
        input.cursorToken,
        "result-answer",
        input.conversationId,
        input.runId,
      );
      cursor = decoded.bodyCursor;
      previousBlock = decoded.previousBlock ?? -1;
    } else {
      for (;;) {
        const page = (await input.recoveryPage({
          conversationId: input.conversationId,
          mode: "body-page",
          runId: input.runId,
          ...(cursor ? { cursor } : {}),
        })) as ConversationBodyPage;
        if (page.reset) return { kind: "reset" };
        if (page.preparing) {
          if (Date.now() >= input.deadlineMs || input.signal?.aborted) {
            return { kind: "preparing" };
          }
          cursor = page.cursor;
          await delayWithSignal(
            Math.min(25, Math.max(1, input.deadlineMs - Date.now())),
            input.signal,
          );
          continue;
        }
        const assistant = page.fragments.find(
          (item) => item.role === "assistant",
        );
        if (assistant) {
          cursor = { ...assistant.cursor, block: 0, offset: 0 };
          break;
        }
        const first = page.fragments[0];
        if (first) {
          cursor = { ...first.cursor, block: -1, offset: 0 };
        } else if (page.hasMore) {
          cursor = page.cursor;
        } else {
          return {
            kind: "ready",
            answer: null,
            answerTruncated: false,
            emptyReason: "no_assistant_text",
          };
        }
      }
    }

    let answer = "";
    let answerBytes = 0;
    let textBlocks = 0;
    const budget = PROGRAM_SAFE_PAYLOAD_BUDGET_BYTES;

    while (cursor) {
      const page = (await input.recoveryPage({
        conversationId: input.conversationId,
        mode: "body-page",
        runId: input.runId,
        direction: "forward",
        cursor,
      })) as ConversationBodyPage;
      if (page.reset) return { kind: "reset" };
      if (page.preparing) {
        if (answer.length > 0) {
          return {
            kind: "ready",
            answer,
            answerTruncated: true,
            nextCursor: encodeProgramBodyCursor({
              v: 1,
              kind: "result-answer",
              runId: input.runId,
              previousBlock,
              bodyCursor: cursor,
            }),
          };
        }
        if (Date.now() >= input.deadlineMs || input.signal?.aborted) {
          return { kind: "preparing" };
        }
        await delayWithSignal(
          Math.min(25, Math.max(1, input.deadlineMs - Date.now())),
          input.signal,
        );
        continue;
      }

      for (const item of page.fragments) {
        if (item.type !== "text") continue;
        let prefix = "";
        const nextBlock = item.block;
        if (nextBlock !== previousBlock) {
          if (textBlocks > 0 || (input.cursorToken !== undefined && previousBlock >= 0)) {
            prefix = "\n";
          }
        }
        const prefixBytes = prefix
          ? Buffer.byteLength(JSON.stringify(prefix), "utf8") - 2
          : 0;
        const remainingBudget = budget - answerBytes - prefixBytes;
        if (remainingBudget <= 0) {
          const resumeCursor: ConversationBodyCursor = {
            ...item.cursor,
            offset: item.offset,
          };
          return {
            kind: "ready",
            answer,
            answerTruncated: true,
            nextCursor: encodeProgramBodyCursor({
              v: 1,
              kind: "result-answer",
              runId: input.runId,
              previousBlock,
              bodyCursor: resumeCursor,
            }),
          };
        }
        const sliced = sliceTextWithinJsonByteBudget(
          item.text,
          0,
          remainingBudget,
        );
        if (sliced.chunk.length === 0 && item.text.length > 0) {
          const resumeCursor: ConversationBodyCursor = {
            ...item.cursor,
            offset: item.offset,
          };
          return {
            kind: "ready",
            answer,
            answerTruncated: true,
            nextCursor: encodeProgramBodyCursor({
              v: 1,
              kind: "result-answer",
              runId: input.runId,
              previousBlock,
              bodyCursor: resumeCursor,
            }),
          };
        }
        const encodedBytes =
          Buffer.byteLength(JSON.stringify(sliced.chunk), "utf8") - 2;
        answer += prefix + sliced.chunk;
        answerBytes += prefixBytes + encodedBytes;
        if (nextBlock !== previousBlock) {
          textBlocks += 1;
          previousBlock = nextBlock;
        }
        if (sliced.nextOffset < item.text.length) {
          const resumeCursor: ConversationBodyCursor = {
            ...item.cursor,
            offset: item.offset + sliced.nextOffset,
          };
          return {
            kind: "ready",
            answer,
            answerTruncated: true,
            nextCursor: encodeProgramBodyCursor({
              v: 1,
              kind: "result-answer",
              runId: input.runId,
              previousBlock,
              bodyCursor: resumeCursor,
            }),
          };
        }
      }

      if (!page.hasMore) break;
      if (!page.cursor) break;
      cursor = page.cursor;
    }

    if (answer.length === 0 && textBlocks === 0 && input.cursorToken === undefined) {
      return {
        kind: "ready",
        answer: null,
        answerTruncated: false,
        emptyReason: "no_assistant_text",
      };
    }

    return {
      kind: "ready",
      answer,
      answerTruncated: false,
    };
  }

  async function result(
    input: ProgramConversationResultInput,
    signal?: AbortSignal,
  ): Promise<ProgramConversationResultOutput> {
    const { conversationId, requestId } = input;
    if (input.cursor !== undefined) {
      decodeProgramBodyCursor(input.cursor, "result-answer", conversationId);
    }
    const waitMs = Math.min(
      Math.max(0, input.waitMs ?? 0),
      PROGRAM_MAX_WAIT_SLICE_MS,
    );
    const startMs = Date.now();
    const deadlineMs = startMs + waitMs;
    const prepareGraceDeadlineMs = Math.max(deadlineMs, startMs + 1_500);
    const physicalTurnId = programConversationTurnId(conversationId, requestId);

    for (;;) {
      let resolved: ResolvedOwner;
      try {
        resolved = await resolveTargetOwner(conversationId, signal);
      } catch (err) {
        if (
          err instanceof ProgramConversationError &&
          err.code === "temporarily_unavailable"
        ) {
          return {
            v: 1,
            state: "temporarily_unavailable",
            conversationId,
            requestId,
            error: {
              code: "temporarily_unavailable",
              message: err.message,
              retryable: true,
            },
          };
        }
        if (
          err instanceof ProgramConversationError &&
          err.code === "not_found"
        ) {
          return {
            v: 1,
            state: "unknown",
            conversationId,
            requestId,
            error: {
              code: "unknown",
              message: "尚未在当前权威查到该请求的入账记录",
              retryable: true,
            },
          };
        }
        throw err;
      }

      let target: InProcessResolvedOwner;
      if (resolved.kind === "remote") {
        const remainingWaitMs = Math.max(
          0,
          Math.min(PROGRAM_MAX_WAIT_SLICE_MS, waitMs - (Date.now() - startMs)),
        );
        try {
          return await resolved.remote.ownedResult(
            {
              conversationId,
              requestId,
              waitMs: remainingWaitMs,
              ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
            },
            signal,
          );
        } catch (err) {
          if (
            err instanceof ProgramConversationError &&
            err.options?.details?.leafAuthorityState === "fenced"
          ) {
            const rechecked =
              await anchor.protocol.conversationAdoptionStatus(conversationId);
            if (rechecked.adopted && !rechecked.unavailableTransfer) {
              target = { kind: "anchor", adoption: rechecked };
            } else {
              return {
                v: 1,
                state: "temporarily_unavailable",
                conversationId,
                requestId,
                error: {
                  code: "temporarily_unavailable",
                  message: err.message,
                  retryable: true,
                },
              };
            }
          } else if (isDeterministicCallerProgramError(err)) {
            throw err;
          } else {
            return {
              v: 1,
              state:
                err instanceof ProgramConversationError && err.code === "unknown"
                  ? "unknown"
                  : "temporarily_unavailable",
              conversationId,
              requestId,
              error: {
                code:
                  err instanceof ProgramConversationError
                    ? err.code
                    : "temporarily_unavailable",
                message: err instanceof Error ? err.message : String(err),
                retryable:
                  err instanceof ProgramConversationError
                    ? err.options?.retryable === true
                    : true,
              },
            };
          }
        }
      } else {
        target = resolved;
      }

      let receipt: Awaited<
        ReturnType<ConversationProtocolRuntime["inspectProgramInputReceipt"]>
      >;
      try {
        receipt =
          target.kind === "local"
            ? await target.owner.inspectProgramInputReceipt(conversationId, {
                physicalTurnId,
              })
            : await anchor.protocol.inspectProgramInputReceipt(conversationId, {
                physicalTurnId,
              });
      } catch (err) {
        if (
          err &&
          typeof err === "object" &&
          (err as { code?: unknown }).code === "CONVERSATION_BASE_UNAVAILABLE"
        ) {
          return {
            v: 1,
            state: "temporarily_unavailable",
            conversationId,
            requestId,
            error: {
              code: "temporarily_unavailable",
              message: "目标对话迁入基底尚未就绪，请保留票据稍后重试",
              retryable: true,
            },
          };
        }
        throw err;
      }

      if (receipt.status === "idempotency-conflict") {
        throw new ProgramConversationError(
          "idempotency_conflict",
          "该请求标识存在幂等冲突",
          { retryable: false, exitCode: 1 },
        );
      }

      if (receipt.status === "unknown") {
        if (receipt.deleted || target.adoption.deleted) {
          return {
            v: 1,
            state: "target_deleted",
            conversationId,
            requestId,
            error: {
              code: "target_deleted",
              message: `目标对话已被删除: ${conversationId}`,
              retryable: false,
            },
          };
        }
        return {
          v: 1,
          state: "unknown",
          conversationId,
          requestId,
          error: {
            code: "unknown",
            message: "尚未在当前权威查到该请求的入账记录",
            retryable: true,
          },
        };
      }

      const runId = receipt.runId;
      if (input.cursor !== undefined) {
        decodeProgramBodyCursor(
          input.cursor,
          "result-answer",
          conversationId,
          runId,
        );
      }
      if (receipt.deleted || target.adoption.deleted) {
        return {
          v: 1,
          state: "target_deleted",
          conversationId,
          requestId,
          runId,
          error: {
            code: "target_deleted",
            message: `目标对话已被删除: ${conversationId}`,
            retryable: false,
          },
        };
      }
      if (receipt.clearCovered) {
        return {
          v: 1,
          state: "cleared",
          conversationId,
          requestId,
          runId,
          error: {
            code: "cleared",
            message: "目标对话已执行清空并覆盖本次运行",
            retryable: false,
          },
        };
      }

      const recoveryPage =
        target.kind === "local"
          ? (req: Parameters<ConversationProtocolRuntime["recoveryPage"]>[0]) =>
              target.owner.recoveryPage(req)
          : (req: Parameters<ConversationProtocolRuntime["recoveryPage"]>[0]) =>
              anchor.protocol.recoveryPage(req);

      const recheckTerminalReceiptOnReadFailure = async (): Promise<
        ProgramConversationResultOutput | undefined
      > => {
        try {
          const recheck =
            target.kind === "local"
              ? await target.owner.inspectProgramInputReceipt(conversationId, {
                  physicalTurnId,
                })
              : await anchor.protocol.inspectProgramInputReceipt(
                  conversationId,
                  { physicalTurnId },
                );
          if (recheck.status === "accepted" && recheck.deleted) {
            return {
              v: 1,
              state: "target_deleted",
              conversationId,
              requestId,
              runId,
              error: {
                code: "target_deleted",
                message: `目标对话已被删除: ${conversationId}`,
                retryable: false,
              },
            };
          }
          if (recheck.status === "accepted" && recheck.clearCovered) {
            return {
              v: 1,
              state: "cleared",
              conversationId,
              requestId,
              runId,
              error: {
                code: "cleared",
                message: "目标对话已执行清空并覆盖本次运行",
                retryable: false,
              },
            };
          }
        } catch {
          // Fall back to temporarily_unavailable below.
        }
        return undefined;
      };

      let outcomes: ConversationRunOutcomesPage;
      try {
        outcomes = (await recoveryPage({
          conversationId,
          mode: "run-outcomes",
          runIds: [runId],
        })) as ConversationRunOutcomesPage;
      } catch (err) {
        if (err instanceof ProgramConversationError) throw err;
        const terminal = await recheckTerminalReceiptOnReadFailure();
        if (terminal) return terminal;
        return {
          v: 1,
          state: "temporarily_unavailable",
          conversationId,
          requestId,
          runId,
          error: {
            code: "temporarily_unavailable",
            message: `对话运行状态当前暂不可读: ${err instanceof Error ? err.message : String(err)}`,
            retryable: true,
          },
        };
      }
      const runOutcome = outcomes.entries[0];
      const runState = runOutcome?.state ?? "unknown";

      if (runState === "committed") {
        let bodyResult: Awaited<ReturnType<typeof readCommittedAssistantPage>>;
        try {
          bodyResult = await readCommittedAssistantPage({
            conversationId,
            requestId,
            runId,
            ...(input.cursor !== undefined ? { cursorToken: input.cursor } : {}),
            recoveryPage,
            deadlineMs: prepareGraceDeadlineMs,
            signal,
          });
        } catch (err) {
          if (err instanceof ProgramConversationError) throw err;
          if (isBodyCursorCoordinateError(err)) {
            throw new ProgramConversationError(
              "invalid_cursor",
              "正文游标位置与目标不匹配。",
              { retryable: false, exitCode: 1 },
            );
          }
          const terminal = await recheckTerminalReceiptOnReadFailure();
          if (terminal) return terminal;
          return {
            v: 1,
            state: "temporarily_unavailable",
            conversationId,
            requestId,
            runId,
            runState: "committed",
            error: {
              code: "temporarily_unavailable",
              message: `已提交回复正文当前暂不可读: ${err instanceof Error ? err.message : String(err)}`,
              retryable: true,
            },
          };
        }
        if (bodyResult.kind === "preparing") {
          return {
            v: 1,
            state: "pending",
            conversationId,
            requestId,
            runId,
            runState: "committed",
          };
        }
        if (bodyResult.kind === "reset") {
          const recheck =
            target.kind === "local"
              ? await target.owner.inspectProgramInputReceipt(conversationId, {
                  physicalTurnId,
                })
              : await anchor.protocol.inspectProgramInputReceipt(
                  conversationId,
                  { physicalTurnId },
                );
          if (recheck.status === "accepted" && recheck.deleted) {
            return {
              v: 1,
              state: "target_deleted",
              conversationId,
              requestId,
              runId,
              error: {
                code: "target_deleted",
                message: `目标对话已被删除: ${conversationId}`,
                retryable: false,
              },
            };
          }
          if (recheck.status === "accepted" && recheck.clearCovered) {
            return {
              v: 1,
              state: "cleared",
              conversationId,
              requestId,
              runId,
              error: {
                code: "cleared",
                message: "目标对话已执行清空并覆盖本次运行",
                retryable: false,
              },
            };
          }
          if (input.cursor !== undefined) {
            return {
              v: 1,
              state: "cursor_expired",
              conversationId,
              requestId,
              runId,
              runState: "committed",
              error: {
                code: "cursor_expired",
                message: "结果续读游标已因权威换代失效，请从头重读",
                retryable: true,
              },
            };
          }
          if (Date.now() < prepareGraceDeadlineMs && !signal?.aborted) {
            await delayWithSignal(25, signal);
            continue;
          }
          return {
            v: 1,
            state: "temporarily_unavailable",
            conversationId,
            requestId,
            runId,
            runState: "committed",
            error: {
              code: "temporarily_unavailable",
              message: "对话权威换代中，请持原票据重试",
              retryable: true,
            },
          };
        }
        return {
          v: 1,
          state: "completed",
          conversationId,
          requestId,
          runId,
          runState: "committed",
          answer: bodyResult.answer,
          answerTruncated: bodyResult.answerTruncated,
          ...(bodyResult.emptyReason
            ? { emptyReason: bodyResult.emptyReason }
            : {}),
          ...(bodyResult.nextCursor
            ? { nextCursor: bodyResult.nextCursor }
            : {}),
        };
      }

      if (runState === "failed" || runState === "expired") {
        return {
          v: 1,
          state: "failed",
          conversationId,
          requestId,
          runId,
          runState,
          error: {
            code: "invalid_params",
            message: runOutcome?.reason ?? "对话运行失败",
            retryable: false,
          },
        };
      }

      if (runState === "cancelled") {
        return {
          v: 1,
          state: "cancelled",
          conversationId,
          requestId,
          runId,
          runState: "cancelled",
          error: {
            code: "invalid_params",
            message: runOutcome?.reason ?? "对话运行已取消",
            retryable: false,
          },
        };
      }

      if (runState === "uncertain") {
        return {
          v: 1,
          state: "uncertain",
          conversationId,
          requestId,
          runId,
          runState: "uncertain",
          error: {
            code: "uncertain",
            message: "对话运行处于待消歧状态",
            retryable: true,
          },
        };
      }

      if (
        runState !== "queued" &&
        runState !== "dispatched" &&
        runState !== "running" &&
        runState !== "cancel-requested"
      ) {
        return {
          v: 1,
          state: "unknown",
          conversationId,
          requestId,
          runId,
          runState: runState === "missing" ? "missing" : "unknown",
          error: {
            code: "unknown",
            message: "已查到请求接纳收据，但当前权威尚未确认运行状态，请保留票据稍后重试",
            retryable: true,
          },
        };
      }

      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0 || signal?.aborted) {
        return {
          v: 1,
          state: "pending",
          conversationId,
          requestId,
          runId,
          runState,
        };
      }

      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          unsub();
          signal?.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, Math.min(150, remainingMs));
        timer.unref?.();
        const unsub =
          target.kind === "local"
            ? target.owner.subscribeRunNotifications((notification) => {
                if (notification.conversationId === conversationId) finish();
              })
            : anchor.protocol.onStatus((notice) => {
                if (
                  notice.ref.conversationId === conversationId &&
                  notice.ref.runId === runId
                ) {
                  finish();
                }
              });
        signal?.addEventListener("abort", finish, { once: true });
      });
    }
  }

  async function read(
    input: ProgramConversationReadInput,
    signal?: AbortSignal,
  ): Promise<ProgramConversationReadResult> {
    const { conversationId } = input;
    const limit = input.limit ?? 20;
    const scope = classifyConversationDirectoryScope(conversationId);
    const resolved = await resolveTargetOwner(conversationId, signal);
    let target: InProcessResolvedOwner;
    if (resolved.kind === "remote") {
      try {
        return await resolved.remote.ownedRead(input, signal);
      } catch (err) {
        if (
          err instanceof ProgramConversationError &&
          err.options?.details?.leafAuthorityState === "fenced"
        ) {
          const rechecked =
            await anchor.protocol.conversationAdoptionStatus(conversationId);
          if (rechecked.adopted && !rechecked.unavailableTransfer) {
            target = { kind: "anchor", adoption: rechecked };
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }
    } else {
      target = resolved;
    }

    if (target.adoption.deleted) {
      throw new ProgramConversationError(
        "target_deleted",
        `目标对话已被删除: ${conversationId}`,
        { retryable: false, exitCode: 1 },
      );
    }

    const exists =
      target.kind === "local"
        ? target.adoption.hasDurableIdentity
        : target.adoption.hasDurableIdentity ||
          (await anchorConversationStoredExists(conversationId));
    if (!exists) {
      throw new ProgramConversationError(
        "not_found",
        `目标对话不存在: ${conversationId}`,
        { retryable: false, exitCode: 1 },
      );
    }

    let cursor: ConversationBodyCursor | undefined;
    if (input.before !== undefined) {
      const decoded = decodeProgramBodyCursor(
        input.before,
        "read-before",
        conversationId,
      );
      cursor = decoded.bodyCursor;
    }

    const recoveryPage =
      target.kind === "local"
        ? (req: Parameters<ConversationProtocolRuntime["recoveryPage"]>[0]) =>
            target.owner.recoveryPage(req)
        : (req: Parameters<ConversationProtocolRuntime["recoveryPage"]>[0]) =>
            anchor.protocol.recoveryPage(req);

    const recheckDeletedOnReadFailure = async () => {
      try {
        const latest =
          target.kind === "local"
            ? await target.owner.conversationAdoptionStatus(conversationId)
            : await anchor.protocol.conversationAdoptionStatus(conversationId);
        if (latest.deleted) {
          throw new ProgramConversationError(
            "target_deleted",
            `目标对话已被删除: ${conversationId}`,
            { retryable: false, exitCode: 1 },
          );
        }
      } catch (recheckErr) {
        if (recheckErr instanceof ProgramConversationError) throw recheckErr;
      }
    };

    const hasDurableJournal = target.adoption.hasDurableIdentity;
    const entries: ProgramConversationReadMessageEntry[] = [];
    const seenRuns = new Set<string>();
    let hasMore = false;
    let nextBefore: string | undefined;
    let usedBytes = 0;
    const budget = Math.floor(PROGRAM_SAFE_PAYLOAD_BUDGET_BYTES * 0.8);

    if (hasDurableJournal) {
      const prepareDeadline = Date.now() + 2_500;
      let resetRetried = false;
      for (;;) {
        let page: ConversationBodyPage;
        try {
          page = (await recoveryPage({
            conversationId,
            mode: "body-page",
            includeInputs: true,
            ...(cursor ? { cursor } : {}),
          })) as ConversationBodyPage;
        } catch (err) {
          if (err instanceof ProgramConversationError) throw err;
          if (isBodyCursorCoordinateError(err)) {
            throw new ProgramConversationError(
              "invalid_cursor",
              "正文游标位置与目标不匹配。",
              { retryable: false, exitCode: 1 },
            );
          }
          await recheckDeletedOnReadFailure();
          if (
            cursor !== undefined &&
            err instanceof Error &&
            /^conversation-history-/u.test(err.message)
          ) {
            throw new ProgramConversationError(
              "cursor_expired",
              "before 游标已失效，请从头重读",
              { retryable: true, exitCode: 3 },
            );
          }
          throw new ProgramConversationError(
            "temporarily_unavailable",
            `对话历史当前暂不可读，请稍后重试: ${err instanceof Error ? err.message : String(err)}`,
            { retryable: true, exitCode: 3 },
          );
        }

        if (page.reset) {
          if (input.before !== undefined || entries.length > 0) {
            throw new ProgramConversationError(
              "cursor_expired",
              "历史分页游标已因权威换代或清空失效，请从头重读",
              { retryable: true, exitCode: 3 },
            );
          }
          if (!resetRetried) {
            resetRetried = true;
            cursor = undefined;
            continue;
          }
          throw new ProgramConversationError(
            "temporarily_unavailable",
            "目标对话正在换代或清空同步中，请稍后重试",
            { retryable: true, exitCode: 3 },
          );
        }

        if (page.preparing && page.fragments.length === 0) {
          if (entries.length > 0 && cursor) {
            hasMore = true;
            nextBefore = encodeProgramBodyCursor({
              v: 1,
              kind: "read-before",
              bodyCursor: cursor,
            });
            break;
          }
          if (Date.now() >= prepareDeadline || signal?.aborted) {
            throw new ProgramConversationError(
              "temporarily_unavailable",
              "对话历史索引正在准备中，请稍后重试",
              { retryable: true, exitCode: 3 },
            );
          }
          cursor = page.cursor;
          await delayWithSignal(25, signal);
          continue;
        }

        let stoppedMidPage = false;
        let lastConsumedFragmentCursor: ConversationBodyCursor | undefined;
        for (let i = 0; i < page.fragments.length; i += 1) {
          const frag: ConversationBodyFragment = page.fragments[i]!;
          if (!seenRuns.has(frag.runId) && seenRuns.size >= limit) {
            hasMore = true;
            const resumeAt = lastConsumedFragmentCursor ?? cursor ?? frag.cursor;
            nextBefore = encodeProgramBodyCursor({
              v: 1,
              kind: "read-before",
              bodyCursor: resumeAt,
            });
            stoppedMidPage = true;
            break;
          }
          const displayText = frag.material
            ? formatPersistedFileMaterial(frag.material)
            : frag.tool
              ? frag.tool.kind === "call"
                ? `[tool_use:${frag.tool.name}]`
                : `[tool_result:${frag.tool.call?.name ?? "tool"}]`
              : frag.text;
          const mapped: ProgramConversationReadMessageEntry = {
            runId: frag.runId,
            runIndex: frag.runIndex,
            messageIndex: frag.message,
            blockIndex: frag.block,
            role: frag.role,
            type: frag.type,
            text: displayText,
            offset: frag.offset,
            length: frag.material || frag.tool ? displayText.length : frag.length,
            final: frag.final,
            ...(frag.sourceConversationId
              ? { sourceConversationId: frag.sourceConversationId }
              : {}),
            ...(frag.programOrigin ? { programOrigin: true } : {}),
          };
          const itemBytes = Buffer.byteLength(JSON.stringify(mapped), "utf8");
          if (entries.length > 0 && usedBytes + itemBytes > budget) {
            hasMore = true;
            const resumeAt = lastConsumedFragmentCursor ?? cursor ?? frag.cursor;
            nextBefore = encodeProgramBodyCursor({
              v: 1,
              kind: "read-before",
              bodyCursor: resumeAt,
            });
            stoppedMidPage = true;
            break;
          }
          seenRuns.add(frag.runId);
          entries.push(mapped);
          usedBytes += itemBytes;
          lastConsumedFragmentCursor = frag.cursor;
        }

        if (stoppedMidPage) break;
        if (!page.hasMore || !page.cursor) {
          hasMore = false;
          break;
        }
        cursor = page.cursor;
      }
    }

    const orderedEntries = [...entries].reverse();

    let inputsOutsideHistory: ProgramConversationPendingInputEntry[] = [];
    let inputsOutsideHistoryTruncated = false;
    if (input.before === undefined && hasDurableJournal) {
      let outside: {
        readonly inputs: readonly import("@zhixing-ai/core/conversation/application").ConversationMessageStatus[];
        readonly truncated: boolean;
      };
      try {
        outside =
          target.kind === "local"
            ? await target.owner.communicationMessages.inputsOutsideHistory(
                conversationId,
              )
            : await anchor.protocol.messageInputsOutsideHistory(conversationId);
      } catch (err) {
        if (err instanceof ProgramConversationError) throw err;
        await recheckDeletedOnReadFailure();
        throw new ProgramConversationError(
          "temporarily_unavailable",
          `待处理消息当前暂不可读，请稍后重试: ${err instanceof Error ? err.message : String(err)}`,
          { retryable: true, exitCode: 3 },
        );
      }
      inputsOutsideHistoryTruncated = outside.truncated;
      const remaining = PROGRAM_SAFE_PAYLOAD_BUDGET_BYTES - usedBytes;
      let outsideBytes = 0;
      for (const item of outside.inputs) {
        const sourceId =
          item.message.inputIdentity?.source.kind === "conversation"
            ? item.message.inputIdentity.source.conversationId
            : undefined;
        const mapped: ProgramConversationPendingInputEntry = {
          runId: item.runId,
          state: item.state,
          consumed: item.consumed,
          disposition: item.disposition,
          text: extractText(item.message),
          ...(sourceId ? { sourceConversationId: sourceId } : {}),
          ...(item.programOrigin ? { programOrigin: true } : {}),
        };
        const bytes = Buffer.byteLength(JSON.stringify(mapped), "utf8");
        if (outsideBytes + bytes > remaining) {
          inputsOutsideHistoryTruncated = true;
          break;
        }
        outsideBytes += bytes;
        inputsOutsideHistory.push(mapped);
      }
    }

    return {
      v: 1,
      conversationId,
      scope,
      entries: orderedEntries,
      inputsOutsideHistory,
      inputsOutsideHistoryTruncated,
      hasMore,
      ...(hasMore && nextBefore ? { nextBefore } : {}),
    };
  }

  async function discoverInternal(
    input: ProgramConversationListInput,
    signal?: AbortSignal,
  ) {
    return projectEntriesForInternalDiscover(await list(input, signal));
  }

  return Object.freeze({
    list,
    create: (input: ProgramConversationNewInput, signal?: AbortSignal) =>
      createForPrincipal(PROGRAM_SURFACE_PRINCIPAL, input, signal),
    createForPrincipal,
    discoverInternal,
    read,
    send,
    result,
  });
}
