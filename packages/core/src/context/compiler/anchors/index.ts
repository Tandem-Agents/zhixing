// 事实锚生成器公开 API + 内置 generator 集合

export type { AnchorGenerator } from "./types.js";
export { AnchorRegistry, fallbackAnchor } from "./registry.js";

export { readAnchor } from "./generators/read.js";
export { bashAnchor } from "./generators/bash.js";
export { grepAnchor } from "./generators/grep.js";
export { globAnchor } from "./generators/glob.js";
export { editAnchor } from "./generators/edit.js";
export { writeAnchor } from "./generators/write.js";
export { webFetchAnchor } from "./generators/web-fetch.js";

import { AnchorRegistry } from "./registry.js";
import { readAnchor } from "./generators/read.js";
import { bashAnchor } from "./generators/bash.js";
import { grepAnchor } from "./generators/grep.js";
import { globAnchor } from "./generators/glob.js";
import { editAnchor } from "./generators/edit.js";
import { writeAnchor } from "./generators/write.js";
import { webFetchAnchor } from "./generators/web-fetch.js";

/**
 * 创建预注册了内置工具 generator 的 AnchorRegistry。
 *
 * 内置覆盖：read / bash / grep / glob / edit / write / web_fetch。
 * 调用方可在返回的 registry 上继续 register 自定义工具的 generator。
 */
export function createDefaultAnchorRegistry(): AnchorRegistry {
  return new AnchorRegistry().registerAll([
    readAnchor,
    bashAnchor,
    grepAnchor,
    globAnchor,
    editAnchor,
    writeAnchor,
    webFetchAnchor,
  ]);
}
