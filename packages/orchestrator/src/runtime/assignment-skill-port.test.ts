import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ADMISSION_TOKEN_TTL_MS,
  createEventBus,
  skillNameToId,
  type AgentEventMap,
  type SkillCatalogEntry,
} from "@zhixing/core";
import { FileArtifactStore } from "@zhixing/core/authority";
import {
  assignmentMutationRequestId,
  protocolDigest,
} from "@zhixing/core/protocol";
import { BUILTIN_TOOL_FACTORIES } from "@zhixing/tools-builtin";
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
  createAssignmentSkillProjectionApplication,
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
      const ports = createAssignmentSkillPorts(artifacts, admissionOptions());

      await runContextStorage.run(
        {
          bus: createEventBus<AgentEventMap>({ lineage: "main" }),
          lineage: "main",
          globalQuery: query,
          assignmentMutations: mutations,
          assignmentIssuedAt: ISSUED_AT,
        },
        async () => {
          const saved = await ports.saveApplication.save(
            {
              name: "My Skill",
              description: "Useful instructions",
              body: "Do the useful thing.",
              mode: "main",
            },
            "tool-save",
          );
          expect(saved.outcome).toBe("created");
          const loaded = await ports.loadApplication.load({
            id: saved.id,
            operationId: "tool-load",
          });
          expect(loaded).toMatchObject({
            id: skillNameToId("My Skill"),
            body: "Do the useful thing.",
          });
        },
      );

      expect(overlay).toHaveLength(2);
      expect(overlay[0]).toMatchObject({
        domain: "global",
        requestId: assignmentMutationRequestId({
          assignmentId: "assignment-1",
          domain: "global",
          operationId: "tool-save:save",
        }),
        mutation: { kind: "skill-create" },
      });
      expect(overlay[1]).toMatchObject({
        domain: "global",
        requestId: assignmentMutationRequestId({
          assignmentId: "assignment-1",
          domain: "global",
          operationId: "tool-load:usage",
        }),
        mutation: {
          kind: "skill-usage",
          record: { occurredAt: ISSUED_AT, hitDelta: 1 },
        },
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("adapts only the raw path-free catalog snapshot for the Skill-owned projection", async () => {
    const own = entry({ description: "Owned description" });
    const disabled = entry({ id: "disabled", name: "Disabled", disabled: true });
    const read = vi.fn(skillQuery([own, disabled], 9).read);
    const result = await createAssignmentSkillProjectionApplication({ read })
      .project("main");
    expect(result.catalogRevision).toBe(9);
    expect(result.content).toContain("Owned description");
    expect(result.content).not.toContain("加载本方法来起草");
    expect(result.content).not.toContain("Disabled");
    expect(JSON.stringify([own, disabled])).not.toMatch(/[A-Z]:\\|\/tmp\//);
    expect(read).toHaveBeenCalledWith({
      kind: "skill-catalog",
      includeDisabled: true,
    });
  });

  it("fails closed when the raw catalog query returns another result kind", async () => {
    const read = vi.fn(async (): Promise<GlobalReadResult> => ({
      kind: "skill-get",
      catalogRevision: 9,
      entry: null,
    }));

    await expect(
      createAssignmentSkillProjectionApplication({ read }).project("main"),
    ).rejects.toThrow("Skill catalog query returned another result type");
  });

  it("binds the real save_skill factory to the domain application and staged update adapter", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "assignment-skills-"));
    try {
      const overlay: AssignmentMutationOverlayRecord[] = [];
      const ports = createAssignmentSkillPorts(
        new FileArtifactStore(path.join(root, "artifacts")),
        admissionOptions(),
      );
      const tool = BUILTIN_TOOL_FACTORIES.save_skill!({
        skillCatalogSave: ports.saveApplication,
        skillMode: "work",
      });
      const linkedDisabled = entry({ source: "linked", disabled: true, revision: 4 });
      const result = await runContextStorage.run(
        {
          bus: createEventBus<AgentEventMap>({ lineage: "main" }),
          lineage: "main",
          globalQuery: skillQuery([linkedDisabled]),
          assignmentMutations: mutationPort(overlay),
          assignmentIssuedAt: ISSUED_AT,
        },
        () => tool.call(
          {
            name: linkedDisabled.name,
            description: "updated",
            body: "updated body",
          },
          { workingDirectory: root, toolCallId: "tool-production-save" },
        ),
      );

      expect(result).toMatchObject({ isError: false });
      expect(result.content).toContain("本轮成功完成后入库");
      expect(overlay).toHaveLength(1);
      expect(overlay[0]).toMatchObject({
        requestId: assignmentMutationRequestId({
          assignmentId: "assignment-1",
          domain: "global",
          operationId: "tool-production-save:save",
        }),
        mutation: {
          kind: "skill-update",
          skillId: linkedDisabled.id,
          expectedRevision: 4,
          mode: "work",
        },
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("binds the real admit_skill factory to the domain lifecycle and staged admit adapter", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "assignment-admit-"));
    const before = await admissionDirectories();
    try {
      const source = path.join(root, "source");
      await fs.mkdir(source);
      await fs.writeFile(
        path.join(source, "SKILL.md"),
        "---\nname: Imported Skill\ndescription: Imported safely\n---\nFollow the steps.",
      );
      const overlay: AssignmentMutationOverlayRecord[] = [];
      const ports = createAssignmentSkillPorts(
        new FileArtifactStore(path.join(root, "artifacts")),
        {
          admissionLlm: async () => JSON.stringify({
            decision: "safe",
            reason: "safe",
          }),
        },
      );
      const tool = BUILTIN_TOOL_FACTORIES.admit_skill!({
        skillCatalogAdmission: ports.admissionApplication,
        skillMode: "work",
      });
      const result = await runContextStorage.run(
        {
          bus: createEventBus<AgentEventMap>({ lineage: "main" }),
          lineage: "main",
          globalQuery: skillQuery([]),
          assignmentMutations: mutationPort(overlay),
          assignmentIssuedAt: ISSUED_AT,
        },
        () => tool.call(
          { path: path.join(source, "SKILL.md") },
          { workingDirectory: root, toolCallId: "tool-production-admit" },
        ),
      );

      expect(result).toMatchObject({ isError: false });
      expect(result.content).toContain("本轮成功完成后入库");
      expect(overlay).toHaveLength(1);
      expect(overlay[0]).toMatchObject({
        requestId: assignmentMutationRequestId({
          assignmentId: "assignment-1",
          domain: "global",
          operationId: "tool-production-admit:admit",
        }),
        mutation: {
          kind: "skill-admit",
          mode: "work",
          record: {
            name: "Imported Skill",
            description: "Imported safely",
          },
        },
      });
      expect(await admissionDirectories()).toEqual(before);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps confirmed candidates artifact-bound and rejects symbolic-link candidates", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "assignment-admit-"));
    const before = await admissionDirectories();
    try {
      const source = path.join(root, "source");
      await fs.mkdir(source);
      await fs.writeFile(
        path.join(source, "SKILL.md"),
        "---\nname: Review Skill\ndescription: Review safely\n---\nReview me.",
      );
      const ports = createAssignmentSkillPorts(
        new FileArtifactStore(path.join(root, "artifacts")),
        {
          admissionLlm: async () => JSON.stringify({
            decision: "needs-confirm",
            reason: "review",
          }),
          clock: () => 1_000,
          randomToken: () => "review-token",
        },
      );
      const first = await ports.admissionApplication.admit({
        source: { kind: "local-path", path: source },
        mode: "main",
      });
      expect(first).toMatchObject({
        kind: "needs-confirm",
        admissionToken: "review-token",
      });
      const pending = (await admissionDirectories())
        .filter((name) => !before.includes(name));
      expect(pending).toHaveLength(1);
      await fs.appendFile(
        path.join(os.tmpdir(), "zhixing-skill-admission", pending[0]!, "SKILL.md"),
        "\nchanged",
      );
      await expect(ports.admissionApplication.admit({
        admissionToken: "review-token",
        mode: "main",
        operationId: "confirm",
      })).resolves.toEqual({ kind: "candidate-changed" });
      expect(await admissionDirectories()).toEqual(before);

      const linkedSource = path.join(root, "linked-source");
      await fs.mkdir(linkedSource);
      await fs.writeFile(
        path.join(linkedSource, "SKILL.md"),
        "---\nname: Linked\ndescription: linked\n---\nbody",
      );
      await fs.symlink(
        source,
        path.join(linkedSource, "linked"),
        "junction",
      );
      await expect(ports.admissionApplication.admit({
        source: { kind: "local-path", path: linkedSource },
        mode: "main",
        operationId: "linked",
      })).rejects.toThrow(/must not contain symbolic links|EPERM/u);
      expect(await admissionDirectories()).toEqual(before);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("sweeps only expired admission candidates from the real OS-temp workspace", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "assignment-admit-sweep-"));
    const admissionRoot = path.join(os.tmpdir(), "zhixing-skill-admission");
    const unique = `${process.pid}-${path.basename(root)}`;
    const stale = path.join(admissionRoot, `candidate-${unique}-stale`);
    const fresh = path.join(admissionRoot, `candidate-${unique}-fresh`);
    const now = Date.now();
    try {
      await fs.mkdir(stale, { recursive: true });
      await fs.mkdir(fresh, { recursive: true });
      const expired = new Date(now - ADMISSION_TOKEN_TTL_MS - 1_000);
      await fs.utimes(stale, expired, expired);
      const ports = createAssignmentSkillPorts(
        new FileArtifactStore(path.join(root, "artifacts")),
        {
          admissionLlm: async () => JSON.stringify({ decision: "safe", reason: "safe" }),
          clock: () => now,
        },
      );

      await expect(ports.admissionApplication.admit({ mode: "main" }))
        .resolves.toEqual({ kind: "missing-input" });
      await expect(fs.stat(stale)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(fresh)).resolves.toBeDefined();
    } finally {
      await fs.rm(stale, { recursive: true, force: true });
      await fs.rm(fresh, { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed outside a durable assignment instead of writing a local store", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "assignment-skills-"));
    try {
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
      const artifactRead = vi.spyOn(artifacts, "get");
      const ports = createAssignmentSkillPorts(artifacts, admissionOptions());
      for (const id of [skillNameToId("提炼技能"), "user-or-unknown"]) {
        await expect(ports.loadApplication.load({
          id,
          operationId: "tool-load",
        })).rejects.toThrow("Skill access requires an active durable assignment");
      }
      expect(artifactRead).not.toHaveBeenCalled();
      await expect(
        ports.saveApplication.save(
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
      const requestId = assignmentMutationRequestId({
        assignmentId: "assignment-1",
        domain: input.domain,
        operationId: input.operationId,
      });
      const mutationDigest = protocolDigest("AssignmentSkillTestMutation", 1, input);
      overlay.push({
        recordSeq,
        domain: input.domain,
        mutation: input.mutation,
        requestId,
        mutationDigest,
      });
      return {
        kind: "assignment-mutation-staged",
        requestId,
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

function admissionOptions() {
  return {
    admissionLlm: async () => JSON.stringify({
      decision: "safe",
      reason: "test",
    }),
  };
}

async function admissionDirectories(): Promise<string[]> {
  return await fs.readdir(path.join(os.tmpdir(), "zhixing-skill-admission"))
    .catch(() => []);
}
