export interface EmbeddedReleaseTrust {
  readonly keyId: string;
  readonly publicKeySpki: string;
}

// Development builds deliberately perform no network maintenance.
export const STABLE_RELEASE_INDEX_URL: string | undefined = undefined;
export const EMBEDDED_RELEASE_TRUST: EmbeddedReleaseTrust | undefined = undefined;
