import type { AuthorityError, GlobalStagedMutation } from "@zhixing/core/contracts";
import { describe, expect, it } from "vitest";
import {
  productizePublishAuthorityError,
  publishConflictProductCopy,
} from "../publish-result-product-language.js";

const ERROR_CODES = [
  "unauthorized",
  "capability-expired",
  "epoch-stale",
  "revision-conflict",
  "fence-rejected",
  "busy",
  "not-found",
  "invalid",
  "lease-exhausted",
  "missing-base",
  "typed-stale",
  "capability-gap",
  "unavailable-offline",
  "idempotency-conflict",
] as const satisfies readonly AuthorityError["code"][];

const MUTATION_KINDS = [
  "schedule-create",
  "schedule-update",
  "schedule-set-state",
  "schedule-delete",
  "skill-usage",
  "skill-create",
  "skill-update",
  "skill-admit",
  "workscene-create",
  "workscene-rename",
  "workscene-set-workdir",
  "workscene-delete",
  "delivery-enqueue",
] as const satisfies readonly GlobalStagedMutation["kind"][];

describe("publish result product language", () => {
  it("covers every stable error and mutation kind without exposing internal diagnostics", () => {
    for (const code of ERROR_CODES) {
      const publicError = productizePublishAuthorityError({
        code,
        message: "anchor owner executor internal topology",
        retryable: false,
      });
      expect(publicError.message).not.toMatch(/anchor|owner|executor|topology/iu);
      for (const kind of MUTATION_KINDS) {
        const copy = publishConflictProductCopy(kind, code);
        expect(copy.mutationLabel).not.toBe("");
        expect(copy.actions).toHaveLength(2);
        expect(publicError.message).toBe(
          `${copy.reason}。${copy.actions.join("，")}。`,
        );
        expect(JSON.stringify(copy)).not.toMatch(/anchor|owner|executor|topology/iu);
      }
    }
  });
});
