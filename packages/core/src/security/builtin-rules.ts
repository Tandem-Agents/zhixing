/**
 * 内置安全规则集
 *
 * 规则分为两类：
 * - bypassImmune：绝对不可覆盖，保护最敏感的系统资源
 * - confirm：默认拦截但用户可批准，覆盖常见危险操作模式
 *
 * Phase 1 不设 audit 规则——不加过滤的全量 read 审计会产生大量噪音
 */

import type { SecurityRule } from "./types.js";

export const BUILTIN_RULES: SecurityRule[] = [
  // ═══ bypassImmune：绝对不可覆盖 ═══

  {
    id: "bi-git-write",
    name: "Git 内部文件写保护",
    description: "防止直接修改 .git/ 目录内部文件，避免版本控制被破坏",
    enabled: true,
    match: { type: "path", paths: [".git/"], access: "write" },
    action: "block",
    bypassImmune: true,
    severity: "critical",
    category: "destructive_operation",
    source: "builtin",
    message: "不允许直接修改 .git/ 目录内部文件",
    suggestion: "使用 git 命令操作版本控制",
  },
  {
    id: "bi-ssh-keys",
    name: "SSH 密钥保护",
    description: "保护 SSH 密钥目录免受任何访问",
    enabled: true,
    match: { type: "path", paths: ["~/.ssh/"], access: "any" },
    action: "block",
    bypassImmune: true,
    severity: "critical",
    category: "data_exfiltration",
    source: "builtin",
    message: "不允许访问 SSH 密钥目录",
  },
  {
    id: "bi-env-injection",
    name: "环境变量注入防护",
    description: "阻止设置可用于二进制劫持的环境变量",
    enabled: true,
    match: {
      type: "env_var",
      names: ["LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES"],
    },
    action: "block",
    bypassImmune: true,
    severity: "critical",
    category: "env_manipulation",
    source: "builtin",
    message: "禁止设置可用于二进制劫持的环境变量",
  },

  {
    id: "bi-zhixing-config-write",
    name: "知行配置文件写保护",
    description:
      "修改知行配置目录需要用户确认——包含工作区设置（安全信任边界）和 API 密钥",
    enabled: true,
    match: { type: "path", paths: [".zhixing/"], access: "write" },
    action: "confirm",
    bypassImmune: true,
    severity: "critical",
    category: "privilege_escalation",
    source: "builtin",
    message: "此操作将修改知行配置文件",
    suggestion: "确认修改内容后允许；工作区变更需重启会话生效",
  },
  {
    id: "bi-zhixing-credentials-block",
    name: "知行凭证文件隔离",
    description:
      "AI 不可读、不可写 ~/.zhixing/credentials.json——含 provider apiKey、channel secret 等敏感字段",
    enabled: true,
    match: { type: "path", paths: [".zhixing/credentials.json"], access: "any" },
    action: "block",
    bypassImmune: true,
    severity: "critical",
    category: "data_exfiltration",
    source: "builtin",
    message: "知行凭证文件 ~/.zhixing/credentials.json 不允许 AI 读写——含敏感凭证",
    suggestion:
      "若用户需要修改凭证，请告知用户：(1) 文件位置 ~/.zhixing/credentials.json " +
      "(2) schema：providers.<id>.apiKey、channels.<id>.<field> 与 mcp.<id>.<field> " +
      "(3) 让用户自己编辑该文件，AI 不参与读写",
  },

  // ═══ 需确认：默认拦截但用户可批准 ═══

  {
    id: "cf-path-override",
    name: "PATH 修改确认",
    description: "PATH 环境变量修改可能导致二进制劫持",
    enabled: true,
    match: { type: "env_var", names: ["PATH"] },
    action: "confirm",
    bypassImmune: false,
    severity: "high",
    category: "env_manipulation",
    source: "builtin",
    message: "PATH 环境变量将被修改（可能导致二进制劫持）",
    suggestion:
      "nvm/pyenv/conda 等工具管理器会修改 PATH，如果是这类操作可以允许",
  },
  {
    id: "cf-privilege-escalation",
    name: "权限提升命令",
    description: "检测 sudo、su 等权限提升操作",
    enabled: true,
    match: {
      type: "command_prefix",
      prefixes: ["sudo", "su", "doas", "pkexec"],
    },
    action: "confirm",
    bypassImmune: false,
    severity: "high",
    category: "privilege_escalation",
    source: "builtin",
    message: "此命令将以更高权限执行",
  },
  {
    id: "cf-destructive-commands",
    name: "破坏性命令",
    description: "检测可能导致不可逆数据删除的命令",
    enabled: true,
    match: {
      type: "composite",
      op: "or",
      specs: [
        {
          type: "command",
          pattern: "rm\\s+(-[a-zA-Z]*r[a-zA-Z]*|--recursive)",
          flags: "i",
        },
        { type: "command", pattern: "mkfs|fdisk|dd\\s+", flags: "i" },
        { type: "command_prefix", prefixes: ["format", "diskpart"] },
      ],
    },
    action: "confirm",
    bypassImmune: false,
    severity: "high",
    category: "destructive_operation",
    source: "builtin",
    message: "此命令可能导致不可逆的数据删除",
    suggestion: "建议先备份，或使用更安全的替代命令",
  },
  {
    id: "cf-network-tools",
    name: "网络工具",
    description: "检测网络访问命令",
    enabled: true,
    match: {
      type: "command_prefix",
      prefixes: [
        "curl",
        "wget",
        "nc",
        "ncat",
        "ssh",
        "scp",
        "sftp",
        "ftp",
      ],
    },
    action: "confirm",
    bypassImmune: false,
    severity: "medium",
    category: "network_abuse",
    source: "builtin",
    message: "此命令将访问网络",
  },
  {
    id: "cf-interpreter-exec",
    name: "解释器执行",
    description: "通过解释器执行的代码可以绕过命令级安全检查",
    enabled: true,
    match: {
      type: "interpreter",
      languages: ["python", "node", "ruby", "perl", "php"],
    },
    action: "confirm",
    bypassImmune: false,
    severity: "medium",
    category: "code_injection",
    source: "builtin",
    message: "通过解释器执行的代码可以绕过命令级安全检查",
    suggestion: "建议审查要执行的脚本内容",
  },
  {
    id: "cf-system-config",
    name: "系统配置修改",
    description: "检测系统级配置文件的修改操作",
    enabled: true,
    match: {
      type: "path",
      paths: ["/etc/", "/boot/", "/usr/lib/systemd/"],
      access: "write",
    },
    action: "confirm",
    bypassImmune: false,
    severity: "high",
    category: "privilege_escalation",
    source: "builtin",
    message: "此操作将修改系统配置文件",
  },
];
