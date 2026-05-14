/**
 * 工具调用 scrollback 卡片格式化——双形态共用：
 *
 *   1) 失败破窗（保留 ◆ 形态）：`Action(target)` header + `⎿ error 首行` 续行
 *      用于 output-renderer 的失败破窗路径——红色独立成段、最大化醒目性。
 *
 *   2) 批次摘要（次级 ⟡ 形态）：`⟡ 已使用 N 个工具（分类）· duration` 头部 + ⋮ 折叠 +
 *      近邻 3 条详情行。用于 ToolBatchCoordinator 多工具批次的折叠展示。
 *
 * 关注点：纯文本格式化。颜色 / 缩进 / 写入路径由 caller（output-renderer / coordinator）
 * 决定，让本模块可以脱离 chalk / ScreenController 单元测试。
 *
 * 工具名表达：内部短名（snake_case 或 lower）→ 终端展示 PascalCase。
 * target 提取按工具差异化（文件类取 path / 命令类取 command 等）。
 * result 摘要按工具差异化（read 取行数 / bash 取行数+用时 / 失败统一取 error 首行）。
 */

import type { ToolResult } from "@zhixing/core";

const TARGET_TRUNCATE = 60;
const ERROR_TRUNCATE = 80;
/** 批次详情行 target 紧凑上限——比 header 路径短，因详情行起首已缩进 + 整体 dim */
const BATCH_DETAIL_TARGET_TRUNCATE = 40;

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

// ─── 工具 → 用户视角动作（batch 头部摘要用） ───

/**
 * 工具调用的「用户视角动作」描述——把工具名（read/glob/bash 等）翻译成用户能
 * 理解的动作语义（阅读/查找/执行）。
 *
 * **产品定位**：batch 头部摘要面向用户「扫一眼回顾 AI 做了什么」——「工具」是
 * LLM 工程术语，用户认知模型是动作。把 `已使用 8 个工具（Read×8）` 翻译成
 * `阅读了 8 个文件` 消除技术泄漏 + 同义重复。
 *
 * **双形态契约**：
 *   - `full`:    单一工具类型场景——完整短语含「了」完成时态 + 量词
 *                （`阅读了 8 个文件 · 48ms`）
 *   - `compact`: 多工具类型混合场景——紧凑动词 + 数字
 *                （`阅读 8 · 查找 1 · 执行 1 · 75ms`），节省横向宽度
 *
 * **函数形式（非模板字符串）**：保留为未来扩展点——英文复数变化（`1 file` vs
 * `2 files`）、量词按对象切换、多语言注入 locale 都可在函数内实现，调用方接口
 * 不变。
 */
interface ToolVerbLabel {
  readonly full: (count: number) => string;
  readonly compact: (count: number) => string;
}

/**
 * 工具名 → 动作短语 映射表。
 *
 * **仅覆盖 default 策略工具**（探索类——会进入 batch summary 的工具）：
 *   - read / glob / grep / bash / web_fetch / task_list / memory
 *
 * 副作用工具（write/edit/schedule）走 ✎ 独立行不入 batch；sub-agent-status
 * （Task）由 status-bar 接管——这两类不出现在 batch.events，不需要 verb 映射。
 *
 * 未注册工具走 fallback（`调用 ${DisplayName} ${N} 次` / `${DisplayName} ${N}`）——
 * 零配置不崩，加映射表后自动升级到友好动词。
 *
 * **双层不变量**（与 TOOL_DISPLAY_NAME 同模式）：
 *   - 编译期 Readonly 禁止赋值/删除
 *   - 运行期 Object.freeze 拦 strict 模式 mutate
 */
const TOOL_VERB_LABELS: Readonly<Record<string, ToolVerbLabel>> = Object.freeze({
  read: {
    full: (n: number) => `阅读了 ${n} 个文件`,
    compact: (n: number) => `阅读 ${n}`,
  },
  glob: {
    full: (n: number) => `查找了 ${n} 次`,
    compact: (n: number) => `查找 ${n}`,
  },
  grep: {
    full: (n: number) => `搜索了 ${n} 次`,
    compact: (n: number) => `搜索 ${n}`,
  },
  bash: {
    full: (n: number) => `执行了 ${n} 条命令`,
    compact: (n: number) => `执行 ${n}`,
  },
  web_fetch: {
    full: (n: number) => `获取了 ${n} 个链接`,
    compact: (n: number) => `获取 ${n}`,
  },
  task_list: {
    full: (n: number) => `更新了 ${n} 次任务`,
    compact: (n: number) => `任务 ${n}`,
  },
  memory: {
    full: (n: number) => `使用记忆 ${n} 次`,
    compact: (n: number) => `记忆 ${n}`,
  },
} as const);

/**
 * 获取工具的完整动作短语（单一类型 batch 头部用）——「阅读了 8 个文件」。
 *
 * 未注册工具 fallback：`调用 ${DisplayName} ${count} 次`，displayToolName 已含
 * snake_case → PascalCase 兜底，未来加新工具自动获得 readable 名。
 */
function verbFull(name: string, count: number): string {
  const label = TOOL_VERB_LABELS[name];
  if (label) return label.full(count);
  return `调用 ${displayToolName(name)} ${count} 次`;
}

/**
 * 获取工具的紧凑动作短语（多类型 batch 头部用）——「阅读 8」。
 *
 * 未注册工具 fallback：`${DisplayName} ${count}`，与完整短语共享 displayToolName
 * 兜底体系。
 */
function verbCompact(name: string, count: number): string {
  const label = TOOL_VERB_LABELS[name];
  if (label) return label.compact(count);
  return `${displayToolName(name)} ${count}`;
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
    // 用户拒绝场景识别 —— secure-executor 生成的 LLM-facing prompt（含"请根据该
    // 反馈调整方案"指令）原样回流给 LLM 让模型理解为何被拒，但 cli 显示给用户
    // 时换为简洁 user-facing 文案。识别 secure-executor 的稳定 prefix；模板若
    // 未来变化，fallback 路径仍能 graceful 降级显示「已拒绝」不暴露 LLM 指令。
    //
    // 与 secure-executor.ts:257-258 文案模板隐式耦合 —— 该处文案修改需同步更新
    // 本函数的 prefix 匹配 / reason 提取正则。
    if (raw.startsWith("用户拒绝了这次工具调用")) {
      return formatUserDeniedResult(raw);
    }
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
 * 用户拒绝场景的 user-facing 文案 —— 从 LLM-facing prompt 提取 reason。
 *
 * **隐式契约**（与 `@zhixing/orchestrator` 的 secure-executor 耦合）：
 *   - 输入有 reason：`用户拒绝了这次工具调用。用户的反馈:<reason>。请根据该反馈调整方案。`
 *   - 输入无 reason：`用户拒绝了这次工具调用。`
 *   - 来源：`packages/orchestrator/src/security/secure-executor.ts:257-258`
 *
 * 输出：
 *   - 有 reason: `已拒绝 · <reason>`
 *   - 无 reason: `已拒绝`
 *   - 模板未来变更不匹配正则：fallback `已拒绝`（不暴露原 LLM prompt 给用户）
 */
function formatUserDeniedResult(content: string): string {
  const reasonMatch = content.match(
    /用户的反馈[:：](.+?)。请根据该反馈调整方案。/,
  );
  if (reasonMatch) {
    const reason = truncate(reasonMatch[1]!.trim(), ERROR_TRUNCATE - 8);
    return `已拒绝 · ${reason}`;
  }
  return "已拒绝";
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

// ─── 批次摘要（次级 ⟡ 形态） ───

/**
 * 单个 batch event 的快照——coordinator 持有 events 队列，每次重渲 segment 时
 * 喂给 formatBatchSummary / formatBatchDetailLine。
 *
 * 与 ToolEnd AgentYield 同形（少了 id）——id 在 coordinator 入口已用过即扔（pendingToolInputs
 * 配对），batch 内不再追踪个体身份。
 */
export interface BatchEventSnapshot {
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly result: ToolResult;
  readonly duration: number;
}

/**
 * 批次头部摘要文案——`⟡` 锚 + 内容由 caller 拼装；本函数只产文本内容部分。
 *
 * **单/多类型分流**（用户视角动作语义）：
 *   单一类型：完整短语含完成时态 ——
 *     `阅读了 8 个文件 · 48ms`
 *     `查找了 1 次 · 27ms`
 *     `执行了 2 条命令 · 1.2s`
 *   多类型：紧凑动词 + 数字，按首次出现顺序拼接 ——
 *     `阅读 8 · 查找 1 · 47ms`
 *     `阅读 8 · 查找 1 · 执行 1 · 75ms`
 *   空：`无动作 · 0ms`（caller 应避免空 batch，但函数本身 robust）
 *
 * **去技术泄漏的产品决策**：原 `已使用 N 个工具（Read×K）` 暴露工具名 + 同义重复
 * （8 个工具 + Read×8 是冗余表达），新方案以"用户能理解的动作"（阅读 / 查找 /
 * 执行）替代——用户认知模型是动作而非工具，详见 TOOL_VERB_LABELS docstring。
 *
 * 用时 = events.duration 累加（不是 wallclock）——LLM 工具调用经常并行，wallclock
 * 含等待间隙意义弱；累计纯执行用时反映"AI 真实工作时长"。
 */
export function formatBatchSummary(events: readonly BatchEventSnapshot[]): string {
  const totalDuration = events.reduce((acc, e) => acc + e.duration, 0);
  const durationText = formatToolDuration(totalDuration);

  if (events.length === 0) {
    return `无动作 · ${durationText}`;
  }

  // 按 name 分组计数，保留首次出现顺序（Map 自带插入序）—— 让用户看到的
  // 分类与他/她内心的"AI 先做了什么、后做了什么"顺序一致
  const counts = new Map<string, number>();
  for (const e of events) {
    counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
  }

  if (counts.size === 1) {
    // 单一类型——完整短语 + 完成时态，让用户清楚知道"AI 做的是什么动作"
    const entry = counts.entries().next().value;
    // 类型守卫——counts.size===1 时 entries().next() 必返回首项，但 TS 不能在
    // 编译期推导。fallback 永不到达（运行期 robust）
    if (entry === undefined) return `无动作 · ${durationText}`;
    const [name, count] = entry;
    return `${verbFull(name, count)} · ${durationText}`;
  }

  // 多类型——紧凑动词节省横向宽度，避免长 batch 摘要溢出终端宽度
  const parts: string[] = [];
  for (const [name, count] of counts) {
    parts.push(verbCompact(name, count));
  }
  return `${parts.join(" · ")} · ${durationText}`;
}

/**
 * 批次单条详情行——`<DisplayName> <target> · <result>`（target 为空时省略空格 + target）。
 *
 *   Read package.json · 10 lines
 *   Bash dir /b D:\Workspace · 8 lines · 47ms
 *   Schedule · 123ms                                  ← target 为空
 *
 * 详细行的 target 比 header 路径更紧凑（路径取 basename / 命令限 40 字）——详情行
 * 起首已缩进 7 列、整体 dim，与头部摘要在视觉上"附属下挂"，全路径在此处无信息收益、
 * 反而增加视觉噪音。
 */
export function formatBatchDetailLine(event: BatchEventSnapshot): string {
  const name = displayToolName(event.name);
  const target = extractBatchDetailTarget(event.name, event.input);
  const result = formatToolResult(event.name, event.result, event.duration);
  return target.length > 0 ? `${name} ${target} · ${result}` : `${name} · ${result}`;
}

/**
 * 批次详情行的 target 提取——复用 extractTarget 拿完整值，然后做"紧凑化"：
 *   - 文件类工具（read / write / edit）：取 basename，去掉冗长的绝对路径前缀
 *   - 其他类工具（bash / grep / glob / web_fetch / Task）：限制到 BATCH_DETAIL_TARGET_TRUNCATE
 *
 * 已知 trade-off：basename 冲突时（多个目录下同名文件）用户看不出区别——但批次详情行
 * 是"扫一眼回顾"用途，需要精确路径时用户应展开 turn 详情（未来 Ctrl-T 折叠展开特性）。
 */
function extractBatchDetailTarget(
  name: string,
  input: Record<string, unknown>,
): string {
  const full = extractTarget(name, input);
  if (full.length === 0) return "";
  if (name === "read" || name === "write" || name === "edit") {
    return basename(full);
  }
  return truncate(full, BATCH_DETAIL_TARGET_TRUNCATE);
}

/** 跨平台 basename——分隔符 `/` 与 `\\` 都识别，匹配 Windows / POSIX 路径 */
function basename(path: string): string {
  // 取最后一个分隔符之后的部分；都无分隔符时整段返回
  const lastSep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (lastSep < 0) return path;
  return path.slice(lastSep + 1);
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
