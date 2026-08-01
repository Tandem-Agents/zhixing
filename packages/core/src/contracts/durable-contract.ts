export type DurableRecoveryClass =
  | "authority-replay"
  | "derived-rebuild"
  | "committed-forward-recovery";

export type DurableContractCaseKind = "variant" | "rejection" | "corruption";

export interface DurableContractVariantCase {
  readonly kind: "variant";
  readonly key: string;
}

export interface DurableContractFailureCase {
  readonly kind: "rejection" | "corruption";
  readonly key: string;
  readonly reasonCode: string;
}

export type DurableContractCase =
  | DurableContractVariantCase
  | DurableContractFailureCase;

export interface DurableRuntimeContractDescriptor {
  readonly recordFamily: string;
  readonly producer: string;
  readonly recoveryOwner: string;
  readonly resourceIdentity: string;
  readonly recoveryClass: DurableRecoveryClass;
  readonly cases: readonly DurableContractCase[];
}

/** Freezes and validates the runtime descriptor at its production owner. */
export function defineDurableRuntimeContract<T extends DurableRuntimeContractDescriptor>(
  descriptor: T,
): Readonly<T> {
  const keys = new Set<string>();
  for (const item of descriptor.cases) {
    const identity = `${item.kind}:${item.key}`;
    if (keys.has(identity)) throw new TypeError(`Duplicate durable contract case: ${identity}`);
    if (item.kind === "variant" && "reasonCode" in item) {
      throw new TypeError(`Durable variant must not declare a reason code: ${identity}`);
    }
    if (item.kind !== "variant" && !/^[A-Z][A-Z0-9_]+$/u.test(item.reasonCode)) {
      throw new TypeError(`Durable contract reason code is not stable: ${item.reasonCode}`);
    }
    keys.add(identity);
    Object.freeze(item);
  }
  Object.freeze(descriptor.cases);
  return Object.freeze(descriptor);
}
