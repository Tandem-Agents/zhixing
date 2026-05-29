/**
 * 接入技能的静态内容扫描 —— 外来技能的第一道闸:对暂存的技能文本做 prompt 注入 / 信息
 * 外泄 / 窃凭证模式的审查,产出威胁信号。
 *
 * 定位是**信号收集、不是终判**:静态正则只锚定明显的恶意结构(诱导无视既有指令、把对话 /
 * 凭证发往外部、读取凭证文件),命中即记一条威胁喂给后续 AI 语义研判与用户确认。**不靠它
 * 单独挡死**——正则会把正常技能正文里偶然出现的词误判,故终判交语义复核;扫描器只负责"宁可
 * 多给一个信号",模式因此锚定结构(动词 + 目标)而非单个敏感词,把误报压到可接受。
 *
 * `BUILTIN_RULES` 全是 path / command / env_var / interpreter 匹配、无文本内容扫描,故这层
 * 自建;威胁类别对齐既有 `ThreatCategory`,与运行期安全管线同一套语汇。
 */

import type { ThreatCategory } from "../security/types.js";

export interface ContentThreat {
  category: ThreatCategory;
  /** 命中的模式可读名(供展示 / 断言)。 */
  rule: string;
  /** 命中的文本片段(截断,供用户判断)。 */
  excerpt: string;
}

interface ScanRule {
  category: ThreatCategory;
  rule: string;
  re: RegExp;
}

const RULES: readonly ScanRule[] = [
  // ─── prompt 注入:诱导无视既有指令 / 越权改变 agent 行为 ───
  {
    category: "prompt_injection",
    rule: "ignore-previous",
    re: /ignore\s+(?:all\s+)?(?:previous|prior|the\s+above)\s+(?:instructions?|prompts?|messages?)/i,
  },
  {
    category: "prompt_injection",
    rule: "disregard-above",
    re: /disregard\s+(?:the\s+)?(?:above|previous|system\s+prompt|all\s+prior)/i,
  },
  {
    category: "prompt_injection",
    rule: "override-role",
    re: /you\s+are\s+now\s+(?:a\s+|an\s+)?(?:different|new|unrestricted|developer\s+mode|dan)\b/i,
  },
  {
    category: "prompt_injection",
    rule: "忽略指令",
    re: /(?:忽略|无视|忽视|不要遵守)(?:之前|以上|前面|上述|先前|系统)?.{0,6}(?:指令|提示|要求|规则|设定)/,
  },
  // ─── 信息外泄:把对话 / 凭证发往外部、或读取凭证文件 ───
  {
    category: "data_exfiltration",
    rule: "send-data-out",
    re: /(?:send|post|upload|exfiltrate|leak|forward)\b[\s\S]{0,40}(?:conversation|chat\s*history|secrets?|credentials?|password|token|api[\s_-]?key)/i,
  },
  {
    category: "data_exfiltration",
    rule: "read-credential-file",
    re: /(?:cat|read|type|open|access)\b[\s\S]{0,24}(?:\.ssh\b|\.aws\/credentials|id_rsa|\.env\b|credentials\.json)/i,
  },
  {
    category: "data_exfiltration",
    rule: "外泄凭证",
    re: /(?:发送|上传|外传|回传|泄露|外发)[\s\S]{0,12}(?:对话|凭证|密钥|密码|token|secret)/,
  },
];

const EXCERPT_MAX = 80;

/** 扫描技能文本,返回命中的威胁信号(每条规则至多一条,取首个命中片段)。 */
export function scanSkillContent(text: string): ContentThreat[] {
  const threats: ContentThreat[] = [];
  for (const { category, rule, re } of RULES) {
    const m = re.exec(text);
    if (m) {
      const hit = m[0];
      threats.push({
        category,
        rule,
        excerpt: hit.length <= EXCERPT_MAX ? hit : `${hit.slice(0, EXCERPT_MAX - 1)}…`,
      });
    }
  }
  return threats;
}
