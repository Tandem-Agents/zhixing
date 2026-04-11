/**
 * YAML Frontmatter 解析器
 *
 * 轻量实现，无需引入 gray-matter 等外部依赖。
 * 支持标准的 --- 分隔的 YAML frontmatter 格式。
 *
 * 局限性（有意为之）：
 * - 只支持扁平的 key: value 和简单数组 [a, b, c]
 * - 不支持嵌套对象（记忆文件的 frontmatter 不需要）
 * - 复杂场景由 memory 工具在写入时保证格式正确
 */

export interface ParsedFrontmatter<T = Record<string, unknown>> {
  /** 解析后的 frontmatter 对象 */
  data: T;
  /** frontmatter 之后的 Markdown 正文 */
  content: string;
  /** 文件完整原始内容 */
  raw: string;
}

/**
 * 解析含 YAML frontmatter 的 Markdown 文件内容。
 *
 * 格式要求：
 * ```
 * ---
 * key: value
 * tags: [a, b, c]
 * ---
 * Markdown content here
 * ```
 */
export function parseFrontmatter<T = Record<string, unknown>>(
  raw: string,
): ParsedFrontmatter<T> {
  const trimmed = raw.trimStart();

  if (!trimmed.startsWith("---")) {
    return { data: {} as T, content: raw.trim(), raw };
  }

  const endIndex = trimmed.indexOf("\n---", 3);
  if (endIndex === -1) {
    return { data: {} as T, content: raw.trim(), raw };
  }

  const yamlBlock = trimmed.slice(4, endIndex).trim();
  const content = trimmed.slice(endIndex + 4).trim();
  const data = parseSimpleYaml(yamlBlock) as T;

  return { data, content, raw };
}

/**
 * 将对象序列化为 YAML frontmatter + Markdown 格式。
 */
export function stringifyFrontmatter(
  data: Record<string, unknown>,
  content: string,
): string {
  const yamlLines: string[] = [];

  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    yamlLines.push(serializeYamlLine(key, value));
  }

  const frontmatter = yamlLines.length > 0
    ? `---\n${yamlLines.join("\n")}\n---`
    : "";

  return frontmatter
    ? `${frontmatter}\n\n${content}`
    : content;
}

// ─── 内部实现 ───

function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split("\n");

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith("#")) continue;

    const colonIdx = trimmedLine.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmedLine.slice(0, colonIdx).trim();
    const rawValue = trimmedLine.slice(colonIdx + 1).trim();

    result[key] = parseYamlValue(rawValue);
  }

  return result;
}

function parseYamlValue(raw: string): unknown {
  if (raw === "" || raw === "null" || raw === "~") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;

  // 数字
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);

  // 数组：[a, b, c]
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((item) => {
      const trimmedItem = item.trim();
      return unquote(trimmedItem);
    });
  }

  // 带引号的字符串
  return unquote(raw);
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function serializeYamlLine(key: string, value: unknown): string {
  if (Array.isArray(value)) {
    const items = value.map((v) =>
      typeof v === "string" && (v.includes(",") || v.includes('"'))
        ? `"${v}"`
        : String(v),
    );
    return `${key}: [${items.join(", ")}]`;
  }

  if (typeof value === "string") {
    // 含特殊字符时加引号
    if (value.includes(":") || value.includes("#") || value.includes('"')) {
      return `${key}: "${value.replace(/"/g, '\\"')}"`;
    }
    return `${key}: ${value}`;
  }

  return `${key}: ${String(value)}`;
}
