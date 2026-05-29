/**
 * 技能起草引擎 —— 把「上下文 / 意图」蒸馏成结构化技能草稿,把「草稿 + 修改指令」改写成
 * 新草稿。这是「创建即策展、agent 当编辑器」的核心:用户用自然语言描述,引擎落笔成
 * name + description + 瘦正文 + mode,用户只做确认 / 微调。
 *
 * v1 / v2 共享插座:v1 接「用户触发 + 屏内策展」,v2 技能管家接「自主复盘触发」——
 * 同一引擎、不同触发方。故引擎只依赖一个注入的窄 LLM 接口、不绑任何运行时:v1 在 cli
 * 绑 callText("main"),v2 在 orchestrator 绑自己的通道,纯增量。
 *
 * LLM 失败语义与安全裁判不同:裁判不确定要 fail-safe(宁可多问),起草不确定就是失败
 * (重说一句即可、无安全含义)—— 故解析不出草稿直接抛,由编辑屏接住、提示重试,不兜底成
 * 半成品草稿。脱敏则是硬约束:草稿源自对话、可能粘过密钥,而技能反复加载又可分享,故每次
 * 产出都过 secret-scrubber,密钥绝不固化进技能。
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

const FORMAT = `严格只输出一个 JSON 对象,不要任何其他文字 / 代码块标记:
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

${FORMAT}`;
}

function buildRevisePrompt(draft: SkillDraft, instruction: string): string {
  return `你是知行的技能起草助手。下面是一个技能草稿的当前内容,以及用户的修改指令。按指令改写,
**保持未被指令触及的字段不变**,产出改后的完整草稿。

${PRINCIPLES.replace("{{MODE}}", draft.mode)}

[当前草稿]
${JSON.stringify(draft)}

[修改指令]
${instruction}

${FORMAT}`;
}

/** 首次起草:从上下文 / 意图产结构化草稿。 */
export async function draftSkill(
  llm: SkillDraftLlm,
  seed: DraftSeed,
): Promise<SkillDraft> {
  return generate(llm, buildDraftPrompt(seed), seed.defaultMode);
}

/** 按指令改写已有草稿。 */
export async function reviseSkill(
  llm: SkillDraftLlm,
  draft: SkillDraft,
  instruction: string,
): Promise<SkillDraft> {
  return generate(llm, buildRevisePrompt(draft, instruction), draft.mode);
}

async function generate(
  llm: SkillDraftLlm,
  prompt: string,
  fallbackMode: SkillMode,
): Promise<SkillDraft> {
  const raw = await llm(prompt);
  return scrubDraft(parseDraft(raw, fallbackMode));
}

/** 从模型输出提取草稿。无 JSON / 解析失败 / 必填字段缺失即抛 —— 起草失败就是失败,不兜底半成品。 */
function parseDraft(raw: string, fallbackMode: SkillMode): SkillDraft {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("起草失败:模型未返回 JSON 草稿");
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    throw new Error("起草失败:草稿 JSON 无法解析");
  }
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

/** 每个文本字段过脱敏 —— 密钥绝不固化进技能(草稿源自对话,可能粘过 secret)。 */
function scrubDraft(draft: SkillDraft): SkillDraft {
  return {
    name: scrubSecrets(draft.name).scrubbed,
    description: scrubSecrets(draft.description).scrubbed,
    body: scrubSecrets(draft.body).scrubbed,
    mode: draft.mode,
  };
}

function asText(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
