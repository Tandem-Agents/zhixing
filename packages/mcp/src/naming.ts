/**
 * MCP 工具命名 —— `mcp__<server>__<tool>` 三段式，`__` 为段分隔。
 *
 * 命名的全部规则都内聚在此模块（消毒、长度预算、去重、反解析），映射层只委托、不重复。
 *
 * 三段唯一可解的前提：server / tool 名内部不得再出现 `__`。
 *   - server id：配置校验阶段从源头约束（见 isValidServerId）。
 *   - tool 名：server 动态提供、不可控，映射时消毒（连续下划线折叠 + 非法字符替换）。
 * 这样权限通配 `mcp__<server>__*` 的反解析（parseToolName）按 `__` split 必得三段。
 */

const PREFIX = "mcp";
const SEP = "__";

/**
 * 知行工具名总长上限 —— 对齐 OpenAI / Anthropic function name 的 64 字符上限，取各
 * provider 的安全交集。知行 provider 层直接透传工具名给各家 API、不做截断（见
 * adapters/openai-compatible 与 anthropic-messages 的 convertTools），故 MCP 动态
 * 工具名必须在映射阶段自我约束，否则超长名会被服务端拒绝。
 */
const MAX_TOOL_NAME_LENGTH = 64;

/**
 * server id 长度上限 —— 为 tool 段在 64 总长内预留充足预算（含去重后缀）。
 * server id 由配置 / 预设给定（可控），从源头约束合理。
 */
const MAX_SERVER_ID_LENGTH = 40;

/**
 * server id 合法性：首尾为字母 / 数字，中间可含 `-` / `_`，整体不含 `__` 且不超长。
 * 从源头杜绝段分隔歧义与工具名超长。
 */
const SERVER_ID_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9_-]*[a-zA-Z0-9])?$/;

export function isValidServerId(id: string): boolean {
  return (
    id.length <= MAX_SERVER_ID_LENGTH &&
    !id.includes(SEP) &&
    SERVER_ID_RE.test(id)
  );
}

/**
 * 消毒 server 动态提供的 tool 名，保证内部无 `__`：
 *   - 非 `[a-zA-Z0-9_]` 字符替为 `_`
 *   - 连续下划线折为单个 `_`（消灭 `__`）
 *   - 去首尾下划线
 * 空结果兜底为 `"tool"`，保证总能产出合法段。
 */
export function sanitizeToolName(raw: string): string {
  const cleaned = raw
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned.length > 0 ? cleaned : "tool";
}

/** 拼出完整的知行工具名。调用方需先 sanitizeToolName 处理 tool 段。 */
export function makeToolName(serverId: string, sanitizedTool: string): string {
  return `${PREFIX}${SEP}${serverId}${SEP}${sanitizedTool}`;
}

/**
 * 为某 server 的一个 MCP 工具生成最终的知行工具名，一站式保证四件事：
 * 消毒 → 在 64 总长预算内截断 tool 段 → 同 server 去重（`-2` / `-3`，后缀也计入
 * 预算）→ 仍可被 parseToolName 反解析。
 *
 * `used` 累积该 server 已产出的全名 —— 调用方对同一 server 的所有工具复用同一个
 * Set，本函数会把新名加入其中。
 */
export function makeUniqueToolName(
  serverId: string,
  rawToolName: string,
  used: Set<string>,
): string {
  const fixedLength = PREFIX.length + SEP.length * 2 + serverId.length;
  const segmentBudget = Math.max(1, MAX_TOOL_NAME_LENGTH - fixedLength);
  const sanitized = sanitizeToolName(rawToolName);

  let candidate = makeToolName(serverId, clampLength(sanitized, segmentBudget));
  for (let n = 2; used.has(candidate); n++) {
    const suffix = `-${n}`;
    const base = clampLength(sanitized, Math.max(1, segmentBudget - suffix.length));
    candidate = makeToolName(serverId, `${base}${suffix}`);
  }

  used.add(candidate);
  return candidate;
}

function clampLength(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

/**
 * 反解析 `mcp__<server>__<tool>` → `{ serverId, tool }`。
 * 仅当恰为三段（前缀 + server + tool）且前缀正确时成功，其余返回 null。
 * 因 server / tool 段内保证无 `__`，按 `__` split 必得三段。
 */
export function parseToolName(
  name: string,
): { serverId: string; tool: string } | null {
  const parts = name.split(SEP);
  if (parts.length !== 3) return null;
  const [prefix, serverId, tool] = parts;
  if (prefix !== PREFIX || !serverId || !tool) return null;
  return { serverId, tool };
}
