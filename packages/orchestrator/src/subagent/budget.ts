/**
 * 子 agent 资源预算
 *
 * 定义子 agent 单次 dispatch 的 4 项硬上限 + 1 项确认策略。所有字段都可选,
 * 不传走默认值。默认值面向"调研型短任务"(Task 工具的核心价值)调整,与主 agent
 * 默认值刻意不同:
 *   - 主默认 maxTurns=100  / 子默认 maxTurns=20    (子专注短链)
 *   - 主无 token 软上限    / 子默认 maxTokens=50_000  (防失控烧钱)
 *   - 主无 wallClock       / 子默认 wallClock=10 分钟 (调研型有时限)
 *
 * 默认值集中在此文件而非散落到 factory.ts,便于:
 *   - 配置层(future zhixing.config.json `intent.subagent.*`) 单点覆盖
 *   - 单测断言"未指定 budget 时取了哪些默认值"
 *   - 调优:运行一段时间后调整默认,不需要触碰业务代码
 */

/** confirmation 子策略 —— v1 集合 (v2+ 会扩展 inherit-or-prompt 等) */
export type SubAgentConfirmationPolicy =
  | "inherit-or-deny"
  | "auto-deny"
  | "auto-approve";

export interface SubAgentBudget {
  /** 子 agent loop 最大交互轮次,达到后终止 (透传 runAgentLoop.maxTurns) */
  maxTurns?: number;
  /**
   * 单子 agent 累计 token 软上限。
   * 触发时机:每次 LLM call 完成后检查,超则下一次 call 前停 (graceful,不 mid-call kill);
   * partial assistant 文本作为 finalAssistantText 返回。
   */
  maxTokens?: number;
  /** 子 LLM 流 idle 超时 (ms),走主模块 idle watchdog 协议 */
  llmIdleTimeoutMs?: number;
  /** 子 agent 总 wall-clock 超时 (ms);setTimeout 触发 abort with origin="subagent-wall-clock-timeout" */
  wallClockTimeoutMs?: number;
  /** confirmation 决策策略,缺省 "inherit-or-deny" */
  confirmationPolicy?: SubAgentConfirmationPolicy;
}

// ─── 默认值 ───

/** 子专注短链,主默认 100;子调研任务通常 < 10 turn 完成,20 是安全余量 */
export const DEFAULT_SUB_MAX_TURNS = 20;

/** 50K 软上限对应约 ~50 次 read+grep + 几次 LLM 思考,覆盖 95% 调研任务 */
export const DEFAULT_SUB_MAX_TOKENS = 50_000;

/** 与主模块 watchdog 默认一致 (60s),保持调试预期一致;子任务静默时长不应短于主 */
export const DEFAULT_SUB_IDLE_TIMEOUT_MS = 60_000;

/** 10 分钟兜底,长调研 (大文件 grep / 多步 web fetch) 也够用 */
export const DEFAULT_SUB_WALL_CLOCK_MS = 600_000;

/** 默认确认策略 —— 安全为先,broker 无 listener 时 fail-deny */
export const DEFAULT_SUB_CONFIRMATION_POLICY: SubAgentConfirmationPolicy =
  "inherit-or-deny";

// ─── resolver helper ───

/**
 * 把 SubAgentBudget (可能稀疏) 投影成全字段 Required<>,缺省字段填默认值。
 *
 * factory / loop-runner 走 resolveSubAgentBudget(budget) 拿到的对象保证字段
 * 完备,内部代码不需要再写 `?? DEFAULT_*` 散落各处。
 */
export interface ResolvedSubAgentBudget {
  readonly maxTurns: number;
  readonly maxTokens: number;
  readonly llmIdleTimeoutMs: number;
  readonly wallClockTimeoutMs: number;
  readonly confirmationPolicy: SubAgentConfirmationPolicy;
}

export function resolveSubAgentBudget(
  budget: SubAgentBudget | undefined,
): ResolvedSubAgentBudget {
  return {
    maxTurns: budget?.maxTurns ?? DEFAULT_SUB_MAX_TURNS,
    maxTokens: budget?.maxTokens ?? DEFAULT_SUB_MAX_TOKENS,
    llmIdleTimeoutMs: budget?.llmIdleTimeoutMs ?? DEFAULT_SUB_IDLE_TIMEOUT_MS,
    wallClockTimeoutMs:
      budget?.wallClockTimeoutMs ?? DEFAULT_SUB_WALL_CLOCK_MS,
    confirmationPolicy:
      budget?.confirmationPolicy ?? DEFAULT_SUB_CONFIRMATION_POLICY,
  };
}
