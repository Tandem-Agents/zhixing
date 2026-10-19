/** v1 is retained for authentic historical/local-domain objects. Fresh anchor
 * authorization separately requires v2 and a verified current-tenure match. */
export function assertOwnerTenureVersion(value: { readonly v: unknown; readonly anchorEpoch?: unknown }, label: string): void {
  if (value.v === 1 && value.anchorEpoch === undefined) return;
  if (value.v === 2 && Number.isSafeInteger(value.anchorEpoch) && Number(value.anchorEpoch) > 0) return;
  throw new TypeError(`${label} has an invalid version or anchor tenure`);
}

export function assertCurrentAnchorTenure(input: { readonly anchorEpoch?: number; readonly signerDeviceId: string },
  current: { readonly anchorEpoch: number; readonly deviceId: string }): void {
  if (input.anchorEpoch !== current.anchorEpoch || input.signerDeviceId !== current.deviceId) {
    throw new TypeError('Request does not belong to the verified current anchor tenure');
  }
}
