import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createEventBus,
  skillNameToId,
  type AgentEventMap,
  type SkillCatalogEntry,
} from "@zhixing/core";
import { FileArtifactStore } from "@zhixing/core/authority";
import { protocolDigest } from "@zhixing/core/protocol";
import type {
  AssignmentGlobalQueryPort,
  AssignmentMutationOverlayRecord,
  AssignmentMutationPort,
  AssignmentMutationRequest,
  GlobalQuery,
  GlobalReadResult,
} from "@zhixing/core/contracts";
import {
  createAssignmentSkillPorts,
  renderAssignmentSkillIndex,
} from "./assignment-skill-port.js";
import { runContextStorage } from "./run-context.js";

const ISSUED_AT = "2026-08-04T00:00:00.000Z";

describe("assignment skill ports", () => {
  it("stages save, reads its own artifact-backed write, and records stable usage", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "assignment-skills-"));
    try {
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
      const overlay: AssignmentMutationOverlayRecord[] = [];
      const mutations = mutationPort(overlay);
      const query = skillQuery([]);
      const ports = createAssignmentSkillPorts(artifacts);

      await runContextStorage.run(
        {
          bus: createEventBus<AgentEventMap>({ lineage: "main" }),
          lineage: "main",
          globalQuery: query,
          assignmentMutations: mutations,
          assignmentIssuedAt: ISSUED_AT,
        },
        async () => {
          const saved = await ports.saver(
            {
              name: "My Skill",
              description: "Useful instructions",
              body: "Do the useful thing.",
              mode: "main",
            },
            "tool-save",
          );
          expect(saved.outcome).toBe("created");
          const loaded = await ports.loader.loadText(saved.id, "tool-load");
          expect(loaded).toMatchObject({
            id: skillNameToId("My Skill"),
            body: "Do the useful thing.",
          });
        },
      );

      expect(overlay).toHaveLength(2);
      expect(overlay[0]).toMatchObject({
        domain: "global",
        requestId: "tool-save:save",
        mutation: { kind: "skill-create" },
      });
      expect(overlay[1]).toMatchObject({
        domain: "global",
        requestId: "tool-load:usage",
        mutation: {
          kind: "skill-usage",
          record: { occurredAt: ISSUED_AT, hitDelta: 1 },
        },
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("renders path-free user catalog with own-name shadowing and disabled exclusion", async () => {
    const own = entry({ description: "Owned description" });
    const disabled = entry({ id: "disabled", name: "Disabled", disabled: true });
    const result = await renderAssignmentSkillIndex(
      "main",
      skillQuery([own, disabled], 9),
    );
    expect(result.catalogRevision).toBe(9);
    expect(result.content).toContain("Owned description");
    expect(result.content).not.toContain("加载本方法来起草");
    expect(result.content).not.toContain("Disabled");
    expect(JSON.stringify([own, disabled])).not.toMatch(/[A-Z]:\\|\/tmp\//);
  });

  it("fails closed outside a durable assignment instead of writing a local store", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "assignment-skills-"));
    try {
      const ports = createAssignmentSkillPorts(
        new FileArtifactStore(path.join(root, "artifacts")),
      );
      await expect(
        ports.saver(
          {
            name: "No Assignment",
            description: "Must fail",
            body: "body",
            mode: "main",
          },
          "tool-save",
        ),
      ).rejects.toThrow("active durable assignment");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

function mutationPort(
  overlay: AssignmentMutationOverlayRecord[],
): AssignmentMutationPort {
  return {
    assignmentId: "assignment-1",
    execution: "conversation",
    async stage(input: AssignmentMutationRequest) {
      const recordSeq = overlay.length + 1;
      const mutationDigest = protocolDigest("AssignmentSkillTestMutation", 1, input);
      overlay.push({
        recordSeq,
        domain: input.domain,
        mutation: input.mutation,
        requestId: input.operationId,
        mutationDigest,
      });
      return {
        kind: "assignment-mutation-staged",
        requestId: input.operationId,
        recordSeq,
        mutationDigest,
      };
    },
    async readOverlay() {
      return overlay;
    },
  };
}

function skillQuery(
  entries: readonly SkillCatalogEntry[],
  catalogRevision = 0,
): AssignmentGlobalQueryPort {
  return {
    async read(query: GlobalQuery): Promise<GlobalReadResult> {
      if (query.kind === "skill-catalog") {
        return { kind: "skill-catalog", catalogRevision, entries: [...entries] };
      }
      if (query.kind === "skill-get") {
        return {
          kind: "skill-get",
          catalogRevision,
          entry: entries.find((entry) => entry.id === query.skillId) ?? null,
        };
      }
      throw new Error(`Unexpected query: ${query.kind}`);
    },
  };
}

function entry(overrides: Partial<SkillCatalogEntry> = {}): SkillCatalogEntry {
  const value: SkillCatalogEntry = {
    id: skillNameToId("提炼技能"),
    name: "提炼技能",
    description: "Owned description",
    source: "own",
    mode: "main",
    pinned: false,
    disabled: false,
    createdAt: ISSUED_AT,
    usage: null,
    contentRef: { digest: "a".repeat(64), bytes: 1 },
    revision: 1,
    digest: "b".repeat(64),
    ...overrides,
  };
  return value;
}
