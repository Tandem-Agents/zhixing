/**
 * WebFetch 工具的内置 PermissionRule —— preapproved 知名文档/参考站。
 *
 * 接入方式: cli/serve 入口在启用 web_fetch 工具时调
 *   `permissionStore.registerBuiltinRules("web_fetch", WEB_FETCH_DEFAULT_RULES)`
 * builtin scope 语义:
 *   - in-memory 注册,不写盘
 *   - 让位用户池(session/workspace/global): 用户加 `web_fetch deny *` 任何通配
 *     规则会击败这些 builtin allow,保证用户最终决定权(ADR-TPE-008)
 *
 * 选取标准: 公开技术文档/学习站点,被 LLM 引用频次最高,SSRF 风险低,
 * 内容稳定不易承载诱导内容。新增 host 应满足同样标准。
 */

import { PermissionStore, type PermissionRule } from "@zhixing/core";

const PREAPPROVED_HOSTS: readonly string[] = [
  "developer.mozilla.org",
  "react.dev",
  "docs.python.org",
  "github.com",
  "raw.githubusercontent.com",
  "stackoverflow.com",
  "en.wikipedia.org",
  "zh.wikipedia.org",
  "arxiv.org",
  "npmjs.com",
  "typescriptlang.org",
  "docs.anthropic.com",
];

/**
 * WebFetch 默认 builtin 规则集。
 * 每条规则匹配 `https://${host}/**`(含子路径任意层级)。
 * 注册时 PermissionStore.registerBuiltinRules 会深拷贝,后续 mutate 不影响 store。
 */
export const WEB_FETCH_DEFAULT_RULES: readonly PermissionRule[] = PREAPPROVED_HOSTS.map(
  (host) =>
    PermissionStore.createRule({
      pattern: { tool: "web_fetch", argument: `https://${host}/**` },
      decision: "allow",
      scope: "builtin",
    }),
);
