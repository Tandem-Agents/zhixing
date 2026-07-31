export type DurableRecoveryClass =
  | "authority-replay"
  | "derived-rebuild"
  | "committed-forward-recovery";

export type DurableContractCaseKind = "variant" | "rejection" | "corruption";

export interface DurableContractCase {
  readonly kind: DurableContractCaseKind;
  readonly key: string;
  readonly reasonCode: string;
}

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
    if (!/^[A-Z][A-Z0-9_]+$/u.test(item.reasonCode)) {
      throw new TypeError(`Durable contract reason code is not stable: ${item.reasonCode}`);
    }
    keys.add(identity);
    Object.freeze(item);
  }
  Object.freeze(descriptor.cases);
  return Object.freeze(descriptor);
}
