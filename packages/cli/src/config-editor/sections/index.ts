/**
 * Section 注册与查找。
 *
 * caller 传 sectionIds，runner 用此映射拿到 Section 实例。新增 section 在此扩展。
 */

import type { Section, SectionId } from "../types.js";
import { modelSection } from "./model.js";
import { messagingSection } from "./messaging.js";
import { mcpSection } from "./mcp.js";

const REGISTRY: Record<SectionId, Section> = {
  model: modelSection,
  messaging: messagingSection,
  mcp: mcpSection,
};

/**
 * 全部已注册 section id——单一事实源派生自 REGISTRY，加新 section 时只在 REGISTRY 改一处。
 */
export const ALL_SECTION_IDS: readonly SectionId[] = Object.keys(
  REGISTRY,
) as readonly SectionId[];

/**
 * `/config`（基础配置）默认展示的 sections。
 *
 * mcp 不在此列：它有专属 `/mcp` 入口（带连接状态 + 接入引导，需注入 hub / probe / LLM），
 * 在 `/config` 里只能半工作（无运行态、无引导）。故基础配置只放 model + messaging。
 */
export const BASE_CONFIG_SECTION_IDS: readonly SectionId[] = ["model", "messaging"];

export function getSection(id: SectionId): Section {
  return REGISTRY[id];
}

export function getSections(ids: readonly SectionId[]): Section[] {
  return ids.map((id) => REGISTRY[id]);
}
