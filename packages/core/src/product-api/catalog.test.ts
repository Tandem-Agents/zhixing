import { describe, expect, it, vi } from "vitest";
import {
  createSkillCatalogProductApiContribution,
  SKILL_CATALOG_ARCHIVE_COMMAND,
  SKILL_CATALOG_LIST_QUERY,
  SKILL_CATALOG_PRODUCT_API_EXACT_SET,
  type SkillCatalogApplication,
} from "../skills/catalog-application.js";
import {
  bindProductApiOperation,
  defineProductApiCommand,
  defineProductApiContribution,
  defineProductApiExactSet,
  defineProductApiFactEvent,
  defineProductApiQuery,
  ProductApiDispatcher,
} from "./catalog.js";

describe("ProductApiDispatcher", () => {
  const changed = defineProductApiFactEvent<
    "example-changed",
    { readonly kind: "example-changed"; readonly revision: number }
  >("example-changed");
  const read = defineProductApiQuery<"example.query", { readonly id: string }, string>(
    "example.query",
  );
  const write = defineProductApiCommand<
    "example.command",
    { readonly value: string },
    { readonly ok: true },
    { readonly kind: "example-changed"; readonly revision: number }
  >("example.command", [changed]);
  const exactSet = defineProductApiExactSet({
    operations: [read, write],
    factEvents: [changed],
  });

  function contribution() {
    return defineProductApiContribution({
      operations: [
        bindProductApiOperation(read, async ({ id }) => ({ result: id, facts: [] })),
        bindProductApiOperation(write, async () => ({
          result: { ok: true },
          facts: [{ kind: "example-changed", revision: 2 }],
        })),
      ],
      factEvents: [changed],
    });
  }

  it("dispatches typed in-process queries and commands without a transport", async () => {
    const dispatcher = new ProductApiDispatcher(exactSet, [contribution()]);

    await expect(dispatcher.query(read, { id: "local" })).resolves.toBe("local");
    await expect(dispatcher.command(write, { value: "next" })).resolves.toEqual({
      result: { ok: true },
      facts: [{ kind: "example-changed", revision: 2 }],
    });
    expect(Object.isFrozen(dispatcher)).toBe(true);
    expect(Object.isFrozen(exactSet.operations)).toBe(true);
    expect(Reflect.set(dispatcher, "register", vi.fn())).toBe(false);
    expect(dispatcher.supports(read)).toBe(true);
    expect(dispatcher.supports(write)).toBe(true);
    const unknown = defineProductApiQuery<"unknown", undefined, undefined>("unknown");
    expect(dispatcher.supports(unknown)).toBe(false);
  });

  it("fails closed for duplicate, missing, unknown and kind-mismatched contributions", () => {
    expect(() => new ProductApiDispatcher({
      operations: [{ identity: "mutable", kind: "query", factEvents: [] }],
      factEvents: [],
    }, [])).toThrow("Product API operation descriptor is not sealed: mutable");
    expect(() => new ProductApiDispatcher(
      defineProductApiExactSet({ operations: [read, read], factEvents: [changed] }),
      [contribution()],
    )).toThrow("Duplicate Product API expected operation: example.query");
    expect(() => new ProductApiDispatcher(exactSet, [])).toThrow(
      "Missing Product API operation contribution: example.query",
    );
    const unknown = defineProductApiQuery<"unknown", undefined, undefined>("unknown");
    expect(() => new ProductApiDispatcher(exactSet, [defineProductApiContribution({
      operations: [bindProductApiOperation(unknown, async () => ({ result: undefined, facts: [] }))],
      factEvents: [],
    })])).toThrow("Unknown Product API operation contribution: unknown");
    const wrongKind = defineProductApiQuery<"example.command", { readonly value: string }, unknown>(
      "example.command",
    );
    expect(() => new ProductApiDispatcher(exactSet, [defineProductApiContribution({
      operations: [
        bindProductApiOperation(read, async ({ id }) => ({ result: id, facts: [] })),
        bindProductApiOperation(wrongKind, async () => ({ result: undefined, facts: [] })),
      ],
      factEvents: [changed],
    })])).toThrow("Product API operation kind mismatch: example.command");
  });

  it("rejects unknown dispatch identities and undeclared facts", async () => {
    const dispatcher = new ProductApiDispatcher(exactSet, [contribution()]);
    const unknown = defineProductApiQuery<"unknown", undefined, undefined>("unknown");
    await expect(dispatcher.query(unknown, undefined)).rejects.toThrow(
      "Unknown Product API operation: unknown",
    );
    const forgedRead = defineProductApiQuery<
      "example.query",
      { readonly id: string },
      string
    >("example.query");
    await expect(dispatcher.query(forgedRead, { id: "forged" })).rejects.toThrow(
      "Product API operation descriptor mismatch: example.query",
    );
    const invalidFacts = defineProductApiContribution({
      operations: [
        bindProductApiOperation(read, async ({ id }) => ({ result: id, facts: [] })),
        bindProductApiOperation(write, async () => ({
          result: { ok: true },
          facts: [{ kind: "not-declared", revision: 2 } as never],
        })),
      ],
      factEvents: [changed],
    });
    await expect(
      new ProductApiDispatcher(exactSet, [invalidFacts]).command(write, { value: "next" }),
    ).rejects.toThrow("Product API command emitted an unknown fact event: example.command");
    const missingFact = defineProductApiContribution({
      operations: [
        bindProductApiOperation(read, async ({ id }) => ({ result: id, facts: [] })),
        bindProductApiOperation(write, async () => ({ result: { ok: true }, facts: [] })),
      ],
      factEvents: [changed],
    });
    await expect(
      new ProductApiDispatcher(exactSet, [missingFact]).command(write, { value: "next" }),
    ).rejects.toThrow("Product API command fact set mismatch: example.command");
  });

  it("allows only explicitly declared commands to omit a fact on no-write outcomes", async () => {
    const optionalWrite = defineProductApiCommand<
      "example.optional-command",
      { readonly value: string },
      { readonly ok: false },
      { readonly kind: "example-changed"; readonly revision: number }
    >("example.optional-command", [changed], { factEmission: "subset" });
    const dispatcher = new ProductApiDispatcher(
      defineProductApiExactSet({
        operations: [optionalWrite],
        factEvents: [changed],
      }),
      [defineProductApiContribution({
        operations: [
          bindProductApiOperation(optionalWrite, async () => ({
            result: { ok: false },
            facts: [],
          })),
        ],
        factEvents: [changed],
      })],
    );

    await expect(dispatcher.command(optionalWrite, { value: "unchanged" }))
      .resolves.toEqual({ result: { ok: false }, facts: [] });
  });

  it("uses the Skill-owned contribution as the single application call and fact source", async () => {
    const query = vi.fn<SkillCatalogApplication["query"]>(async () => ({
      entries: [],
      catalogRevision: 4,
    }));
    const execute = vi.fn<SkillCatalogApplication["execute"]>(async () => ({
      fact: { kind: "skill-catalog-changed", catalogRevision: 5 },
    }));
    const dispatcher = new ProductApiDispatcher(SKILL_CATALOG_PRODUCT_API_EXACT_SET, [
      createSkillCatalogProductApiContribution({ query, execute }),
    ]);

    await expect(dispatcher.query(SKILL_CATALOG_LIST_QUERY, { kind: "list" })).resolves.toEqual({
      entries: [],
      catalogRevision: 4,
    });
    await expect(dispatcher.command(SKILL_CATALOG_ARCHIVE_COMMAND, {
      kind: "archive",
      skillId: "own-one",
    })).resolves.toEqual({
      result: { fact: { kind: "skill-catalog-changed", catalogRevision: 5 } },
      facts: [{ kind: "skill-catalog-changed", catalogRevision: 5 }],
    });
    expect(query).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });
});
