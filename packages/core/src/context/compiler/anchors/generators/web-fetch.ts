import type { AnchorGenerator } from "../types.js";

/**
 * web_fetch 工具事实锚 —— 锚化网页抓取调用历史。
 *
 * 成功：`[web_fetch <url>, <N> chars]`
 * 失败：`[web_fetch <url>, error]`
 *
 * url 过长时截断到首 100 字符，避免 anchor 文本被超长 url 污染。
 */
const URL_PREVIEW_MAX = 100;

export const webFetchAnchor: AnchorGenerator = {
  toolName: "web_fetch",
  generate(toolUse, toolResult) {
    const url = toolUse.input.url;
    if (typeof url !== "string" || url.length === 0) return null;
    const previewUrl =
      url.length <= URL_PREVIEW_MAX ? url : `${url.slice(0, URL_PREVIEW_MAX)}…`;
    if (toolResult.isError) return `[web_fetch ${previewUrl}, error]`;
    return `[web_fetch ${previewUrl}, ${toolResult.content.length} chars]`;
  },
};
