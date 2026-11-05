import { type BodyFragmentMetadata, type BodyPage, type BodyPagePatch } from './body-model.js';
import { type TerminalSkillsAction, type TerminalSkillsView } from './skills-model.js';
import { type TerminalProcessView } from './process-model.js';

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
  // Cold application preparation is not an outstanding message delivery.
  // One absolute deadline, independent of the first rendered frame.
  applicationStartupTimeoutMs: 30_000,
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
  | { readonly type: 'usable-frame'; readonly frameId: number }
  | { readonly type: "hello"; readonly role: TerminalRole }
  | { readonly type: "modes"; readonly originalMask: number; readonly mutableMask: number }
  | { readonly type: "grant" }
  | { readonly type: "ready"; readonly frameId: number }
  | { readonly type: "application-ready" }
  | { readonly type: "close"; readonly deadline: number }
  | { readonly type: "exit"; readonly code: number; readonly reason: string; readonly deadline?: number; readonly bootstrapFailure?: {
      readonly stage: 'writer-declaration' | 'module-load'; readonly durationMs: number;
      readonly category: string; readonly code?: string;
    } }
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
  | { readonly type: "assets-result"; readonly id: number; readonly token?: string; readonly failed?: true; readonly reason?: string }
  | { readonly type: 'host-start'; readonly id: string; readonly endpoint?: string; readonly channel?: 'posix'; readonly handoff: string; readonly deadline: number }
  | { readonly type: 'host-release'; readonly id: string }
  | { readonly type: 'host-state'; readonly id: string; readonly state: 'created' | 'failed' | 'exited'; readonly pid?: number; readonly code?: number }
  /** 本代完整基准：U 据此重置阅读窗口与补丁基址；hasEarlier 为本代首页落定时源端是否还有更早历史 */
  | { readonly type: "display-page"; readonly page: BodyPage; readonly revision: number; readonly reading: TerminalReading; readonly hasEarlier?: boolean }
  | { readonly type: 'display-patch'; readonly patch: BodyPagePatch }
  | { readonly type: 'submission'; readonly inputId: string; readonly version: number; readonly accepted: boolean; readonly message?: string }
  | { readonly type: "ack"; readonly sequence: number };

/** Finite user intents; neither arbitrary RPC methods nor filesystem paths. */
export type TerminalAction =
  | { readonly kind: 'recovery-part'; readonly requestId: string; readonly index: number; readonly encoded: string; readonly final: boolean }
  | { readonly kind: 'recovery-page'; readonly requestId: string; readonly page: number }
  | { readonly kind: 'recovery-cancel'; readonly requestId: string }
  | { readonly kind: "startup" | "retry-connection" | "display-retry" | "history-open" | "history-close" | "rubric-resume" | "confirmation-retry" | "exit" | "status" }
  /** Esc／Ctrl+C 请求停止。stop 是按键时屏上显示的那次运行（意图与身份，不是授权）；缺省表示按键时屏上空闲。 */
  | { readonly kind: "abort" | "interrupt"; readonly stop?: TerminalStopTarget }
  | { readonly kind: "command"; readonly name: string; readonly argument: string }
  | { readonly kind: 'command-route'; readonly name: string }
  | { readonly kind: 'skills-action'; readonly action: TerminalSkillsAction }
  | { readonly kind: 'display-page'; readonly start?: number; readonly follow?: boolean; readonly generation?: number }
  /** 取显示序号 before 之前紧邻的一页（至多一页传输上限）。N 已存就直接读；不够时单飞读一次源页。不改显示游标、跟随与补丁基准；回复见 TerminalEarlierReply。 */
  | { readonly kind: 'display-earlier'; readonly before: number; readonly generation: number }
  /** 断线返回页“本机正文恢复失败”的重试：只按本机重读提示所属的会话与阅读代次；重读在途或已换代时不生效，不经在线恢复或重连 */
  | { readonly kind: 'local-body-retry'; readonly conversationId: string; readonly generation: number }
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
  | { readonly kind: "clipboard-read"; readonly inputId: string; readonly target: 'draft' | 'field' }
  | { readonly kind: 'clipboard-write'; readonly text: string };

export interface TerminalCandidates {
  readonly active?: boolean;
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
  readonly section?: string;
  readonly sectionDescription?: string;
  readonly presentation?: 'button';
  readonly primary?: boolean;
  readonly shortcut?: string;
  readonly status?: 'ready' | 'pending' | 'disabled';
}

export interface TerminalDisplaySegment {
  readonly blockId: string;
  readonly groupId?: string;
  readonly contentOffset: number;
  readonly role: string;
  readonly text: string;
  readonly final: boolean;
  readonly body?: BodyFragmentMetadata;
}
/** display-earlier 的回复：page 为 before 之前紧邻的已存片段（可能为空），hasEarlier 为源端是否还有更早历史。 */
export interface TerminalEarlierReply { readonly accepted: true; readonly hasEarlier: boolean; readonly page?: TerminalDisplayPage;
  /** 这次是否有进展（取到内容、N 已存起点前移、源游标或准备进度推进）；false 表示原地踏步 */
  readonly progressed?: boolean;
  /** 请求属于已被替换的阅读代次（换代或取消）：N 没有读源、没有推进任何游标；U 安静结束这次读取，不算原地踏步，也不再补读，等新代基准 */
  readonly stale?: true }
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
/** 按键时屏上显示的运行：所在对话，以及过程状态给出的轮次与运行身份；还没有运行身份时是当时在途提交的输入身份。 */
export interface TerminalStopTarget {
  readonly conversationId: string;
  readonly turnId?: string;
  readonly runId?: string;
  readonly inputId?: string;
}
export interface TerminalProcessStatus {
  readonly conversationId: string;
  readonly runId?: string;
  readonly turnId?: string;
  readonly view: TerminalProcessView;
}
/** 一次正文重建的身份：会话与阅读代次。视图声明期望的，基准携带实际的，两者相同才显示正文。 */
export interface TerminalReading { readonly conversationId: string; readonly generation: number }
export interface TerminalView {
  readonly historyHasMore?: boolean;
  readonly reading?: TerminalReading;
  readonly generation: number;
  readonly kind: "conversation" | "history" | "configuration" | "selection" | "confirmation" | "unavailable" | 'skills' | 'recovery';
  readonly title: string;
  readonly conversationId?: string;
  readonly message?: string;
  readonly displayGap?: boolean;
  readonly displayPaused?: boolean;
  readonly bodyRecovery?: 'retrying' | 'blocked';
  /** 断线返回页按本机只读重建正文失败：阅读行提示并可点击重试（只重读本机，不连接宿主）；重建成功即清除 */
  readonly localBodyFailed?: boolean;
  readonly requestId?: string;
  readonly editId?: string;
  readonly configurationHome?: boolean;
  readonly chromeDescription?: string;
  readonly chromeDetails?: readonly string[];
  readonly choices?: readonly TerminalChoice[];
  readonly selectionLayer?: 'select' | 'input' | 'confirm' | 'details';
  readonly initialItemId?: string;
  readonly detailsActionId?: string;
  /** error：上一次提交未被接受的原因（空值、保存失败）；字段按提交时的值重开，说明写在信息行 */
  readonly field?: { readonly id: string; readonly label: string; readonly secret: boolean; readonly value?: string; readonly configured?: boolean; readonly error?: string };
  /** 单字段页的提交动作：Enter 以它的 id 连同输入应答，不再画动作列表（与 choices 互斥） */
  readonly fieldSubmit?: { readonly id: string; readonly label: string };
  /** 单字段页 Esc 的说法（取消、返回）；Esc 照常走选择取消 */
  readonly cancelLabel?: string;
  /** 就地字段：底层会话的显示（正文、欢迎、阅读、过程、导航）保留，只把输入区换成这个字段；
   *  U 没有同一会话的会话视图可依托时按整页显示 */
  readonly inline?: boolean;
  readonly connected?: boolean;
  readonly connectionState?: 'starting' | 'unavailable';
  /** N completed initial history/observer admission; U acknowledges its frame. */
  readonly readyForInput?: boolean;
  readonly environment?: { readonly provider: string; readonly model: string; readonly workspace: string | null };
  readonly busy?: boolean;
  readonly inputReceiptPending?: boolean;
  /** 已受理、结果还没送到界面的命令名（N 等首帧到上限后如实保留，首帧写出或结算时撤下）；会话页信息行据此显示“正在打开” */
  readonly commandPending?: string;
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
