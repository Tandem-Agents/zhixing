const INPUT_TYPE: unique symbol = Symbol("product-api-input");
const RESULT_TYPE: unique symbol = Symbol("product-api-result");
const FACT_TYPE: unique symbol = Symbol("product-api-fact");

export type ProductApiOperationKind = "query" | "command";

export interface ProductApiFact {
  readonly kind: string;
}

export interface ProductApiOperationDescriptor<
  Identity extends string = string,
  Kind extends ProductApiOperationKind = ProductApiOperationKind,
  Input = unknown,
  Result = unknown,
  Fact extends ProductApiFact = ProductApiFact,
> {
  readonly identity: Identity;
  readonly kind: Kind;
  readonly factEvents: readonly string[];
  readonly [INPUT_TYPE]?: Input;
  readonly [RESULT_TYPE]?: Result;
  readonly [FACT_TYPE]?: Fact;
}

export interface ProductApiFactEventDescriptor<
  Identity extends string = string,
  Fact extends ProductApiFact = ProductApiFact,
> {
  readonly identity: Identity;
  readonly [FACT_TYPE]?: Fact;
}

type OperationInput<Descriptor> = Descriptor extends ProductApiOperationDescriptor<
  string,
  ProductApiOperationKind,
  infer Input,
  unknown,
  ProductApiFact
> ? Input : never;

type OperationResult<Descriptor> = Descriptor extends ProductApiOperationDescriptor<
  string,
  ProductApiOperationKind,
  unknown,
  infer Result,
  ProductApiFact
> ? Result : never;

type OperationFact<Descriptor> = Descriptor extends ProductApiOperationDescriptor<
  string,
  ProductApiOperationKind,
  unknown,
  unknown,
  infer Fact
> ? Fact : never;

export interface ProductApiInvocation<Result = unknown, Fact extends ProductApiFact = ProductApiFact> {
  readonly result: Result;
  readonly facts: readonly Fact[];
}

export interface ProductApiOperationContribution {
  readonly descriptor: ProductApiOperationDescriptor;
  invoke(input: unknown): Promise<ProductApiInvocation>;
}

export interface ProductApiContribution {
  readonly operations: readonly ProductApiOperationContribution[];
  readonly factEvents: readonly ProductApiFactEventDescriptor[];
}

export interface ProductApiExactSet {
  readonly operations: readonly ProductApiOperationDescriptor[];
  readonly factEvents: readonly ProductApiFactEventDescriptor[];
}

export function defineProductApiQuery<Identity extends string, Input, Result>(
  identity: Identity,
): ProductApiOperationDescriptor<Identity, "query", Input, Result, never> {
  return Object.freeze({ identity, kind: "query", factEvents: Object.freeze([]) });
}

export function defineProductApiCommand<
  Identity extends string,
  Input,
  Result,
  Fact extends ProductApiFact,
>(
  identity: Identity,
  factEvents: readonly ProductApiFactEventDescriptor<string, Fact>[],
): ProductApiOperationDescriptor<Identity, "command", Input, Result, Fact> {
  return Object.freeze({
    identity,
    kind: "command",
    factEvents: Object.freeze(factEvents.map((event) => event.identity)),
  });
}

export function defineProductApiFactEvent<Identity extends string, Fact extends ProductApiFact>(
  identity: Identity,
): ProductApiFactEventDescriptor<Identity, Fact> {
  return Object.freeze({ identity });
}

export function bindProductApiOperation<
  Descriptor extends ProductApiOperationDescriptor,
>(
  descriptor: Descriptor,
  invoke: (
    input: OperationInput<Descriptor>,
  ) => Promise<ProductApiInvocation<OperationResult<Descriptor>, OperationFact<Descriptor>>>,
): ProductApiOperationContribution {
  return Object.freeze({
    descriptor,
    invoke: async (input: unknown) => await invoke(input as OperationInput<Descriptor>),
  });
}

export function defineProductApiContribution(input: ProductApiContribution): ProductApiContribution {
  return Object.freeze({
    operations: Object.freeze([...input.operations]),
    factEvents: Object.freeze([...input.factEvents]),
  });
}

export function defineProductApiExactSet(input: ProductApiExactSet): ProductApiExactSet {
  return Object.freeze({
    operations: Object.freeze([...input.operations]),
    factEvents: Object.freeze([...input.factEvents]),
  });
}

export interface ProductApiCommandDispatch<Result, Fact extends ProductApiFact> {
  readonly result: Result;
  readonly facts: readonly Fact[];
}

/**
 * Immutable, transport-independent Product API dispatcher.
 *
 * Construction receives the complete expected set and all contributions at once.
 * It has no registration surface after construction, so a Host can only publish a
 * complete, sealed catalog.
 */
export class ProductApiDispatcher {
  readonly #operations: ReadonlyMap<string, ProductApiOperationContribution>;
  readonly #factEvents: ReadonlySet<string>;

  constructor(exactSet: ProductApiExactSet, contributions: readonly ProductApiContribution[]) {
    const expectedOperations = uniqueDescriptors(exactSet.operations, "expected operation");
    const expectedFacts = uniqueDescriptors(exactSet.factEvents, "expected fact event");
    const operations = new Map<string, ProductApiOperationContribution>();
    const factEvents = new Set<string>();

    for (const descriptor of expectedOperations.values()) {
      if (!Object.isFrozen(descriptor) || !Object.isFrozen(descriptor.factEvents)) {
        throw new TypeError(`Product API operation descriptor is not sealed: ${descriptor.identity}`);
      }
    }
    for (const descriptor of expectedFacts.values()) {
      if (!Object.isFrozen(descriptor)) {
        throw new TypeError(`Product API fact event descriptor is not sealed: ${descriptor.identity}`);
      }
    }

    for (const contribution of contributions) {
      for (const event of contribution.factEvents) {
        const expected = expectedFacts.get(event.identity);
        if (!expected) {
          throw new TypeError(`Unknown Product API fact event contribution: ${event.identity}`);
        }
        if (expected !== event) {
          throw new TypeError(`Product API fact event descriptor mismatch: ${event.identity}`);
        }
        if (factEvents.has(event.identity)) {
          throw new TypeError(`Duplicate Product API fact event contribution: ${event.identity}`);
        }
        factEvents.add(event.identity);
      }
      for (const operation of contribution.operations) {
        const expected = expectedOperations.get(operation.descriptor.identity);
        if (!expected) {
          throw new TypeError(
            `Unknown Product API operation contribution: ${operation.descriptor.identity}`,
          );
        }
        if (expected.kind !== operation.descriptor.kind) {
          throw new TypeError(
            `Product API operation kind mismatch: ${operation.descriptor.identity}`,
          );
        }
        if (expected !== operation.descriptor) {
          throw new TypeError(
            `Product API operation descriptor mismatch: ${operation.descriptor.identity}`,
          );
        }
        if (!sameIdentitySet(expected.factEvents, operation.descriptor.factEvents)) {
          throw new TypeError(
            `Product API operation fact set mismatch: ${operation.descriptor.identity}`,
          );
        }
        if (operations.has(operation.descriptor.identity)) {
          throw new TypeError(
            `Duplicate Product API operation contribution: ${operation.descriptor.identity}`,
          );
        }
        operations.set(operation.descriptor.identity, Object.freeze({
          descriptor: expected,
          invoke: operation.invoke,
        }));
      }
    }

    for (const identity of expectedOperations.keys()) {
      if (!operations.has(identity)) {
        throw new TypeError(`Missing Product API operation contribution: ${identity}`);
      }
    }
    for (const identity of expectedFacts.keys()) {
      if (!factEvents.has(identity)) {
        throw new TypeError(`Missing Product API fact event contribution: ${identity}`);
      }
    }

    this.#operations = operations;
    this.#factEvents = factEvents;
    Object.freeze(this);
  }

  async query<Descriptor extends ProductApiOperationDescriptor<string, "query">>(
    descriptor: Descriptor,
    input: OperationInput<Descriptor>,
  ): Promise<OperationResult<Descriptor>> {
    const invocation = await this.#invoke(descriptor, input);
    if (invocation.facts.length !== 0) {
      throw new TypeError(`Product API query emitted a fact event: ${descriptor.identity}`);
    }
    return invocation.result as OperationResult<Descriptor>;
  }

  supports(descriptor: ProductApiOperationDescriptor): boolean {
    return this.#operations.get(descriptor.identity)?.descriptor === descriptor;
  }

  async command<Descriptor extends ProductApiOperationDescriptor<string, "command">>(
    descriptor: Descriptor,
    input: OperationInput<Descriptor>,
  ): Promise<ProductApiCommandDispatch<OperationResult<Descriptor>, OperationFact<Descriptor>>> {
    const invocation = await this.#invoke(descriptor, input);
    const allowedFacts = new Set(descriptor.factEvents);
    for (const fact of invocation.facts) {
      if (
        !fact || typeof fact !== "object" || typeof fact.kind !== "string" ||
        !allowedFacts.has(fact.kind) || !this.#factEvents.has(fact.kind)
      ) {
        throw new TypeError(`Product API command emitted an unknown fact event: ${descriptor.identity}`);
      }
    }
    if (!sameIdentitySet(descriptor.factEvents, invocation.facts.map((fact) => fact.kind))) {
      throw new TypeError(`Product API command fact set mismatch: ${descriptor.identity}`);
    }
    return Object.freeze({
      result: invocation.result as OperationResult<Descriptor>,
      facts: Object.freeze([...invocation.facts]) as readonly OperationFact<Descriptor>[],
    });
  }

  async #invoke(
    descriptor: ProductApiOperationDescriptor,
    input: unknown,
  ): Promise<ProductApiInvocation> {
    const operation = this.#operations.get(descriptor.identity);
    if (!operation) {
      throw new TypeError(`Unknown Product API operation: ${descriptor.identity}`);
    }
    if (operation.descriptor.kind !== descriptor.kind) {
      throw new TypeError(`Product API operation kind mismatch: ${descriptor.identity}`);
    }
    if (operation.descriptor !== descriptor) {
      throw new TypeError(`Product API operation descriptor mismatch: ${descriptor.identity}`);
    }
    return await operation.invoke(input);
  }
}

function uniqueDescriptors<Descriptor extends { readonly identity: string }>(
  descriptors: readonly Descriptor[],
  label: string,
): ReadonlyMap<string, Descriptor> {
  const result = new Map<string, Descriptor>();
  for (const descriptor of descriptors) {
    if (result.has(descriptor.identity)) {
      throw new TypeError(`Duplicate Product API ${label}: ${descriptor.identity}`);
    }
    result.set(descriptor.identity, descriptor);
  }
  return result;
}

function sameIdentitySet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((identity) => right.includes(identity));
}
