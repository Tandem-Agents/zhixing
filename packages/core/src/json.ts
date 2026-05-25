/**
 * 从可能带代码围栏 / 前后说明文字的 LLM 输出里抠出第一个 JSON 对象（首 `{` 到末 `}`）。
 *
 * LLM 常在 JSON 外包裹解释或 ```json 围栏，这里只取对象主体、不做解析——容错宽松，
 * 交由调用方 `JSON.parse`。取不到（无成对花括号）返回 undefined。
 */
export function extractJsonObject(raw: string): string | undefined {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return undefined;
  return raw.slice(start, end + 1);
}
