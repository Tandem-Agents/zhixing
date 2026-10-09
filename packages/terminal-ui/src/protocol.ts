import type { BodyFragmentMetadata, BodyPagePatch } from './body-model.js';
import type { TerminalSkillsAction, TerminalSkillsView } from './skills-model.js';
import type { TerminalProcessView } from './process-model.js';
export { validateProcessView } from './process-model.js';

/** Private same-release terminal transport, not a second product API. */
export interface TerminalPasteDraft { readonly inputId: string; readonly start: number; readonly end: number; readonly cursor: number }

export const TERMINAL_PROTOCOL = "zhixing-terminal/1";
export const TERMINAL_LIMITS = Object.freeze({
  frameBytes: 256 * 1024,
  textFragmentBytes: 32 * 1024,
  bodyFrames: 8,
  controlFrames: 4,
  // C's 32 correlation records are shared: UI actions 8, RPC 12,
  // notification lookups 4, asset operations 4, startup/preparation 4.
  pendingRequests: 8,
  deliveryTimeoutMs: 5_000,
  historyHotBytes: 64 * 1024 * 1024,
  inputHotBytes: 64 * 1024 * 1024,
  rpcWorkspaceBytes: 256 * 1024 * 1024,
  parserBytes: 32 * 1024 * 1024,
  parserSegments: 4096,
  instanceBytes: 640 * 1024 * 1024,
  startupReservationBytes: 64 * 1024 * 1024,
  // Durable disk commitment, not the size of a physical IO transaction.
  storageReservationBytes: 8 * 1024 * 1024,
  rootBytes: 6 * 1024 * 1024 * 1024,
  rootDisplayBytes: 2 * 1024 * 1024 * 1024,
  rootInstances: 8,
  freeDiskBytes: 512 * 1024 * 1024,
});

export type TerminalRole = "application" | "ui";
export type TerminalTraffic = "body" | "control";
export interface TerminalEnvelope {
  readonly protocol: typeof TERMINAL_PROTOCOL;
  readonly instance: string;
  readonly sequence: number;
  readonly traffic: TerminalTraffic;
  readonly payload: TerminalMessage;
}

export type TerminalMessage =
  | { readonly type: "hello"; readonly role: TerminalRole }
  | { readonly type: "modes"; readonly originalMask: number; readonly mutableMask: number }
  | { readonly type: "grant" }
  | { readonly type: "ready"; readonly frameId: number }
  | { readonly type: "close"; readonly deadline: number }
  | { readonly type: "exit"; readonly code: number; readonly reason: string }
  | { readonly type: "request"; readonly id: number; readonly action: TerminalAction }
  | { readonly type: "reply"; readonly id: number; readonly value?: unknown; readonly error?: string }
  | { readonly type: "view"; readonly view: TerminalView }
  | { readonly type: 'task-status'; readonly status: TerminalTaskStatus }
  | { readonly type: 'process-status'; readonly status?: TerminalProcessStatus }
  | { readonly type: 'recovery-page'; readonly requestId: string; readonly page: number; readonly text: string }
  | { readonly type: 'command-output'; readonly stream: 'stdout' | 'stderr'; readonly text: string }
  | { readonly type: "chunk"; readonly stream: string; readonly index: number; readonly text: string; readonly final: boolean }
  | { readonly type: "invalidate"; readonly requestId: string }
  | { readonly type: "assets"; readonly id: number; readonly operation:
      | { readonly kind: 'reserve'; readonly bucket: 'display' | 'input'; readonly bytes: number }
      | { readonly kind: 'settle'; readonly token: string; readonly bytes: number }
      | { readonly kind: 'released'; readonly bucket: 'display' | 'input'; readonly bytes: number } }
  | { readonly type: "assets-result"; readonly id: number; readonly token?: string; readonly failed?: true }
  | { readonly type: 'host-start'; readonly id: string; readonly endpoint?: string; readonly channel?: 'posix'; readonly handoff: string; readonly deadline: number }
  | { readonly type: 'host-release'; readonly id: string }
  | { readonly type: 'host-state'; readonly id: string; readonly state: 'created' | 'failed' | 'exited'; readonly pid?: number; readonly code?: number }
  | { readonly type: "display-page"; readonly page: TerminalDisplayPage }
  | { readonly type: 'display-patch'; readonly patch: BodyPagePatch }
  | { readonly type: 'submission'; readonly inputId: string; readonly version: number; readonly accepted: boolean; readonly message?: string }
  | { readonly type: "ack"; readonly sequence: number };

/** Finite user intents; neither arbitrary RPC methods nor filesystem paths. */
export type TerminalAction =
  | { readonly kind: 'recovery-part'; readonly requestId: string; readonly index: number; readonly encoded: string; readonly final: boolean }
  | { readonly kind: 'recovery-page'; readonly requestId: string; readonly page: number }
  | { readonly kind: 'recovery-cancel'; readonly requestId: string }
  | { readonly kind: "startup" | "retry-connection" | "display-retry" | "history-open" | "history-close" | "history-previous" | "rubric-resume" | "confirmation-retry" | "abort" | "interrupt" | "exit" | "status" }
  | { readonly kind: "command"; readonly name: string; readonly argument: string }
  | { readonly kind: 'command-route'; readonly name: string }
  | { readonly kind: 'skills-action'; readonly action: TerminalSkillsAction }
  | { readonly kind: 'display-page'; readonly start?: number; readonly follow?: boolean }
  | { readonly kind: "configuration-open"; readonly section?: "model" | "mcp" }
  | { readonly kind: "configuration-action"; readonly editId: string; readonly action: string; readonly value?: string | number | boolean }
  | { readonly kind: "secret-value"; readonly editId: string; readonly fieldId: string; readonly value: string }
  | { readonly kind: "confirmation"; readonly requestId: string; readonly action: string; readonly note?: string; readonly cancelCause?: TerminalSelectionCancelCause }
  | { readonly kind: "selection"; readonly requestId: string; readonly itemId?: string; readonly input?: string; readonly cancelled?: boolean; readonly cancelCause?: TerminalSelectionCancelCause }
  | { readonly kind: "input-begin"; readonly inputId: string; readonly purpose: 'draft' | 'paste'; readonly bytes?: number }
  | { readonly kind: "input-part"; readonly inputId: string; readonly index: number; readonly text: string; readonly final: boolean }
  | { readonly kind: "input-submit"; readonly inputId: string; readonly version: number }
  | { readonly kind: 'input-window'; readonly inputId: string; readonly position: number }
  | { readonly kind: 'input-splice'; readonly inputId: string; readonly start: number; readonly end: number; readonly replacementId: string }
  | { readonly kind: 'input-references'; readonly version: number; readonly ids: readonly string[]; readonly completed: readonly string[]; readonly cached?: readonly string[] }
  | { readonly kind: 'input-history'; readonly offset: number }
  | { readonly kind: 'input-history-next' | 'input-history-end'; readonly ticket: string }
  | { readonly kind: 'input-candidates'; readonly revision: number; readonly text: string; readonly cursor: number; readonly atStart?: boolean }
  | { readonly kind: 'candidate-ghost'; readonly revision: number }
  | { readonly kind: 'candidate-accept'; readonly revision: number; readonly id: string }
  | { readonly kind: 'candidate-revoke'; readonly revision: number; readonly id: string }
  | { readonly kind: 'candidate-manage'; readonly revision: number; readonly action: 'delete' | 'rename' | 'create'; readonly id?: string }
  | { readonly kind: 'paste-finish'; readonly inputId: string; readonly draft?: TerminalPasteDraft }
  | { readonly kind: "input-release"; readonly inputId: string }
  | { readonly kind: "clipboard-read"; readonly inputId: string; readonly target: 'draft' | 'field' };

export interface TerminalCandidates {
  /** Display-only prefix target. Acceptance is authorized by N's revision. */
  readonly ghost?: { readonly fullValue: string };
  readonly argumentHint?: string;
  readonly revision: number;
  readonly mode?: 'picker' | 'management';
  readonly canDelete?: boolean;
  readonly canRename?: boolean;
  readonly canCreate?: boolean;
  readonly hint?: string;
  readonly error?: string;
  /** UTF-16 offsets within the bounded query window. */
  readonly start: number;
  readonly end: number;
  readonly items: readonly { readonly id: string; readonly label: string; readonly detail?: string }[];
}
export interface TerminalCandidateAcceptance {
  readonly text: string;
  readonly execute: boolean;
  readonly inputId?: string;
  readonly handles?: readonly { readonly token: string; readonly id: string }[];
}

export type TerminalSelectionCancelCause = 'escape' | 'ctrl-c' | 'ctrl-d' | 'aborted';

export interface TerminalChoice {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly disabled?: boolean;
  readonly danger?: boolean;
  readonly hotkey?: string;
  readonly detailsActionId?: string;
}

export interface TerminalDisplaySegment {
  readonly blockId: string;
  readonly contentOffset: number;
  readonly role: string;
  readonly text: string;
  readonly final: boolean;
  readonly body?: BodyFragmentMetadata;
}
export interface TerminalDisplayPage {
  readonly first: number;
  readonly last: number;
  readonly start: number;
  readonly follow: boolean;
  readonly segments: readonly TerminalDisplaySegment[];
}
export interface TerminalTaskStatus {
  readonly summary?: { readonly conversationId: string; readonly state: 'loading' | 'ready' | 'error'; readonly text: string };
  readonly noticeGap?: string;
}
export interface TerminalProcessStatus {
  readonly conversationId: string;
  readonly runId?: string;
  readonly turnId?: string;
  readonly view: TerminalProcessView;
}
export interface TerminalView {
  readonly generation: number;
  readonly kind: "conversation" | "history" | "configuration" | "selection" | "confirmation" | "unavailable" | 'skills' | 'recovery';
  readonly title: string;
  readonly conversationId?: string;
  readonly message?: string;
  readonly displayGap?: boolean;
  readonly displayPaused?: boolean;
  readonly requestId?: string;
  readonly editId?: string;
  readonly choices?: readonly TerminalChoice[];
  readonly selectionLayer?: 'select' | 'input' | 'confirm' | 'details';
  readonly initialItemId?: string;
  readonly detailsActionId?: string;
  readonly field?: { readonly id: string; readonly label: string; readonly secret: boolean; readonly value?: string; readonly configured?: boolean };
  readonly connected?: boolean;
  readonly environment?: { readonly provider: string; readonly model: string; readonly workspace: string | null };
  readonly busy?: boolean;
  readonly skills?: TerminalSkillsView;
  readonly recovery?: { readonly requestId: string; readonly input: boolean; readonly pages: number; readonly settled?: boolean };
}

export function terminalEnvelope(value: unknown, instance: string): value is TerminalEnvelope {
  if (!value || typeof value !== "object") return false;
  const packet = value as Partial<TerminalEnvelope>;
  return packet.protocol === TERMINAL_PROTOCOL && packet.instance === instance &&
    Number.isSafeInteger(packet.sequence) && packet.sequence! > 0 &&
    (packet.traffic === "body" || packet.traffic === "control") &&
    !!packet.payload && typeof packet.payload === "object" && typeof packet.payload.type === "string";
}

/** One-code-unit command alias; normalize semantic matching only.
 * Keep the original draft/history literal. Expanded paste payloads require
 * the unexpanded draft as the guard so pasted punctuation stays ordinary text. */
export const SLASH_ALIASES: readonly string[] = ["、"];

export function normalizeLeadingSlashAlias(input: string): string {
  for (const alias of SLASH_ALIASES) {
    if (input.startsWith(alias)) return "/" + input.slice(alias.length);
  }
  return input;
}

/** Caller supplies trimmed control strings; guard and target have the same
 * leading alias when the alias is typed before any folded paste reference. */
export function normalizeLeadingSlashAliasInExpanded(
  target: string,
  guard: string,
): string {
  for (const alias of SLASH_ALIASES) {
    if (guard.startsWith(alias)) return "/" + target.slice(alias.length);
  }
  return target;
}
