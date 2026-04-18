/**
 * ScenarioEvaluator — Turn 1 场景分类 + Sticky 升级守卫
 *
 * 规格引用：context-architecture.md §10.2
 *
 * 设计原则：
 * - 零 LLM 成本：分类完全基于关键词/模式匹配，不调模型
 * - Turn 1 一次分类，之后 Sticky 持久
 * - 单调升级铁律：hint 只能向更高 level 转换（lookup→interactive→social）
 * - autonomous 由业务代码创建时硬编码，运行时不可变
 * - 纯函数设计，无状态，完全可测试
 */

import { type ScenarioHint, hintLevel } from "./context-profile.js";

// ─── 关键词分类器 ───

/**
 * 关键词分类信号。
 * 返回 null 表示未命中任何特征模式，应使用默认 hint。
 */
export type KeywordClassification = "lookup" | "social" | null;

// social 信号：人物关系、社交行为、情感分析
const SOCIAL_PATTERNS: readonly RegExp[] = [
  // 中文：社交动词 + 人称/称谓
  /(?:联系|约|陪|安慰|鼓励|感谢|道歉|祝福|提醒|通知|转告|回复)(?:他|她|他们|同事|朋友|家人|老板|领导|客户)/,
  // 中文：人称 + 情感/状态描述
  /(?:他|她|他们|同事|朋友|家人|老板|领导|客户|老公|老婆|女朋友|男朋友)(?:.*?)(?:冷淡|生气|高兴|难过|担心|不开心|烦|焦虑|忙|态度)/,
  // 中文：直接指名 + 社交动词
  /给.{1,8}(?:发消息|打电话|发邮件|写信|说一下|带个话|问好)/,
  // 中文：关系词 + 分析/建议
  /(?:关系|相处|沟通|矛盾|误会|信任).*(?:怎么|如何|建议|办)/,
  // English social patterns
  /\b(?:talk|speak|message|email|call|meet|visit|thank|apologize|congratulate)\s+(?:to|with|him|her|them)\b/i,
  /\b(?:relationship|colleague|friend|family|boss|partner)\b.*\b(?:advice|help|issue|problem)\b/i,
];

// lookup 信号：短消息 + 事实查询模式
const LOOKUP_PATTERNS: readonly RegExp[] = [
  // 中文：典型查询句式
  /^.{0,6}(?:什么是|是什么|怎么(?:样|说|读|写|用)|如何(?:理解|使用)|多少|几个|几点|哪个|哪里|谁是|有没有).{0,30}[？?]?$/,
  // 中文：天气/时间/汇率等即时查询
  /(?:天气|温度|汇率|时间|日期|价格|股价|限号)/,
  // 中文：简短定义查询（整体 ≤ 40 字符）
  /^.{1,40}(?:是什么|啥意思|什么意思|怎么理解)[？?]?$/,
  // English: factual queries
  /^(?:what|who|when|where|how\s+(?:many|much|old|long|far|to))\b.{0,60}[?]?$/i,
  // English: definition queries
  /^(?:define|explain|meaning\s+of)\b/i,
];

// lookup 排除信号：包含这些则不是简单查询
const LOOKUP_EXCLUSIONS: readonly RegExp[] = [
  // 代码相关
  /(?:重构|实现|修改|修复|编写|创建|删除|部署|测试|调试|优化)/,
  /(?:refactor|implement|modify|fix|create|delete|deploy|debug|optimize)\b/i,
  // 文件路径
  /[/\\][\w.-]+\.\w{1,5}\b/,
  // 多行或很长的消息不是 lookup
  /\n/,
];

/** 消息长度超过此值时不考虑 lookup（长消息通常不是简单查询） */
const LOOKUP_MAX_LENGTH = 80;

/**
 * 基于关键词/模式对用户消息进行场景分类。
 *
 * 返回 null 表示未命中，调用方应使用 'interactive' 作为默认值。
 * 准确率 80%+ 即可——首轮判错成本很低（spec §10.2.2）。
 */
export function classifyByKeywords(userMessage: string): KeywordClassification {
  const text = userMessage.trim();
  if (!text) return null;

  // social 检测（优先级高于 lookup）
  for (const pattern of SOCIAL_PATTERNS) {
    if (pattern.test(text)) return "social";
  }

  // lookup 检测：短消息 + 匹配查询模式 + 不含排除信号
  if (text.length <= LOOKUP_MAX_LENGTH) {
    const hasLookupSignal = LOOKUP_PATTERNS.some((p) => p.test(text));
    if (hasLookupSignal) {
      const hasExclusion = LOOKUP_EXCLUSIONS.some((p) => p.test(text));
      if (!hasExclusion) return "lookup";
    }
  }

  return null;
}

// ─── Hint 解析 ───

/** Turn 1 初始分类的输入 */
export interface InitialHintContext {
  /** 业务代码硬编码的 hint（如 BackgroundAgent → autonomous） */
  hintOverride?: ScenarioHint;
  /** 用户首条消息文本 */
  userMessage: string;
}

/**
 * Turn 1 初始分类。
 *
 * 优先级（spec §10.2.2）：
 * P2: 业务代码硬编码（hintOverride）
 * P3: 关键词分类器
 * 默认: interactive
 */
export function resolveInitialHint(ctx: InitialHintContext): ScenarioHint {
  if (ctx.hintOverride) return ctx.hintOverride;

  const classified = classifyByKeywords(ctx.userMessage);
  if (classified) return classified;

  return "interactive";
}

/** Turn 2+ hint 解析的输入 */
export interface CurrentHintContext {
  /** 当前 conversation 的 hint */
  currentHint: ScenarioHint;
  /** AI 在上一 Turn 请求的升级目标（scenario.escalate 的结果） */
  agentEscalation?: ScenarioHint;
  /** 上一 Turn 中 AI 是否执行了写操作（mutation tool） */
  prevAgentDidMutation?: boolean;
  /** 当前 conversation 的总 turn 数 */
  turnCount: number;
}

/** lookup 自动升级为 interactive 的 turn 阈值 */
const LOOKUP_AUTO_UPGRADE_TURNS = 3;

/**
 * Turn 2+ hint 解析：Sticky + 单调升级守卫。
 *
 * 规则（spec §10.2.3）：
 * 1. autonomous 运行时不可变，直接返回
 * 2. AI 升级请求（agentEscalation）受单调性约束——只能升不能降
 * 3. lookup 自动升级守卫：AI 做了 mutation 或 turnCount > 3 → interactive
 * 4. 其余情况 Sticky：保持当前 hint
 */
export function resolveCurrentHint(ctx: CurrentHintContext): ScenarioHint {
  const { currentHint, agentEscalation, prevAgentDidMutation, turnCount } = ctx;

  // autonomous 由业务代码创建时硬编码，运行时不可变
  if (currentHint === "autonomous") return currentHint;

  // AI 主动升级（必须满足单调性——只能升，不能降）
  if (agentEscalation && hintLevel(agentEscalation) > hintLevel(currentHint)) {
    return agentEscalation;
  }

  // lookup 自动升级守卫（系统级，唯一的自动转换路径）
  if (currentHint === "lookup") {
    if (prevAgentDidMutation) return "interactive";
    if (turnCount > LOOKUP_AUTO_UPGRADE_TURNS) return "interactive";
  }

  // Sticky：保持当前 hint
  return currentHint;
}

// ─── 便捷组合函数 ───

/**
 * 根据 turn 阶段自动选择初始分类或当前解析。
 *
 * 这是上层（prepareTurn / ContextEngine）的推荐入口：
 * - turnCount === 0（首轮）→ resolveInitialHint
 * - turnCount > 0 → resolveCurrentHint
 */
export function evaluateScenario(ctx: {
  turnCount: number;
  userMessage: string;
  currentHint?: ScenarioHint;
  hintOverride?: ScenarioHint;
  agentEscalation?: ScenarioHint;
  prevAgentDidMutation?: boolean;
}): ScenarioHint {
  if (ctx.turnCount === 0 || ctx.currentHint === undefined) {
    return resolveInitialHint({
      hintOverride: ctx.hintOverride,
      userMessage: ctx.userMessage,
    });
  }

  return resolveCurrentHint({
    currentHint: ctx.currentHint,
    agentEscalation: ctx.agentEscalation,
    prevAgentDidMutation: ctx.prevAgentDidMutation,
    turnCount: ctx.turnCount,
  });
}
