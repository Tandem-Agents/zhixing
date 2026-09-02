import { randomUUID } from "node:crypto";
import {
  parseRubricDocument,
  projectRubricContractDraft,
  rubricDocumentId,
  stringifyRubricDraft,
  type RubricCatalogPort,
  type RubricIndexEntry,
} from "@zhixing/core";
import type {
  AssignmentGlobalQueryPort,
  Digest,
  GlobalControlCallContext,
  GlobalReadCallContext,
  GlobalStatePort,
} from "@zhixing/core/contracts";
import type {
  AdvancementRubricArtifactPort,
  RubricPublicationOutcome,
  RubricPublicationPort,
} from "@zhixing/core/advancement/application";

export interface AdvancementRubricLibraryOptions {
  readonly globalState: () => GlobalStatePort | undefined;
  readonly artifacts: () => AdvancementRubricArtifactPort | undefined;
  readonly anchorEpoch: () => number | undefined;
  readonly executionAssets?: () =>
    | (AssignmentGlobalQueryPort & {
        readArtifact(digest: string): Promise<Uint8Array | undefined>;
      })
    | undefined;
  readonly now?: () => string;
}

export class GlobalRubricCatalog implements RubricCatalogPort {
  readonly #options: AdvancementRubricLibraryOptions;
  readonly #now: () => string;

  constructor(options: AdvancementRubricLibraryOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async listForMatching(): Promise<readonly RubricIndexEntry[]> {
    const result = await this.#readIndex();
    if (result.kind !== "asset-index") {
      throw new TypeError("Rubric catalog returned another global read result");
    }
    const assets = await Promise.all(result.entries.map(async (entry) => {
      try {
        return await this.#loadEntry(entry);
      } catch (error) {
        if (this.#options.executionAssets?.()) return undefined;
        throw error;
      }
    }));
    return assets.filter((asset): asset is NonNullable<typeof asset> => asset !== undefined)
      .map(({ id, title, description, source, createdAt, updatedAt }) => ({
      id, title, description, source, createdAt, updatedAt,
      }));
  }

  async load(id: string) {
    const result = await this.#readIndex();
    if (result.kind !== "asset-index") {
      throw new TypeError("Rubric catalog returned another global read result");
    }
    const entry = result.entries.find((candidate) => candidate.id === id);
    if (!entry) throw new Error(`Rubric "${id}" does not exist`);
    return this.#loadEntry(entry);
  }

  async #loadEntry(entry: {
    readonly id: string;
    readonly revision: number;
    readonly digest: Digest;
  }) {
    const cache = this.#options.executionAssets?.();
    const bytes = cache
      ? await cache.readArtifact(entry.digest)
      : await this.#readGlobalArtifact(entry.digest);
    if (!bytes) throw new Error(`Rubric "${entry.id}" content asset is missing`);
    const document = parseRubricDocument(Buffer.from(bytes).toString("utf8"));
    if (rubricDocumentId(document) !== entry.id) {
      throw new TypeError(`Rubric "${entry.id}" content identity is inconsistent`);
    }
    const epoch = "1970-01-01T00:00:00.000Z";
    return {
      id: entry.id,
      title: document.title,
      description: document.description,
      source: "own" as const,
      dir: "",
      file: `artifact:${entry.digest}`,
      createdAt: epoch,
      updatedAt: `revision:${entry.revision}`,
      document,
    };
  }

  async #readIndex() {
    const cache = this.#options.executionAssets?.();
    return cache
      ? cache.read({ kind: "asset-index", asset: "rubrics" })
      : this.#state().read(
          { kind: "asset-index", asset: "rubrics" },
          this.#readContext(),
        );
  }

  async #readGlobalArtifact(digest: Digest): Promise<Uint8Array | undefined> {
    return this.#artifacts().readByDigest(digest);
  }

  #state(): GlobalStatePort {
    const state = this.#options.globalState();
    if (!state) throw new Error("Global Rubric catalog is unavailable");
    return state;
  }

  #artifacts(): AdvancementRubricArtifactPort {
    const artifacts = this.#options.artifacts();
    if (!artifacts) throw new Error("Global Rubric artifacts are unavailable");
    return artifacts;
  }

  #readContext(): GlobalReadCallContext {
    const anchorEpoch = this.#options.anchorEpoch();
    if (!anchorEpoch) throw new Error("Global Rubric authority is unavailable");
    return {
      principal: { kind: "host", component: "advancement-rubric-catalog" },
      requestId: `rubric-read:${randomUUID()}`,
      deadlineAt: new Date(Date.parse(this.#now()) + 30_000).toISOString(),
      authority: { domain: "global", anchorEpoch },
    };
  }
}

export class GlobalRubricPublication implements RubricPublicationPort {
  readonly #options: AdvancementRubricLibraryOptions;
  readonly #now: () => string;

  constructor(options: AdvancementRubricLibraryOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  acceptanceOutcome(): RubricPublicationOutcome {
    return this.#options.globalState()
      && this.#options.artifacts()
      && this.#options.anchorEpoch()
      ? {
          kind: "deferred",
          message: "准则已用于本任务，正在独立保存到准则库。",
        }
      : {
          kind: "deferred",
          message: "准则已用于本任务，连接值班设备后可保存到准则库。",
        };
  }

  async publish(
    input: Parameters<RubricPublicationPort["publish"]>[0],
  ): Promise<RubricPublicationOutcome> {
    const state = this.#options.globalState();
    const artifacts = this.#options.artifacts();
    const anchorEpoch = this.#options.anchorEpoch();
    if (!state || !artifacts || !anchorEpoch) {
      return {
        kind: "deferred",
        message: "准则已用于本任务，连接值班设备后可保存到准则库。",
      };
    }
    const targetId = input.persistence.kind === "update-existing"
      ? input.persistence.rubricId
      : undefined;
    const draft = projectRubricContractDraft(input.draft, targetId);
    const raw = stringifyRubricDraft(draft);
    const document = parseRubricDocument(raw);
    const rubricId = rubricDocumentId(document);
    const content = await artifacts.put(Buffer.from(raw, "utf8"));
    const base = {
      title: document.title,
      description: document.description,
      content,
    };
    const context = await this.#writeContext(input, anchorEpoch);
    const result = input.persistence.kind === "update-existing"
      ? await state.mutate(
          {
            kind: "rubric-update-own",
            rubricId: input.persistence.rubricId,
            rubric: base,
            expectedRevision: context.expectedRevision!,
          },
          context,
        )
      : await state.mutate({ kind: "rubric-save-own", rubric: base }, context);
    return { kind: "saved", rubricId, revision: result.revision };
  }

  async #writeContext(
    input: Parameters<RubricPublicationPort["publish"]>[0],
    anchorEpoch: number,
  ): Promise<GlobalControlCallContext> {
    let expectedRevision: number | undefined;
    if (input.persistence.kind === "update-existing") {
      const rubricId = input.persistence.rubricId;
      const state = this.#options.globalState()!;
      const index = await state.read(
        { kind: "asset-index", asset: "rubrics" },
        {
          principal: { kind: "host", component: "advancement-rubric-publication" },
          requestId: `rubric-index:${input.draft.draftId}`,
          deadlineAt: new Date(Date.parse(this.#now()) + 30_000).toISOString(),
          authority: { domain: "global", anchorEpoch },
        },
      );
      if (index.kind !== "asset-index") throw new TypeError("Rubric index is unavailable");
      expectedRevision = index.entries.find(
        (entry) => entry.id === rubricId,
      )?.revision;
      if (!expectedRevision) throw new Error("Rubric update target does not exist");
    }
    return {
      principal: { kind: "host", component: "advancement-rubric-publication" },
      requestId: `rubric-publish:${input.draft.draftId}:${input.persistence.kind}`,
      deadlineAt: new Date(Date.parse(this.#now()) + 30_000).toISOString(),
      authority: { domain: "global", anchorEpoch },
      ...(expectedRevision ? { expectedRevision } : {}),
    };
  }
}
