/**
 * 静态约束测试：cli 运行时模块禁止直接 console.log / process.stdout.write 推走 chrome。
 *
 * 协议：
 *   - 所有写屏走 CliWriter（src/screen/cli-writer.ts）协调，让 ScreenController 维护
 *     "持久 input chrome" 不变量
 *   - 新加直接 console.log / process.stdout.write 会破坏 chrome（推走 input region），
 *     用此测试在 CI 阶段拦住，强制走 cliWriter.line / cliWriter.notify
 *
 * 例外清单（ALLOW_LIST）：
 *   - 早期路径（chrome 未建立）：bin entry / startup-check 失败
 *   - 后端/非交互路径：serve daemon / rpc client / setup-channels logger
 *   - dispose 路径：process.exit 之前的清理日志
 *   - CliWriter 实现本身（StdoutWriter 内部用 stdout.write）
 *   - 测试文件 / 手动测试 (__manual__)
 */

import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/**
 * 允许直接 console.log / process.stdout.write 的文件——按相对 src/ 路径精确匹配。
 *
 * 规则：每条都附带 reason，让未来审查 PR 时能判断新增条目是否合理。
 *  - bin / startup 入口：chrome 未建立，console 是唯一可用通道
 *  - daemon / RPC：无 chrome 协调（独立进程或 stdout-as-protocol）
 *  - dispose：清理日志在 process.exit 之前，chrome 已 detach
 *  - cli-writer.ts：CliWriter 实现本身，stdout.write 是 StdoutWriter 的合法实现
 *  - __manual__ / __tests__：手动测试 / 单元测试模拟，不是运行时
 */
const ALLOW_LIST: ReadonlyArray<{ readonly file: string; readonly reason: string }> = [
  { file: "index.ts", reason: "bin 入口 startup-check 失败路径——chrome 未建立" },
  { file: "screen/cli-writer.ts", reason: "CliWriter 实现本身——StdoutWriter 直写 stdout 是合法语义" },
  { file: "screen/screen-controller.ts", reason: "ScreenController 实现本身——是 stdout 协调的最底层" },
  { file: "rpc/command.ts", reason: "RPC 客户端——stdout 是协议输出（非 cli 交互）" },
  { file: "serve/command.ts", reason: "serve daemon——后台进程无 chrome；setup chrome 之前的 logger" },
  { file: "serve/daemon.ts", reason: "daemon 启动诊断——chrome 未建立" },
  { file: "serve/logs.ts", reason: "serve logs 命令——独立子命令，stdout 是输出主 sink" },
  { file: "serve/status.ts", reason: "serve status 命令——独立子命令" },
  { file: "serve/stop.ts", reason: "serve stop 命令——独立子命令" },
  { file: "serve/channels.ts", reason: "channel setup logger——bootstrap 时 chrome 未建立" },
  { file: "serve/session-adapter.ts", reason: "serve 会话适配器——后台路径" },
  { file: "serve/ephemeral-executor.ts", reason: "serve 临时执行器——后台路径" },
  { file: "runtime/session.ts", reason: "RuntimeSession bootstrap / dispose 路径——chrome 未建立或已 detach" },
  { file: "setup-delivery.ts", reason: "delivery 装配 logger——bootstrap 时 chrome 未建立" },
  { file: "security/keypress-dump.ts", reason: "诊断通道——`--log` flag 启用时 stderr 提示日志路径；与 llm-chunk-dump 同模式，仅诊断不影响生产路径" },
];

const ALLOWED_DIR_PREFIXES: readonly string[] = [
  "tui/__manual__/",
  "config-editor/", // 进入 alt-screen 全屏接管，不与 chrome 共存
  "security/terminal-renderer.ts", // 进入 alt-screen 接管 stdin
];

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
}

async function walk(dir: string, base: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const rel = path.posix.join(base, e.name);
    if (e.isDirectory()) {
      if (e.name === "__tests__" || e.name === "__manual__" || e.name === "node_modules") {
        continue;
      }
      out.push(...(await walk(abs, rel)));
    } else if (e.isFile() && (e.name.endsWith(".ts") || e.name.endsWith(".tsx"))) {
      out.push(rel);
    }
  }
  return out;
}

function isAllowed(rel: string): boolean {
  if (ALLOW_LIST.some((entry) => entry.file === rel)) return true;
  return ALLOWED_DIR_PREFIXES.some((prefix) => rel.startsWith(prefix));
}

const FORBIDDEN_PATTERNS: ReadonlyArray<{ readonly regex: RegExp; readonly label: string }> = [
  { regex: /\bconsole\.log\s*\(/, label: "console.log" },
  { regex: /\bconsole\.error\s*\(/, label: "console.error" },
  { regex: /\bconsole\.warn\s*\(/, label: "console.warn" },
  { regex: /\bprocess\.stdout\.write\s*\(/, label: "process.stdout.write" },
  { regex: /\bprocess\.stderr\.write\s*\(/, label: "process.stderr.write" },
];

/** 行级豁免——本行或上一行含此 token 的违反不计，用于终端控制序列等合法场景 */
const ALLOW_INLINE_TOKEN = "allow-direct-stdout";

async function scanFile(rel: string): Promise<Violation[]> {
  const abs = path.join(SRC_DIR, rel);
  const content = await fs.readFile(abs, "utf-8");
  const lines = content.split("\n");
  const violations: Violation[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // 跳过注释行（以 // 或 * 起首，trim 后）
    const trimmed = line.trim();
    if (
      trimmed.startsWith("//") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("/*")
    )
      continue;
    for (const { regex, label } of FORBIDDEN_PATTERNS) {
      if (regex.test(line)) {
        // 行级豁免：本行或紧邻上一行含 ALLOW_INLINE_TOKEN
        const prev = i > 0 ? lines[i - 1]! : "";
        if (
          line.includes(ALLOW_INLINE_TOKEN) ||
          prev.includes(ALLOW_INLINE_TOKEN)
        ) {
          break;
        }
        violations.push({
          file: rel,
          line: i + 1,
          snippet: `${label} → ${line.trim().slice(0, 100)}`,
        });
        break;
      }
    }
  }
  return violations;
}

describe("cli 运行时模块禁止直接 console / stdout.write", () => {
  it("除允许清单外，所有 .ts 文件不得直接调用 console.log/error/warn / process.stdout.write", async () => {
    const allFiles = await walk(SRC_DIR, "");
    const checkFiles = allFiles.filter(
      (f) => !isAllowed(f) && !f.includes("__tests__"),
    );

    const allViolations: Violation[] = [];
    for (const f of checkFiles) {
      const v = await scanFile(f);
      allViolations.push(...v);
    }

    if (allViolations.length > 0) {
      const report = allViolations
        .map((v) => `  ${v.file}:${v.line}  ${v.snippet}`)
        .join("\n");
      throw new Error(
        `Found ${allViolations.length} direct console / stdout.write call(s) — please use cliWriter.line / cliWriter.notify instead, or add to ALLOW_LIST with justification:\n${report}`,
      );
    }
    expect(allViolations.length).toBe(0);
  });

  it("ALLOW_LIST 条目应该都存在——防止条目过期未清理", async () => {
    for (const entry of ALLOW_LIST) {
      const abs = path.join(SRC_DIR, entry.file);
      const exists = await fs
        .access(abs)
        .then(() => true)
        .catch(() => false);
      expect(exists, `ALLOW_LIST 条目 ${entry.file} 不存在——文件已删除请清理 ALLOW_LIST`).toBe(
        true,
      );
    }
  });
});
