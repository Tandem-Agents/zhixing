/**
 * 执行守卫 — Phase 2
 *
 * 计算与工具执行相关的运行时约束：超时、输出限制、频率限制。
 * 不实际执行工具——执行由 agent loop / tool runner 负责——
 * 本守卫产出 ExecutionConstraints 挂到 SecurityMiddlewareResult，
 * 由下游执行层应用（通过 wrapWithConstraints 或自行实现）。
 *
 * 两个产出：
 *   1. ExecutionGuardMiddleware —— 管线中间件，在 guard 阶段计算约束
 *   2. wrapWithConstraints      —— 独立工具函数，消费约束执行实际调用
 */

import { SlidingWindowRateLimiter } from "./rate-limiter.js";
import type {
  SecurityDecision,
  SecurityMiddleware,
  SecurityMiddlewareContext,
  SecurityMiddlewareResult,
} from "./types.js";

// ─── 约束类型 ───

export interface ExecutionConstraints {
  /** 最大执行时间（毫秒）；超时强制终止 */
  timeoutMs: number;
  /** 最大输出字节数（stdout + stderr）；超出截断 */
  maxOutputBytes: number;
  /** 本次调用是否被频率限制拒绝 */
  rateLimited: boolean;
  /** 窗口内剩余可用次数 */
  rateRemaining: number;
  /** 频率窗口大小（ms） */
  rateWindowMs: number;
  /** 频率窗口内最大次数 */
  rateLimit: number;
}

/** 单个工具的执行 profile */
export interface ToolExecutionProfile {
  timeoutMs: number;
  maxOutputBytes: number;
}

// ─── 默认 profiles（规格 §5.1 的"5 项检查"之 timeout + 输出限制） ───

const KB = 1024;
const MB = 1024 * KB;

const DEFAULT_PROFILE: ToolExecutionProfile = {
  timeoutMs: 60_000, // 1 分钟（保守默认）
  maxOutputBytes: 2 * MB,
};

/**
 * 工具名 → 执行 profile 的映射。
 *
 * 原则：
 *   - 编译/测试类长跑工具（bash）：宽松
 *   - 精确文件操作（write/edit）：紧凑，不应耗时
 *   - 读类（read/glob/grep）：中等
 */
const DEFAULT_TOOL_PROFILES: Record<string, ToolExecutionProfile> = {
  bash: { timeoutMs: 120_000, maxOutputBytes: 10 * MB },
  shell: { timeoutMs: 120_000, maxOutputBytes: 10 * MB },
  read: { timeoutMs: 10_000, maxOutputBytes: 5 * MB },
  glob: { timeoutMs: 10_000, maxOutputBytes: 2 * MB },
  grep: { timeoutMs: 30_000, maxOutputBytes: 5 * MB },
  write: { timeoutMs: 5_000, maxOutputBytes: 1 * MB },
  edit: { timeoutMs: 5_000, maxOutputBytes: 1 * MB },
  multiedit: { timeoutMs: 5_000, maxOutputBytes: 1 * MB },
};

// ─── 频率限制默认 ───

const DEFAULT_RATE_WINDOW_MS = 60_000; // 1 分钟
const DEFAULT_RATE_MAX_CALLS = 100;

// ─── 守卫选项 ───

export interface ExecutionGuardOptions {
  /** 自定义工具 profile 覆盖（与 DEFAULT_TOOL_PROFILES 合并） */
  toolProfiles?: Record<string, Partial<ToolExecutionProfile>>;
  /** 注入自定义 rate limiter（共享实例可以跨多个 pipeline） */
  rateLimiter?: SlidingWindowRateLimiter;
  /** 默认频率窗口（未提供 rateLimiter 时使用） */
  rateWindowMs?: number;
  /** 默认频率最大次数（未提供 rateLimiter 时使用） */
  rateMaxCalls?: number;
}

// ─── Middleware ───

export class ExecutionGuardMiddleware implements SecurityMiddleware {
  readonly name = "ExecutionGuard";
  readonly phase = "guard" as const;
  readonly order = 30; // guard 阶段最后一步

  private readonly profiles: Record<string, ToolExecutionProfile>;
  private readonly limiter: SlidingWindowRateLimiter;

  constructor(options: ExecutionGuardOptions = {}) {
    this.profiles = this.mergeProfiles(options.toolProfiles);
    this.limiter =
      options.rateLimiter ??
      new SlidingWindowRateLimiter(
        options.rateWindowMs ?? DEFAULT_RATE_WINDOW_MS,
        options.rateMaxCalls ?? DEFAULT_RATE_MAX_CALLS,
      );
  }

  async execute(
    ctx: SecurityMiddlewareContext,
    next: () => Promise<SecurityMiddlewareResult>,
  ): Promise<SecurityMiddlewareResult> {
    const toolName = ctx.toolName.toLowerCase();
    const profile = this.profiles[toolName] ?? DEFAULT_PROFILE;

    // 先 check 不 record——被 block 的调用不应占用配额
    const rateCheck = this.limiter.check(toolName);

    const constraints: ExecutionConstraints = {
      timeoutMs: profile.timeoutMs,
      maxOutputBytes: profile.maxOutputBytes,
      rateLimited: !rateCheck.allowed,
      rateRemaining: rateCheck.remaining,
      rateWindowMs: rateCheck.windowMs,
      rateLimit: rateCheck.limit,
    };
    ctx.state.executionConstraints = constraints;

    if (!rateCheck.allowed) {
      // 频率超限 → 降级为 block 并短路
      const current = ctx.state.decision;
      const blockDecision: SecurityDecision = {
        action: "block",
        matchedRules: current?.matchedRules ?? [],
        reason: `工具 ${toolName} 超过频率限制（${rateCheck.limit} 次/${Math.round(
          rateCheck.windowMs / 1000,
        )}s）`,
        riskLevel: current?.riskLevel ?? "medium",
        suggestion: current?.suggestion,
      };
      ctx.state.decision = blockDecision;
      return {
        allowed: false,
        requiresConfirmation: false,
        operationClass: ctx.state.operationClass,
        decision: blockDecision,
        executionConstraints: constraints,
        reason: blockDecision.reason,
      };
    }

    // 放行：记录一次调用
    this.limiter.record(toolName);
    return next();
  }

  /** 获取底层 rate limiter（便于测试和 /security 命令展示） */
  getRateLimiter(): SlidingWindowRateLimiter {
    return this.limiter;
  }

  private mergeProfiles(
    overrides: Record<string, Partial<ToolExecutionProfile>> | undefined,
  ): Record<string, ToolExecutionProfile> {
    const result: Record<string, ToolExecutionProfile> = {
      ...DEFAULT_TOOL_PROFILES,
    };
    if (overrides) {
      for (const [key, value] of Object.entries(overrides)) {
        const base = result[key.toLowerCase()] ?? DEFAULT_PROFILE;
        result[key.toLowerCase()] = {
          timeoutMs: value.timeoutMs ?? base.timeoutMs,
          maxOutputBytes: value.maxOutputBytes ?? base.maxOutputBytes,
        };
      }
    }
    return result;
  }
}

// ─── wrapWithConstraints：独立工具函数 ───

/**
 * 用执行约束包装异步调用。
 *
 * 调用方负责：
 *   - 提供接收 AbortSignal 的 fn，fn 内部监听 signal 并主动中止
 *   - 在产出输出时自行截断到 maxOutputBytes（本函数不拦截 stdout）
 *
 * 本函数负责：
 *   - rateLimited 时抛出 RateLimitError
 *   - 达到 timeoutMs 时 abort 并抛出 TimeoutError
 *   - 确保 timer 一定被清理（避免内存泄漏）
 */
export class RateLimitError extends Error {
  constructor(public readonly constraints: ExecutionConstraints) {
    super(
      `超过频率限制（${constraints.rateLimit} 次/${Math.round(
        constraints.rateWindowMs / 1000,
      )}s），剩余 ${constraints.rateRemaining}`,
    );
    this.name = "RateLimitError";
  }
}

export class TimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`执行超时（${timeoutMs}ms）`);
    this.name = "TimeoutError";
  }
}

export async function wrapWithConstraints<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  constraints: ExecutionConstraints,
): Promise<T> {
  if (constraints.rateLimited) {
    throw new RateLimitError(constraints);
  }

  const controller = new AbortController();
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await new Promise<T>((resolve, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new TimeoutError(constraints.timeoutMs));
      }, constraints.timeoutMs);

      // 即使 fn 不配合 abort signal，外层 timeoutId 的 reject 也会让
      // Promise.race 立即结束。fn 会在后台继续跑直到自然结束（不可取消的工具）
      // 但 await 已经返回。
      fn(controller.signal).then(resolve, (err) => {
        reject(timedOut ? new TimeoutError(constraints.timeoutMs) : err);
      });
    });
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/**
 * 截断字符串输出到 maxOutputBytes。
 * 返回 { content, truncated }。
 *
 * 注意：按 UTF-8 字节数截断但在字符边界处切分，避免产生坏字符。
 */
export function truncateOutput(
  content: string,
  maxBytes: number,
): { content: string; truncated: boolean; originalBytes: number } {
  const encoded = Buffer.from(content, "utf-8");
  if (encoded.length <= maxBytes) {
    return { content, truncated: false, originalBytes: encoded.length };
  }
  if (maxBytes <= 0) {
    return { content: "", truncated: true, originalBytes: encoded.length };
  }

  // 截断到 maxBytes，然后对齐到完整的 UTF-8 序列边界。
  //
  // 算法：
  //   1. 从末尾向前找到最后一个 sequence 的起始字节
  //   2. 根据 leading byte 判断该序列需要多少字节
  //   3. 若实际字节数不足 → 整个不完整序列从结果中去掉
  let sliced = encoded.subarray(0, maxBytes);
  let cut = sliced.length;

  // 找到最后一个序列的起始位置（连续的 10xxxxxx 是 continuation）
  let seqStart = cut - 1;
  while (seqStart > 0 && (sliced[seqStart]! & 0xc0) === 0x80) {
    seqStart--;
  }

  const lead = sliced[seqStart]!;
  let needed = 1;
  if ((lead & 0x80) === 0) needed = 1; // ASCII (0xxxxxxx)
  else if ((lead & 0xe0) === 0xc0) needed = 2; // 110xxxxx
  else if ((lead & 0xf0) === 0xe0) needed = 3; // 1110xxxx
  else if ((lead & 0xf8) === 0xf0) needed = 4; // 11110xxx
  else needed = 1; // invalid leading byte at start—drop it

  const have = cut - seqStart;
  if (have < needed) {
    cut = seqStart;
  }

  sliced = sliced.subarray(0, cut);
  return {
    content: sliced.toString("utf-8"),
    truncated: true,
    originalBytes: encoded.length,
  };
}
