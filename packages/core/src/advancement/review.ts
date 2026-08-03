import type { RunRecordInput, RunRecordRef } from "../transcript/shard/types.js";
import type { UserTurnInput } from "../types/user-input.js";
import type {
  AdvancementRunReview,
  AdvancementWindowState,
  ConfirmedRubricSnapshot,
  ReviewEvidence,
} from "./types.js";

/**
 * 推进侧裁判的领域输入——被审 run、确认版 Rubric、既往 review、推进窗口
 * 与 owner 已验真的 canonical evidence 全部显式携带，实现侧不得经闭包
 * 或拓扑对象暗取输入。租约与中止信号由 AdvancementReviewerPort 调用面承载。
 */
export interface AdvancementReviewRunInput {
  readonly sessionId: string;
  readonly originalUserTask: UserTurnInput;
  readonly rubric: ConfirmedRubricSnapshot;
  readonly runIndex: number;
  readonly runRecord: RunRecordInput;
  readonly runRecordRef?: RunRecordRef;
  readonly priorReviews?: readonly AdvancementRunReview[];
  readonly advancementWindow?: AdvancementWindowState;
  /** owner 已验真的 canonical 独立证据——裁判只能按 evidenceId 引用。 */
  readonly canonicalEvidence?: readonly ReviewEvidence[];
}

/**
 * 一次验收的结果——结论与挂起是两种语义，不用异常做控制流：
 * - reviewed：裁判产出了结论（含 fail-closed 的终局 exit）——落盘、驱动闭环。
 * - deferred：本轮验收未产生结论——基础设施 transient 失败（限流 / 网络 /
 *   取证 IO）或调用被中止。不落盘 review、不前进已审进度，被审 run 保持
 *   「已接受未审」态由补审触发点收敛；过夜任务不因一次抖动永久退出。
 */
export type AdvancementReviewRunOutcome =
  | {
      readonly kind: "reviewed";
      readonly review: AdvancementRunReview;
      readonly advancementWindow?: AdvancementWindowState;
    }
  | {
      readonly kind: "deferred";
      readonly cause: "infrastructure" | "aborted";
      readonly reason: string;
    };
