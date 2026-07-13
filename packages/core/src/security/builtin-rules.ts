/**
 * 内置安全规则集
 *
 * 规则分为两类：
 * - bypassImmune：绝对不可覆盖，保护最敏感的系统资源
 * - confirm：默认拦截但用户可批准，覆盖常见危险操作模式
 *
 * 不设无过滤的全量 read audit 规则，以免产生无法行动的噪音
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
      "修改知行配置目录需要用户确认——其中包含工作区设置等安全信任边界",
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
    name: "知行秘密存储隔离",
    description:
      "AI 不可访问 SecretStore 文件族或旧版 credentials.json；只有产品组合根与启动迁移器可以触达",
    enabled: true,
    match: {
      type: "path",
      paths: [".zhixing/credentials.json", ".zhixing/secret-vault"],
      access: "any",
    },
    action: "block",
    bypassImmune: true,
    severity: "critical",
    category: "data_exfiltration",
    source: "builtin",
    message: "知行设备本地凭据与秘密存储不允许 AI 访问",
    suggestion:
      "如需修改凭据，请让用户在目标设备运行 `zz` 或 `/config`，通过 SecretStore 专用流程完成",
  },
  {
    id: "bi-os-credential-store",
    name: "系统凭据库隔离",
    description: "AI 不可通过平台命令读取、导出或改写系统凭据库",
    enabled: true,
    match: {
      type: "command",
      pattern:
        "(?:secret-tool|keyctl|cmdkey(?:\\.exe)?|vaultcmd(?:\\.exe)?)(?:[\\\"']?\\s|$)|" +
        "security[\\\"']?\\s+(?:-[A-Za-z]+\\s+)*(?:find-|add-|delete-|dump-keychain|unlock-keychain|set-keychain-password|import\\b|export\\b)",
      flags: "i",
    },
    action: "block",
    bypassImmune: true,
    severity: "critical",
    category: "data_exfiltration",
    source: "builtin",
    message: "系统凭据库不允许 AI 访问",
    suggestion: "请通过知行的 SecretStore 专用配置流程管理设备凭据",
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
