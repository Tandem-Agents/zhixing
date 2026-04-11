/**
 * Skill Security Scanner — 技能内容安全扫描
 *
 * 所有 skill 写入操作（创建/更新/flush 分流/凝练晋升）在持久化前经过扫描。
 * 防止提示注入、数据外泄、凭证窃取等攻击通过 skill 注入到上下文中。
 *
 * 两级响应：
 * - block: 拒绝写入，抛出 SkillSecurityError
 * - warn: 允许写入，返回警告信息（由调用方决定如何展示）
 */

// ─── 类型 ───

export interface ScanResult {
  safe: boolean;
  threats: ThreatMatch[];
}

export interface ThreatMatch {
  patternId: string;
  matched: string;
  severity: "block" | "warn";
  description: string;
}

interface ThreatPattern {
  id: string;
  description: string;
  severity: "block" | "warn";
  test: (content: string) => string | null;
}

export class SkillSecurityError extends Error {
  constructor(public readonly threats: ThreatMatch[]) {
    const descriptions = threats.map((t) => `[${t.patternId}] ${t.description}`);
    super(`Skill content blocked by security scan:\n${descriptions.join("\n")}`);
    this.name = "SkillSecurityError";
  }
}

// ─── 威胁模式定义 ───

const THREAT_PATTERNS: ThreatPattern[] = [
  // 提示注入
  {
    id: "injection-override",
    description: "Prompt injection: attempts to override previous instructions",
    severity: "block",
    test: (s) => matchRegex(s, /ignore\s+(previous|above|all|prior)\s+instructions/i),
  },
  {
    id: "injection-role-reassign",
    description: "Prompt injection: attempts to reassign agent role",
    severity: "block",
    test: (s) => matchRegex(s, /you\s+are\s+(now|no\s+longer)\s+/i),
  },
  {
    id: "injection-system-prefix",
    description: "Prompt injection: system prompt prefix pattern",
    severity: "block",
    test: (s) => matchRegex(s, /^\s*system\s*:\s+/im),
  },
  {
    id: "injection-new-instructions",
    description: "Prompt injection: new instructions pattern",
    severity: "block",
    test: (s) => matchRegex(s, /\bnew\s+instructions?\s*:/i),
  },

  // 数据外泄
  {
    id: "exfil-curl",
    description: "Potential data exfiltration via curl to external URL",
    severity: "block",
    test: (s) => matchRegex(s, /curl\s+[^|]*https?:\/\/(?!localhost|127\.0\.0\.1)/i),
  },
  {
    id: "exfil-wget",
    description: "Potential data exfiltration via wget",
    severity: "block",
    test: (s) => matchRegex(s, /wget\s+[^|]*https?:\/\//i),
  },
  {
    id: "exfil-fetch-api",
    description: "Potential data exfiltration via fetch API",
    severity: "block",
    test: (s) => matchRegex(s, /fetch\s*\(\s*['"`]https?:\/\/(?!localhost)/i),
  },

  // 凭证读取
  {
    id: "cred-ssh-key",
    description: "Attempts to access SSH private keys",
    severity: "block",
    test: (s) => matchRegex(s, /\.ssh\/(id_rsa|id_ed25519|id_ecdsa|authorized_keys)/i),
  },
  {
    id: "cred-dotenv-read",
    description: "Attempts to read .env files via shell",
    severity: "block",
    test: (s) => matchRegex(s, /cat\s+.*\.env\b/i),
  },
  {
    id: "cred-env-access",
    description: "Direct access to environment variables",
    severity: "warn",
    test: (s) => matchRegex(s, /process\.env\[/i),
  },

  // 不可见字符（常见注入载体）
  {
    id: "invisible-unicode",
    description: "Contains invisible Unicode characters (common injection vector)",
    severity: "block",
    test: (s) => {
      const match = s.match(/[\u200B-\u200F\u2028-\u202F\uFEFF\u2060-\u2064]/);
      return match ? match[0] : null;
    },
  },
];

// ─── 扫描器 ───

/**
 * 扫描技能内容是否包含安全威胁。
 * 同时检查 frontmatter 中的文本字段和 Markdown 正文。
 */
export function scanSkillContent(
  meta: { title?: string; tags?: string[]; triggers?: string[] },
  content: string,
): ScanResult {
  const searchable = buildSearchableText(meta, content);
  const threats: ThreatMatch[] = [];

  for (const pattern of THREAT_PATTERNS) {
    const matched = pattern.test(searchable);
    if (matched !== null) {
      threats.push({
        patternId: pattern.id,
        matched: matched.slice(0, 100),
        severity: pattern.severity,
        description: pattern.description,
      });
    }
  }

  return {
    safe: threats.length === 0,
    threats,
  };
}

/**
 * 检查扫描结果是否包含 block 级别的威胁。
 */
export function hasBlockingThreats(result: ScanResult): boolean {
  return result.threats.some((t) => t.severity === "block");
}

/**
 * 获取 warn 级别的威胁（允许写入但需提示用户）。
 */
export function getWarnings(result: ScanResult): ThreatMatch[] {
  return result.threats.filter((t) => t.severity === "warn");
}

// ─── 内部 ───

function buildSearchableText(
  meta: { title?: string; tags?: string[]; triggers?: string[] },
  content: string,
): string {
  const parts: string[] = [];
  if (meta.title) parts.push(meta.title);
  if (meta.tags) parts.push(meta.tags.join(" "));
  if (meta.triggers) parts.push(meta.triggers.join(" "));
  parts.push(content);
  return parts.join("\n");
}

function matchRegex(text: string, pattern: RegExp): string | null {
  const match = text.match(pattern);
  return match ? match[0] : null;
}
