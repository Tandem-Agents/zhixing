/**
 * 技能库路径解析。
 *
 * 全部从一个「技能库根」派生。运行期默认根 = `<zhixing-home>/skills`
 * (getSkillsRoot),但 Store 接收**注入的根**(测试传临时目录),所以除
 * getSkillsRoot() 外的 helper 都以 root 为参数 —— 物理路径只在此一处拼接
 * (与 workscene/paths.ts 同款分层约定)。
 *
 * 布局:
 *   <root>/index.json            状态旁路表(mode / pinned / disabled / createdAt)
 *   <root>/own/<dir>/SKILL.md     本地区:本地产生 / 编辑
 *   <root>/linked/<dir>/SKILL.md  接入区:外部源接入,原样保存
 *   <root>/archived/<dir>/        归档区:删 = 移到此,可逆
 *   <root>/usage/<id>.json        度量旁路:高频写
 *   <root>/.staging/<tmp>/        接入候选暂存
 *
 * 注:`<dir>` 是物理目录名(Store 产生时 = id,用户手写时随意);技能定位靠
 * 扫描时建立的 `id → 实际目录` 映射,不靠目录名等于 id。`usage/<id>.json` 则
 * 直接以 id 命名(id 已是文件名安全)。
 */

import path from "node:path";
import { getZhixingHome } from "../paths.js";
import type { SkillSource } from "./types.js";

/** 技能正文文件名 —— 每个技能目录下唯一的正文文件。 */
export const SKILL_FILE = "SKILL.md";

/** 运行期默认技能库根 `<home>/skills`。 */
export function getSkillsRoot(): string {
  return path.join(getZhixingHome(), "skills");
}

/** 状态旁路表 `<root>/index.json`。 */
export function skillsIndexPath(root: string): string {
  return path.join(root, "index.json");
}

/** own / linked 区根 —— 扫描发现与写入按 source 取区(区名即目录名)。 */
export function sourceRoot(root: string, source: SkillSource): string {
  return path.join(root, source);
}

/** 归档区根 `<root>/archived`(archived 不是来源,故独立于 sourceRoot)。 */
export function archivedRoot(root: string): string {
  return path.join(root, "archived");
}

/** 度量旁路目录 `<root>/usage`。 */
export function usageDir(root: string): string {
  return path.join(root, "usage");
}

/** 单个技能度量文件 `<root>/usage/<id>.json`。 */
export function usagePath(root: string, id: string): string {
  return path.join(usageDir(root), `${id}.json`);
}

/** 接入候选暂存根 `<root>/.staging`。 */
export function stagingRoot(root: string): string {
  return path.join(root, ".staging");
}
