const kernelRuntimeIdentityProvenance = Symbol("KernelRuntimeIdentityContribution");

/**
 * Finite identity contribution consumed by the Kernel assembly boundary.
 *
 * Product composition must use the constructor below. Private provenance keeps
 * a structurally similar untyped object from becoming a second identity contract.
 */
export interface KernelRuntimeIdentityContribution {
  readonly sceneId: string;
  readonly [kernelRuntimeIdentityProvenance]: true;
}

export function createKernelRuntimeIdentityContribution(
  sceneId: string,
): KernelRuntimeIdentityContribution {
  if (typeof sceneId !== "string" || sceneId.length === 0) {
    throw new TypeError("Kernel runtime identity requires a non-empty sceneId");
  }
  const identity = { sceneId } as {
    sceneId: string;
    [kernelRuntimeIdentityProvenance]?: true;
  };
  Object.defineProperty(identity, kernelRuntimeIdentityProvenance, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return Object.freeze(identity) as KernelRuntimeIdentityContribution;
}

export function assertKernelRuntimeIdentityContribution(
  value: unknown,
): asserts value is KernelRuntimeIdentityContribution {
  if (!value || typeof value !== "object") {
    throw new TypeError("Kernel runtime identity contribution is invalid");
  }
  const identity = value as Record<PropertyKey, unknown>;
  const keys = Object.keys(identity);
  const symbols = Object.getOwnPropertySymbols(identity);
  if (
    keys.length !== 1 ||
    keys[0] !== "sceneId" ||
    typeof identity.sceneId !== "string" ||
    identity.sceneId.length === 0 ||
    symbols.length !== 1 ||
    symbols[0] !== kernelRuntimeIdentityProvenance ||
    identity[kernelRuntimeIdentityProvenance] !== true ||
    !Object.isFrozen(identity)
  ) {
    throw new TypeError("Kernel runtime identity contribution is invalid");
  }
}
