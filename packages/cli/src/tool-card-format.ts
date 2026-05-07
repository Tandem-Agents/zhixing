/**
 * 工具调用 scrollback 卡片格式化——`Action(target)` 主行 + `⎿ result` 续行。
 *
 * 关注点：纯文本格式化。颜色 / 缩进 / 写入路径由 caller（output-renderer）决定，
 * 让本模块可以脱离 chalk / ScreenController 单元测试。
 *
 * 工具名表达：内部短名（snake_case 或 lower）→ 终端展示 PascalCase。
 * target 提取按工具差异化（文件类取 path / 命令类取 command 等）。
 * result 摘要按工具差异化（read 取行数 / bash 取行数+用时 / 失败统一取 error 首行）。
 */

import type { ToolResult } from "@zhixing/core";

const TARGET_TRUNCATE = 60;
const ERROR_TRUNCATE = 80;

/**
 * 工具内部短名 → 终端展示名的显式映射。未注册工具走 `snake_case → PascalCase`
 * 通用规则（如 `web_fetch` → `WebFetch`），保证未来新增工具零配置自动获得合理展示名。
 */
const TOOL_DISPLAY_NAME: Readonly<Record<string, string>> = Object.freeze({
  read: "Read",
  write: "Write",
  edit: "Edit",
  bash: "Bash",
  grep: "Grep",
  glob: "Glob",
  memory: "Memory",
  web_fetch: "WebFetch",
  schedule: "Schedule",
  Task: "Task",
});

/** 工具内部名 → 终端展示 PascalCase 名 */
export function displayToolName(name: string): string {
  return TOOL_DISPLAY_NAME[name] ?? snakeToPascal(name);
}

/**
 * 工具卡片 header —— `Action(target)` 或 `Action`（target 为空时省略括号）。
 *
 *   Read(src/foo.ts)
 *   Bash(npm run test)
 *   Grep(auth)
 *   Schedule（target 为空）
 */
export function formatToolHeader(
  name: string,
  input: Record<string, unknown>,
): string {
  const displayName = displayToolName(name);
  const target = extractTarget(name, input);
  return target.length > 0 ? `${displayName}(${target})` : displayName;
}

/**
 * 工具卡片续行 result 摘要——`⎿ <summary>` 的 summary 部分（不含 `⎿ ` 前缀）。
 *
 * 设计：摘要要让用户一眼判断"这次工具调用做了什么"，但不展开详细内容
 * （详细内容在 LLM 后续文字回复中由模型自己叙述）。
 *
 *   read       → `245 lines`
 *   write      → `ok`
 *   edit       → `applied`
 *   bash       → `5 lines · 123ms`（命令类带用时，反映"执行成本"）
 *   grep       → `12 lines`（行数即匹配数估算）
 *   glob       → `8 files`
 *   其他       → `123ms`（默认仅用时）
 *   失败       → error 首行截断
 */
export function formatToolResult(
  name: string,
  result: ToolResult,
  durationMs: number,
): string {
  if (result.isError) {
    const raw = (result.content || "(unknown error)").trim();
    const firstLine = raw.split("\n")[0] ?? "";
    return truncate(firstLine, ERROR_TRUNCATE);
  }

  const lines = countLines(result.content);
  switch (name) {
    case "read":
      return `${lines} ${pluralize(lines, "line", "lines")}`;
    case "write":
      return "ok";
    case "edit":
      return "applied";
    case "bash":
      return `${lines} ${pluralize(lines, "line", "lines")} · ${formatToolDuration(durationMs)}`;
    case "grep":
      return `${lines} ${pluralize(lines, "line", "lines")}`;
    case "glob":
      return `${lines} ${pluralize(lines, "file", "files")}`;
    default:
      return formatToolDuration(durationMs);
  }
}

/**
 * 工具用时格式——保留 ms 精度（工具调用通常 < 1s，整秒粒度信息量太低）。
 *
 *   < 1000ms → `123ms`
 *   ≥ 1000ms → `1.4s`（一位小数即可，工具用时上界通常分钟级以下）
 */
export function formatToolDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ─── 内部 helpers ───

function extractTarget(
  name: string,
  input: Record<string, unknown>,
): string {
  switch (name) {
    case "read":
    case "write":
    case "edit": {
      const path =
        stringField(input, "path") ?? stringField(input, "file_path");
      return path ?? "";
    }
    case "bash":
      return truncate(stringField(input, "command") ?? "", TARGET_TRUNCATE);
    case "grep":
      return truncate(stringField(input, "pattern") ?? "", TARGET_TRUNCATE);
    case "glob":
      return truncate(stringField(input, "pattern") ?? "", TARGET_TRUNCATE);
    case "memory":
      return (
        stringField(input, "operation") ??
        stringField(input, "action") ??
        ""
      );
    case "web_fetch":
      return truncate(stringField(input, "url") ?? "", TARGET_TRUNCATE);
    case "schedule":
      return stringField(input, "name") ?? "";
    case "Task":
      return truncate(
        stringField(input, "description") ?? "",
        TARGET_TRUNCATE,
      );
    default:
      return "";
  }
}

function stringField(
  obj: Record<string, unknown>,
  key: string,
): string | null {
  const v = obj[key];
  return typeof v === "string" ? v : null;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function snakeToPascal(name: string): string {
  return name
    .split("_")
    .filter((seg) => seg.length > 0)
    .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
    .join("");
}

function countLines(content: string): number {
  if (!content) return 0;
  const trimmed = content.endsWith("\n") ? content.slice(0, -1) : content;
  return trimmed.length === 0 ? 0 : trimmed.split("\n").length;
}

function pluralize(n: number, singular: string, plural: string): string {
  return n === 1 ? singular : plural;
}
