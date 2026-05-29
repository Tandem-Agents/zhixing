/**
 * 通用 secret 脱敏 —— 把文本里的高置信凭证模式替换成带类别的占位符。
 *
 * 系统层通用件(非 skill 专属):任何"会被固化、反复加载进上下文、且设计上可分享"的
 * 文本落地前都该过一遍 —— 技能正文是首个消费者(草稿源自对话、对话里可能粘过密钥,
 * 而技能反复加载又可分享,危害被放大),未来的分享导出 / 日志凝练等同理共用此件。
 *
 * 设计取舍:只匹配**高置信**模式 —— 已知服务商密钥前缀、PEM 私钥块、JWT、Bearer、
 * 明确的「字段名=值」赋值。**不做高熵串猜测**:通用件宁可漏掉罕见自定义格式,也绝不能
 * 把正常长串(git sha、UUID、base64 图片、哈希)误当 secret 毁掉正文 —— 误伤正文的
 * 代价比漏一个非标准密钥更高,而标准密钥才是对话里真正会粘进来的那批。命中处替换成
 * 带类别的占位符,让用户一眼看出「这里原本有个什么被脱敏了」,而非凭空消失。
 */

/** 一次脱敏命中(按出现顺序)。`category` 仅供报告 / 断言,不参与匹配。 */
export interface SecretRedaction {
  category: string;
}

export interface ScrubResult {
  /** 脱敏后文本;无命中时逐字等于输入。 */
  scrubbed: string;
  /** 命中记录;空数组 = 文本里没有可识别的 secret。 */
  redactions: SecretRedaction[];
}

const placeholder = (category: string): string => `«已脱敏:${category}»`;

/** 占位符前缀 —— 赋值式扫描据此跳过「值已被前序整体模式替换」的情况,避免二次命中。 */
const PLACEHOLDER_PREFIX = "«已脱敏";

/**
 * 整体即 secret 的模式(命中即全段替换)。顺序敏感:更具体的前缀(`sk-ant-`)必须排在
 * 更宽的(`sk-`)之前,否则宽模式先吃掉、具体类别永不命中。
 */
const WHOLE_PATTERNS: ReadonlyArray<{ category: string; re: RegExp }> = [
  // PEM 私钥块(跨行整体)—— BEGIN..END 之间全是密钥材料。
  {
    category: "private-key",
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  // 服务商密钥前缀(高置信,几乎不可能是正常文本)。
  { category: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { category: "openai-key", re: /\bsk-[A-Za-z0-9]{20,}/g },
  { category: "github-token", re: /\bgh[posur]_[A-Za-z0-9]{20,}/g },
  { category: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { category: "google-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { category: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  // JWT(三段 base64url,以 base64 编码的 `{"` = `eyJ` 起头)。
  {
    category: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  // Bearer / Authorization 携带的 token。
  { category: "bearer", re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g },
];

/**
 * 赋值式:`字段名 = 值` / `字段名: 值`。保留字段名与分隔符、只替换值 —— 让用户看到
 * 「这里有个 api_key 被脱敏」的结构。值要求 ≥6 字符以滤掉 `token: a` 这类显然非密钥。
 */
const ASSIGNMENT_RE =
  /\b(api[_-]?key|apikey|access[_-]?key|secret(?:[_-]?key)?|client[_-]?secret|token|password|passwd|pwd|auth[_-]?token|private[_-]?key)(\s*[:=]\s*)(['"]?)([^\s'"]{6,})\3/gi;

/**
 * 脱敏一段文本。先扫「整体即 secret」模式,再扫赋值式 —— 赋值式跳过值已是占位符的命中,
 * 避免把前序替换出的占位符当成新值二次脱敏 / 重复计数。
 */
export function scrubSecrets(text: string): ScrubResult {
  const redactions: SecretRedaction[] = [];
  let out = text;

  for (const { category, re } of WHOLE_PATTERNS) {
    out = out.replace(re, () => {
      redactions.push({ category });
      return placeholder(category);
    });
  }

  out = out.replace(
    ASSIGNMENT_RE,
    (full, field: string, sep: string, quote: string, value: string) => {
      // 值已是前序整体模式产出的占位符 → 不重复脱敏(如 `Authorization: Bearer xxx`
      // 里 token 已被 bearer 模式替换,此处保留)。
      if (value.startsWith(PLACEHOLDER_PREFIX)) return full;
      redactions.push({ category: "credential" });
      // 保留字段名 + 分隔符 + 原引号,只把值换成占位符。
      return `${field}${sep}${quote}${placeholder("credential")}${quote}`;
    },
  );

  return { scrubbed: out, redactions };
}
