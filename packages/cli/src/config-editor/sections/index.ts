/**
 * Section 注册与查找。
 *
 * caller 传 sectionIds，runner 用此映射拿到 Section 实例。新增 section 在此扩展。
 */

import type { Section, SectionId } from "../types.js";
import { modelSection } from "./model.js";
import { messagingSection } from "./messaging.js";

const REGISTRY: Record<SectionId, Section> = {
  model: modelSection,
  messaging: messagingSection,
};

/**
 * 全部已注册 section id——单一事实源派生自 REGISTRY，加新 section 时只在 REGISTRY 改一处。
 *
 * 用于 caller 想"打开全部 sections"的场景（如 REPL `/config` 让用户改任何字段）；
 * bootstrap 等"按缺失字段决定 sections"的场景仍然显式传子集。
 */
export const ALL_SECTION_IDS: readonly SectionId[] = Object.keys(
  REGISTRY,
) as readonly SectionId[];

export function getSection(id: SectionId): Section {
  return REGISTRY[id];
}

export function getSections(ids: readonly SectionId[]): Section[] {
  return ids.map((id) => REGISTRY[id]);
}
