/**
 * 档位推荐 —— 派生自单一策展目录源 `BUILTIN_CURATED_CATALOG.recommendations`（设计 §1.4、§4.1）。
 *
 * 推荐与事实目录解耦维护：保留每条推荐的理由、证据来源、核验日期与替换理由；
 * 仅作展示与默认提示，推荐更新绝不改写用户已保存的用途默认或会话选择。
 */

import { BUILTIN_CURATED_CATALOG } from "./catalog/builtin-catalog.js";
import type { BuiltinPresetId } from "./presets.js";
import type { RoleId } from "./role-spec.js";

export interface RoleRecommendation {
  readonly provider: BuiltinPresetId;
  readonly model: string;
  readonly rationale?: string;
  readonly evidenceSource?: string;
  readonly verifiedAt?: string;
  readonly replacementReason?: string;
}

function buildBuiltinRecommendations(): Partial<Record<RoleId, RoleRecommendation>> {
  const result: Partial<Record<RoleId, RoleRecommendation>> = {};
  for (const rec of BUILTIN_CURATED_CATALOG.recommendations) {
    if (!result[rec.role]) {
      result[rec.role] = {
        provider: rec.presetId as BuiltinPresetId,
        model: rec.modelId,
        rationale: rec.rationale,
        evidenceSource: rec.evidenceSource,
        verifiedAt: rec.verifiedAt,
        ...(rec.replacementReason ? { replacementReason: rec.replacementReason } : {}),
      };
    }
  }
  return Object.freeze(result);
}

/** 三用途（main / light / power）策展推荐表，单一源派生。 */
export const ROLE_RECOMMENDATIONS: Partial<Record<RoleId, RoleRecommendation>> =
  buildBuiltinRecommendations();
