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

export function getSection(id: SectionId): Section {
  return REGISTRY[id];
}

export function getSections(ids: readonly SectionId[]): Section[] {
  return ids.map((id) => REGISTRY[id]);
}
