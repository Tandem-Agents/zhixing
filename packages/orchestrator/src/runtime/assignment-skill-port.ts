import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  acquireToStaging,
  computeStagingDigest,
  type AdmissionLlm,
} from "@zhixing/core";
import {
  SkillCatalogAdmissionApplicationService,
  SkillCatalogLoadApplicationService,
  SkillCatalogKernelProjectionApplicationService,
  SkillCatalogSaveApplicationService,
  type SkillCatalogAdmissionApplication,
  type SkillCatalogAdmissionCandidate,
  type SkillCatalogAdmissionCorrectnessPort,
  type SkillCatalogAdmissionMutation,
  type SkillCatalogLoadApplication,
  type SkillCatalogLoadCorrectnessPort,
  type SkillCatalogKernelProjectionApplication,
  type SkillCatalogSaveApplication,
  type SkillCatalogSaveCorrectnessPort,
  type SkillCatalogSaveMutation,
  type SkillCatalogSaveOverlayRecord,
} from "@zhixing/core/skills/catalog";
import type { ArtifactStore } from "@zhixing/core/authority";
import type { AssignmentGlobalQueryPort } from "@zhixing/core/contracts";
import { assignmentMutationRequestId } from "@zhixing/core/protocol";
import { runContextStorage } from "./run-context.js";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export interface AssignmentSkillPorts {
  readonly loadApplication: SkillCatalogLoadApplication;
  readonly saveApplication: SkillCatalogSaveApplication;
  readonly admissionApplication: SkillCatalogAdmissionApplication;
}

export function createAssignmentSkillPorts(
  artifacts: ArtifactStore,
  options: {
    readonly admissionLlm: AdmissionLlm;
    readonly clock?: () => number;
    readonly randomToken?: () => string;
  },
): AssignmentSkillPorts {
  const admissionCorrectness = new AssignmentSkillAdmissionCorrectnessPort(
    artifacts,
    options,
  );
  const saveApplication = new SkillCatalogSaveApplicationService(
    createSkillCatalogSaveCorrectnessPort(artifacts),
  );
  return {
    loadApplication: new SkillCatalogLoadApplicationService(
      createSkillCatalogLoadCorrectnessPort(artifacts),
    ),
    saveApplication,
    admissionApplication: new SkillCatalogAdmissionApplicationService(
      admissionCorrectness,
    ),
  };
}

function createSkillCatalogLoadCorrectnessPort(
  artifacts: ArtifactStore,
): SkillCatalogLoadCorrectnessPort {
  return {
    async readScope(skillId) {
      const run = requireRunSkillContext();
      const result = await run.globalQuery.read({ kind: "skill-get", skillId });
      if (result.kind !== "skill-get") {
        throw new Error("Skill query returned another result type");
      }
      const overlay: SkillCatalogSaveOverlayRecord[] = [];
      for (const record of await run.assignmentMutations.readOverlay()) {
        if (record.domain !== "global") continue;
        const mutation = record.mutation;
        if (
          mutation.kind !== "skill-create" &&
          mutation.kind !== "skill-admit" &&
          mutation.kind !== "skill-update"
        ) {
          continue;
        }
        overlay.push({
          recordSeq: record.recordSeq,
          requestIdentity: record.requestId,
          mutation,
          mutationDigest: record.mutationDigest,
        });
      }
      return {
        kind: "assignment",
        entry: result.entry,
        overlay,
        issuedAt: requireAssignmentTime(),
      };
    },
    async readContent(content) {
      return decoder.decode(await artifacts.get(content));
    },
    async stageUsage(operationId, mutation) {
      await requireRunSkillContext().assignmentMutations.stage({
        domain: "global",
        operationId,
        mutation,
      });
    },
  };
}

function createSkillCatalogSaveCorrectnessPort(
  artifacts: ArtifactStore,
): SkillCatalogSaveCorrectnessPort {
  return {
    async readCatalogEntry(skillId) {
      const result = await requireRunSkillContext().globalQuery.read({
        kind: "skill-get",
        skillId,
      });
      if (result.kind !== "skill-get") {
        throw new Error("Skill query returned another result type");
      }
      return result.entry;
    },
    async readOverlay() {
      const records: SkillCatalogSaveOverlayRecord[] = [];
      for (const record of await requireRunSkillContext().assignmentMutations.readOverlay()) {
        if (record.domain !== "global") continue;
        const mutation = record.mutation;
        if (
          mutation.kind !== "skill-create" &&
          mutation.kind !== "skill-admit" &&
          mutation.kind !== "skill-update"
        ) {
          continue;
        }
        records.push({
          recordSeq: record.recordSeq,
          requestIdentity: record.requestId,
          mutation,
          mutationDigest: record.mutationDigest,
        });
      }
      return records;
    },
    requestIdentityFor(operationId) {
      const mutations = requireRunSkillContext().assignmentMutations;
      return assignmentMutationRequestId({
        assignmentId: mutations.assignmentId,
        domain: "global",
        operationId,
      });
    },
    putContent: (document) => artifacts.put(encoder.encode(document)),
    async stage(operationId, mutation: SkillCatalogSaveMutation) {
      await requireRunSkillContext().assignmentMutations.stage({
        domain: "global",
        operationId,
        mutation,
      });
    },
    assignmentIssuedAt: requireAssignmentTime,
  };
}

export function createAssignmentSkillProjectionApplication(
  query: AssignmentGlobalQueryPort,
): SkillCatalogKernelProjectionApplication {
  if (!query) throw new Error("Skill index requires the assignment global query port");
  return new SkillCatalogKernelProjectionApplicationService({
    async readCatalog() {
      const result = await query.read({
        kind: "skill-catalog",
        includeDisabled: true,
      });
      if (result.kind !== "skill-catalog") {
        throw new Error("Skill catalog query returned another result type");
      }
      return {
        catalogRevision: result.catalogRevision,
        entries: result.entries,
      };
    },
  });
}

function requireRunSkillContext() {
  const run = runContextStorage.getStore();
  if (!run?.globalQuery || !run.assignmentMutations) {
    throw new Error("Skill access requires an active durable assignment");
  }
  return {
    globalQuery: run.globalQuery,
    assignmentMutations: run.assignmentMutations,
  };
}

function requireAssignmentTime(): string {
  const at = runContextStorage.getStore()?.assignmentIssuedAt;
  if (!at) throw new Error("Skill mutation requires a durable assignment time");
  return at;
}

class AssignmentSkillAdmissionCorrectnessPort
  implements SkillCatalogAdmissionCorrectnessPort
{
  readonly #root = path.join(os.tmpdir(), "zhixing-skill-admission");
  readonly #candidates = new Map<string, string>();

  readonly admissionLlm: AdmissionLlm;

  constructor(
    private readonly artifacts: ArtifactStore,
    private readonly options: {
      readonly admissionLlm: AdmissionLlm;
      readonly clock?: () => number;
      readonly randomToken?: () => string;
    },
  ) {
    this.admissionLlm = options.admissionLlm;
  }

  async acquireLocalCandidate(
    sourcePath: string,
  ): Promise<SkillCatalogAdmissionCandidate> {
    await fs.mkdir(this.#root, { recursive: true });
    const dir = await fs.mkdtemp(path.join(this.#root, "candidate-"));
    const candidateId = randomUUID();
    this.#candidates.set(candidateId, dir);
    try {
      await acquireToStaging({ kind: "local-path", path: sourcePath }, dir);
      return await this.readCandidate(candidateId);
    } catch (error) {
      await this.discardCandidate(candidateId).catch(() => {});
      throw error;
    }
  }

  async readCandidate(candidateId: string): Promise<SkillCatalogAdmissionCandidate> {
    const dir = this.#requireCandidate(candidateId);
    await assertRegularCandidateTree(dir);
    const document = await fs.readFile(path.join(dir, "SKILL.md"), "utf8");
    return {
      candidateId,
      document,
      digest: await computeStagingDigest(dir),
    };
  }

  async discardCandidate(candidateId: string): Promise<void> {
    const dir = this.#requireCandidate(candidateId);
    this.#candidates.delete(candidateId);
    await fs.rm(dir, { recursive: true, force: true });
  }

  async sweepStaleCandidates(maxAgeMs: number): Promise<number> {
    await fs.mkdir(this.#root, { recursive: true });
    let removed = 0;
    for (const name of await fs.readdir(this.#root)) {
      const dir = path.join(this.#root, name);
      if (!name.startsWith("candidate-")) continue;
      const stat = await fs.stat(dir).catch(() => null);
      if (!stat?.isDirectory() || this.now() - stat.mtimeMs <= maxAgeMs) continue;
      await fs.rm(dir, { recursive: true, force: true });
      for (const [candidateId, candidateDir] of this.#candidates) {
        if (candidateDir === dir) this.#candidates.delete(candidateId);
      }
      removed += 1;
    }
    return removed;
  }

  putContent(document: string) {
    return this.artifacts.put(encoder.encode(document));
  }

  async stage(
    operationId: string,
    mutation: SkillCatalogAdmissionMutation,
  ): Promise<void> {
    if (!operationId) {
      throw new Error("Skill mutation requires a durable tool operation id");
    }
    await requireRunSkillContext().assignmentMutations.stage({
      domain: "global",
      operationId,
      mutation,
    });
  }

  now(): number {
    return this.options.clock?.() ?? Date.now();
  }

  newToken(): string {
    return this.options.randomToken?.() ?? randomUUID();
  }

  #requireCandidate(candidateId: string): string {
    const dir = this.#candidates.get(candidateId);
    if (!dir) throw new Error("Skill admission candidate is unknown");
    const relative = path.relative(this.#root, path.resolve(dir));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Skill staging directory is outside the admission workspace");
    }
    return dir;
  }
}

async function assertRegularCandidateTree(root: string): Promise<void> {
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      const stat = await fs.lstat(child);
      if (stat.isSymbolicLink()) {
        throw new Error("Skill admission candidate must not contain symbolic links");
      }
      if (stat.isDirectory()) {
        await visit(child);
      } else if (!stat.isFile()) {
        throw new Error("Skill admission candidate must contain only regular files");
      }
    }
  };
  await visit(root);
}
