import {
  instantiateTrustedOrchestrationTemplateV1,
  type OrchestrationExecutableV1,
  type OrchestrationLoadResultV1,
  type OrchestrationNodeModelRoleV1,
  type OrchestrationSystemCapsV1,
  type OrchestrationTemplateArrayItemV1,
} from "@zhixing/core";
import {
  MAX_PERSPECTIVE_COUNT,
  normalizePerspectiveAllocation,
} from "./allocation.js";
import { PERSPECTIVES_DELIBERATION_TEMPLATE } from "./deliberation-template.js";
import type { PerspectiveAllocation } from "./types.js";

export const DEFAULT_PERSPECTIVES_CAPS: OrchestrationSystemCapsV1 = {
  maxNodes: 11,
  maxParallel: 5,
  maxRunMs: 900_000,
  maxNodeTimeoutMs: 300_000,
  maxNodeTurns: 4,
  maxNodeTokens: 10_000,
  maxContextSnapshotTokens: 12_000,
  maxInstructionChars: 4_000,
  maxInputChars: 12_000,
  maxOutputChars: 16_000,
  allowedNodeKinds: ["agent"],
  allowedTools: [],
};

export interface PerspectiveAssemblyInput {
  readonly allocation: PerspectiveAllocation;
  readonly caps?: OrchestrationSystemCapsV1;
}

export type PerspectiveAssemblyResult =
  | {
      readonly ok: true;
      readonly executable: OrchestrationExecutableV1;
      readonly allocation: PerspectiveAllocation;
    }
  | {
      readonly ok: false;
      readonly loadResult: Extract<OrchestrationLoadResultV1, { readonly ok: false }>;
      readonly allocation: PerspectiveAllocation;
    };

export function assemblePerspectiveExecutable(
  input: PerspectiveAssemblyInput,
): PerspectiveAssemblyResult {
  const caps = input.caps ?? DEFAULT_PERSPECTIVES_CAPS;
  const allocation = normalizePerspectiveAllocation(
    input.allocation,
    MAX_PERSPECTIVE_COUNT,
  );
  const loadResult = instantiateTrustedOrchestrationTemplateV1(
    PERSPECTIVES_DELIBERATION_TEMPLATE,
    {
      perspectives: allocation.perspectives.map(
        (perspective, index): OrchestrationTemplateArrayItemV1 => ({
          name: perspective.name,
          charge: perspective.charge,
          modelRole: perspectiveModelRole(index),
        }),
      ),
    },
    caps,
  );
  if (!loadResult.ok) return { ok: false, loadResult, allocation };
  return { ok: true, executable: loadResult.executable, allocation };
}

export function perspectiveModelRole(
  index: number,
): OrchestrationNodeModelRoleV1 {
  return index % 2 === 0 ? "main" : "power";
}
