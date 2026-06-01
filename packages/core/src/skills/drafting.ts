/**
 * 技能起草引擎 —— 把「上下文 / 意图」蒸馏成结构化技能草稿,把「草稿 + 修改指令」改写成
 * 新草稿。这是「创建即策展、agent 当编辑器」的核心:用户用自然语言描述,引擎落笔成
 * name + description + 瘦正文 + mode,用户只做确认 / 微调。
 *
 * v1 / v2 共享插座:v1 接「用户触发 + 屏内策展」,v2 技能管家接「自主复盘触发」——
 * 同一引擎、不同触发方。故引擎只依赖一个注入的窄 LLM 接口、不绑任何运行时:v1 在 cli
 * 绑 callText("main"),v2 在 orchestrator 绑自己的通道,纯增量。
 *
 * **内容 vs 元信息的边界**:返回值把「落盘内容」与「给用户看的元信息」分开 ——
 * `SkillDraft` 是写进 SKILL.md 的纯内容(name/description/body/mode);`subject`(收的是
 * 哪件事)与 `redactionCount`(抹了几处密钥)是起草过程产出、只服务草稿屏呈现的元信息,
 * **不进磁盘、不进 Store**。日后起草要产出更多元信息(置信度 / 警告)往结果对象加,不污染草稿。
 *
 * LLM 失败语义与安全裁判不同:裁判不确定要 fail-safe(宁可多问),起草不确定就是失败
 * (重说一句即可、无安全含义)—— 故解析不出草稿直接抛,由编辑屏接住、提示重试,不兜底成
 * 半成品草稿。脱敏则是硬约束:草稿源自对话、可能粘过密钥,而技能反复加载又可分享,故每次
 * 产出都过 secret-scrubber,密钥绝不固化进技能;抹了几处经 `redactionCount` 透出供草稿屏可见。
 */

import type { SkillDraft, SkillMode } from "./types.js";
import { scrubSecrets } from "../security/secret-scrubber.js";

/**
 * 起草引擎对 LLM 的最小依赖 —— 一个 prompt 进、文本出(同 mcp 接入 inferLlm 的注入形态)。
 * 装配点绑强档(`callText("main")`):起草 / 改写是质量敏感的撰写任务,不用 light。
 */
export type SkillDraftLlm = (prompt: string) => Promise<string>;

/** 首次起草的依据:对话上下文(从对话入口)与 / 或用户意图一句话(冷启动入口 / 对话入口附带的指向)。 */
export interface DraftSeed {
  context?: string;
  intent?: string;
  /** mode 默认 —— 调用方按当前场景定(工作场景 → `work`,否则 `main`);AI 可在草稿里改写。 */
  defaultMode: SkillMode;
}

/**
 * 首次起草结果 —— 草稿内容 + 两项「给用户看、不落盘」的元信息。
 * 元信息与 `SkillDraft` 分离的理由见文件头注释。
 */
export interface SkillDraftResult {
  draft: SkillDraft;
  /** AI 一句话概括「这个技能收的是哪件事」—— 草稿屏顶部「收自」,搭起草便车产出、零额外 LLM。 */
  subject: string;
  /** 本次起草脱敏抹掉的密钥数 —— 草稿屏据此显隐「已抹掉 N 处密钥」灰字(0 = 不显示)。 */
  redactionCount: number;
}

/** 改写结果 —— 主题不变,故不含 subject;仍回传本次脱敏计数(改写也可能引入 secret)。 */
export interface SkillReviseResult {
  draft: SkillDraft;
  redactionCount: number;
}

/** 首次起草的输出契约 —— 比改写多一个 `subject`(AI 同次产出,零额外调用)。 */
const DRAFT_FORMAT = `严格只输出一个 JSON 对象,不要任何其他文字 / 代码块标记:
{"subject":"一句话说这个技能收的是哪件事(口语、具体,给用户确认方向用,不写进技能)","name":"简短技能名","description":"什么时候该用(决定日后被检索命中,要尖)","body":"正文 markdown(瘦版)","mode":"main"|"work"}`;

/** 改写的输出契约 —— 不含 subject(改写不换主题)。 */
const REVISE_FORMAT = `严格只输出一个 JSON 对象,不要任何其他文字 / 代码块标记:
{"name":"简短技能名","description":"什么时候该用(决定日后被检索命中,要尖)","body":"正文 markdown(瘦版)","mode":"main"|"work"}`;

const PRINCIPLES = `技能 = 用户的特定约定 + 这次踩的坑 / 最优路径,**瘦身**:主动丢掉通用步骤,只留有指向性的部分。
- name:短、可读,会被用来派生 id。
- description:以「什么时候该用」为导向,不是「这是什么」——它直接决定模型日后能否检索命中。
- body:只留特定约定与教训 / 最优路径,通用常识不要写。
- mode:默认 {{MODE}},除非上下文明确指向另一种。`;

function buildDraftPrompt(seed: DraftSeed): string {
  const source =
    [
      seed.context ? `[最近对话上下文]\n${seed.context}` : "",
      seed.intent ? `[用户意图]\n${seed.intent}` : "",
    ]
      .filter(Boolean)
      .join("\n\n") ||
    "(用户尚未说明 —— 产出一个最小空骨架:name 留占位、description 写「待补充」、body 给一行引导。)";

  return `你是知行的技能起草助手。把下面的上下文 / 意图蒸馏成一个技能草稿。

${PRINCIPLES.replace("{{MODE}}", seed.defaultMode)}

${source}

${DRAFT_FORMAT}`;
}

function buildRevisePrompt(draft: SkillDraft, instruction: string): string {
  return `你是知行的技能起草助手。下面是一个技能草稿的当前内容,以及用户的修改指令。按指令改写,
**保持未被指令触及的字段不变**,产出改后的完整草稿。

${PRINCIPLES.replace("{{MODE}}", draft.mode)}

[当前草稿]
${JSON.stringify(draft)}

[修改指令]
${instruction}

${REVISE_FORMAT}`;
}

/** 首次起草:从上下文 / 意图产结构化草稿 + 主题 + 脱敏计数。 */
export async function draftSkill(
  llm: SkillDraftLlm,
  seed: DraftSeed,
): Promise<SkillDraftResult> {
  const obj = parseJson(await llm(buildDraftPrompt(seed)));
  const rawDraft = extractDraft(obj, seed.defaultMode);
  // subject 取 AI 给的;缺失时 fallback 到 description(「什么时候用」近似「收的是什么」)。
  // 也过脱敏(可能源自含 secret 的对话),但它不是草稿内容、不计入 redactionCount。
  const rawSubject = asText(obj["subject"]) || rawDraft.description;
  const { draft, redactionCount } = scrubDraft(rawDraft);
  return { draft, subject: scrubSecrets(rawSubject).scrubbed, redactionCount };
}

/** 按指令改写已有草稿。 */
export async function reviseSkill(
  llm: SkillDraftLlm,
  draft: SkillDraft,
  instruction: string,
): Promise<SkillReviseResult> {
  const obj = parseJson(await llm(buildRevisePrompt(draft, instruction)));
  return scrubDraft(extractDraft(obj, draft.mode));
}

/** 从模型输出提取 JSON 对象。无 JSON / 解析失败即抛 —— 起草失败就是失败,不兜底半成品。 */
function parseJson(raw: string): Record<string, unknown> {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("起草失败:模型未返回 JSON 草稿");
  try {
    return JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    throw new Error("起草失败:草稿 JSON 无法解析");
  }
}

/** 校验 + 取出草稿四字段。必填字段缺失即抛。 */
function extractDraft(
  obj: Record<string, unknown>,
  fallbackMode: SkillMode,
): SkillDraft {
  const name = asText(obj["name"]);
  const description = asText(obj["description"]);
  const body = asText(obj["body"]);
  if (!name || !description || !body) {
    throw new Error("起草失败:草稿缺少 name / description / 正文");
  }
  const mode: SkillMode =
    obj["mode"] === "main" || obj["mode"] === "work" ? obj["mode"] : fallbackMode;
  return { name, description, body, mode };
}

/**
 * 每个文本字段过脱敏 —— 密钥绝不固化进技能(草稿源自对话,可能粘过 secret)。
 * 合并三字段的命中数为 `redactionCount`,透出供草稿屏可见。
 */
function scrubDraft(draft: SkillDraft): {
  draft: SkillDraft;
  redactionCount: number;
} {
  const name = scrubSecrets(draft.name);
  const description = scrubSecrets(draft.description);
  const body = scrubSecrets(draft.body);
  return {
    draft: {
      name: name.scrubbed,
      description: description.scrubbed,
      body: body.scrubbed,
      mode: draft.mode,
    },
    redactionCount:
      name.redactions.length +
      description.redactions.length +
      body.redactions.length,
  };
}

function asText(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
