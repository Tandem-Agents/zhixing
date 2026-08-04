import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  builtinIndexEntries,
  getBuiltinSkill,
  parseFrontmatter,
  renderSkillIndex,
  scrubSecrets,
  skillNameToId,
  stringifyFrontmatter,
  type SkillCatalogEntry,
  type SkillDraft,
  type SkillMode,
  type SkillSaveOutcome,
  type SkillTextLoader,
} from "@zhixing/core";
import type { ArtifactStore } from "@zhixing/core/authority";
import type {
  AssignmentGlobalQueryPort,
  GlobalStagedMutation,
} from "@zhixing/core/contracts";
import type {
  SkillAdmissionPort,
  SkillSaver,
} from "@zhixing/tools-builtin";
import { runContextStorage } from "./run-context.js";

const SKILL_INDEX_TOP_N = 20;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

export interface AssignmentSkillPorts {
  readonly loader: SkillTextLoader;
  readonly saver: SkillSaver;
  readonly admission: SkillAdmissionPort;
}

export function createAssignmentSkillPorts(
  artifacts: ArtifactStore,
): AssignmentSkillPorts {
  const staging = new SkillAdmissionWorkspace(artifacts);
  return {
    loader: {
      async loadText(id, operationId) {
        const builtin = getBuiltinSkill(id);
        const entry = await readSkillEntry(id);
        if (!entry) {
          if (!builtin) throw new Error(`Skill not found: ${id}`);
          return { id: builtin.id, name: builtin.name, body: builtin.body };
        }
        const document = decoder.decode(await artifacts.get(entry.contentRef));
        const parsed = parseFrontmatter(document);
        await stageSkillMutation(
          operationId,
          "usage",
          {
            kind: "skill-usage",
            record: {
              skillId: entry.id,
              occurredAt: requireAssignmentTime(),
              hitDelta: 1,
            },
          },
        );
        return { id: entry.id, name: entry.name, body: parsed.content };
      },
    },
    saver: async (draft, operationId) => {
      const name = scrubSecrets(draft.name);
      const description = scrubSecrets(draft.description);
      const body = scrubSecrets(draft.body);
      const normalized: SkillDraft = {
        name: name.scrubbed.trim(),
        description: description.scrubbed.trim(),
        body: body.scrubbed.trim(),
        mode: draft.mode,
      };
      const id = skillNameToId(normalized.name);
      if (!id || !normalized.description || !normalized.body) {
        throw new Error("Skill name, description and body must remain non-empty");
      }
      const current = await readSkillEntry(id);
      const content = await artifacts.put(
        encoder.encode(
          stringifyFrontmatter(
            { name: normalized.name, description: normalized.description },
            normalized.body,
          ),
        ),
      );
      await stageSkillMutation(
        operationId,
        "save",
        current
          ? {
              kind: "skill-update",
              skillId: current.id,
              record: {
                name: normalized.name,
                description: normalized.description,
                content,
              },
              mode: normalized.mode,
              expectedRevision: current.revision,
            }
          : {
              kind: "skill-create",
              record: {
                name: normalized.name,
                description: normalized.description,
                content,
              },
              mode: normalized.mode,
            },
      );
      return {
        id,
        name: normalized.name,
        outcome: current ? "updated" : "created",
        scrubbedCount:
          name.redactions.length +
          description.redactions.length +
          body.redactions.length,
      } satisfies SkillSaveOutcome;
    },
    admission: staging,
  };
}

export async function renderAssignmentSkillIndex(
  mode: SkillMode,
  query: AssignmentGlobalQueryPort,
): Promise<{ readonly catalogRevision: number; readonly content: string | null }> {
  if (!query) throw new Error("Skill index requires the assignment global query port");
  const result = await query.read({
    kind: "skill-catalog",
    includeDisabled: true,
  });
  if (result.kind !== "skill-catalog") {
    throw new Error("Skill catalog query returned another result type");
  }
  const userIds = new Set(result.entries.map((entry) => entry.id));
  const user = result.entries
    .filter((entry) => entry.mode === mode && !entry.disabled)
    .slice(0, SKILL_INDEX_TOP_N);
  return {
    catalogRevision: result.catalogRevision,
    content: renderSkillIndex([
      ...user,
      ...builtinIndexEntries(mode, userIds),
    ]),
  };
}

async function readSkillEntry(id: string): Promise<SkillCatalogEntry | null> {
  const run = requireRunSkillContext();
  const result = await run.globalQuery.read({ kind: "skill-get", skillId: id });
  if (result.kind !== "skill-get") {
    throw new Error("Skill query returned another result type");
  }
  let entry = result.entry;
  for (const record of await run.assignmentMutations.readOverlay()) {
    if (record.domain !== "global") continue;
    const mutation = record.mutation;
    if (
      mutation.kind === "skill-create" ||
      mutation.kind === "skill-admit" ||
      mutation.kind === "skill-update"
    ) {
      const mutationId = skillNameToId(mutation.record.name);
      if (mutationId !== id) continue;
      entry = {
        id: mutationId,
        name: mutation.record.name,
        description: mutation.record.description,
        source: mutation.kind === "skill-admit" ? "linked" : "own",
        mode: mutation.mode,
        pinned: entry?.pinned ?? false,
        disabled: false,
        createdAt: entry?.createdAt ?? requireAssignmentTime(),
        usage: entry?.usage ?? null,
        contentRef: mutation.record.content,
        revision: entry ? entry.revision + 1 : 1,
        digest: record.mutationDigest,
      };
    }
  }
  return entry;
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

async function stageSkillMutation(
  operationId: string | undefined,
  suffix: string,
  mutation: Extract<
    GlobalStagedMutation,
    { kind: "skill-create" | "skill-update" | "skill-admit" | "skill-usage" }
  >,
): Promise<void> {
  if (!operationId) throw new Error("Skill mutation requires a durable tool operation id");
  await requireRunSkillContext().assignmentMutations.stage({
    domain: "global",
    operationId: `${operationId}:${suffix}`,
    mutation,
  });
}

class SkillAdmissionWorkspace implements SkillAdmissionPort {
  readonly #root = path.join(os.tmpdir(), "zhixing-skill-admission");

  constructor(private readonly artifacts: ArtifactStore) {}

  async prepareStaging(): Promise<string> {
    await fs.mkdir(this.#root, { recursive: true });
    return fs.mkdtemp(path.join(this.#root, "candidate-"));
  }

  async discardStaging(dir: string): Promise<void> {
    this.#assertOwned(dir);
    await fs.rm(dir, { recursive: true, force: true });
  }

  async admit(
    stagingDir: string,
    opts?: { mode?: SkillMode; operationId?: string },
  ): Promise<{ id: string; name: string }> {
    this.#assertOwned(stagingDir);
    requireRunSkillContext();
    const document = await fs.readFile(path.join(stagingDir, "SKILL.md"), "utf8");
    const parsed = parseFrontmatter(document);
    const name = typeof parsed.data.name === "string" ? parsed.data.name.trim() : "";
    const description = typeof parsed.data.description === "string"
      ? parsed.data.description.trim()
      : "";
    const id = skillNameToId(name);
    if (!id || !description) {
      throw new Error("Skill frontmatter requires name and description");
    }
    const content = await this.artifacts.put(encoder.encode(document));
    await stageSkillMutation(opts?.operationId, "admit", {
      kind: "skill-admit",
      record: { name, description, content },
      mode: opts?.mode ?? "main",
    });
    return { id, name };
  }

  async sweepStaleStaging(maxAgeMs: number): Promise<number> {
    await fs.mkdir(this.#root, { recursive: true });
    let removed = 0;
    for (const name of await fs.readdir(this.#root)) {
      const dir = path.join(this.#root, name);
      if (!name.startsWith("candidate-")) continue;
      const stat = await fs.stat(dir).catch(() => null);
      if (!stat?.isDirectory() || Date.now() - stat.mtimeMs <= maxAgeMs) continue;
      await fs.rm(dir, { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  }

  #assertOwned(input: string): void {
    const relative = path.relative(this.#root, path.resolve(input));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Skill staging directory is outside the admission workspace");
    }
  }
}
