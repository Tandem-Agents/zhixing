/** Local Configuration owns the read policy; startup/terminal adapters receive
 * one application snapshot and do not compose Authority or exposure rules. */
import { loadConfigurationSnapshot, editConfiguration, type CredentialStoreCoordinator } from "@zhixing/providers/configuration";
import type { SecretStorePort } from "@zhixing/core/contracts";
import { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";
import { CredentialExposureAuthority } from "./credential-exposure-authority.js";

export interface LocalConfigurationPort {
  read(): ReturnType<typeof loadConfigurationSnapshot>;
  edit(base: Parameters<typeof editConfiguration>[0], edit: Parameters<typeof editConfiguration>[1],
    options?: Pick<Parameters<typeof editConfiguration>[2], "scope" | "prepare">): ReturnType<typeof editConfiguration>;
}

export function createLocalConfigurationApplication(options: {
  readonly homeDir: string;
  readonly configPath: string;
  readonly store: SecretStorePort & CredentialStoreCoordinator;
  readonly records?: import("@zhixing/core/logging").LogRecordPort;
  readonly processIdentityResolver?: import("@zhixing/core/persistence").FileLockOptions["processIdentityResolver"];
}): LocalConfigurationPort {
  return {
    edit: (base, edit, policy) => editConfiguration(base, edit, {
      ...policy, configPath: options.configPath, store: options.store, records: options.records,
      processIdentityResolver: options.processIdentityResolver,
    }),
    async read() {
      // Prepare the read-only safety view before Configuration takes its own
      // publication lock. Every call observes fresh trust and closes its lease.
      const owner = await FileMeshBootstrapStore.open(options.homeDir, undefined, { readOnly: true, secretStore: options.store });
      try {
        const trust = await owner.loadCurrentTrust();
        const refs = trust ? await options.store.list("device-key/device/v1/") : [];
        const deviceId = refs.length === 1 ? refs[0]!.bindingId.slice("device/v1/".length) : undefined;
        const guarded = deviceId && trust?.members.some(member => member.device.deviceId === deviceId && member.state === "active");
        const exposure = guarded ? new CredentialExposureAuthority({ deviceId: deviceId!, log: owner.authorityLog(), secretStore: options.store }) : undefined;
        return await loadConfigurationSnapshot({
          configPath: options.configPath, store: options.store, records: options.records,
          processIdentityResolver: options.processIdentityResolver, legacyHomeDir: options.homeDir,
          ...(exposure ? { authorizeCredentialRead: async ({ kind, id }: { kind: "provider" | "channel" | "mcp"; id: string }) => {
            try { await exposure.assertConfigurationRoute(kind, id); return true; }
            catch { return false; }
          } } : {}),
        });
      } finally { await owner.stopStorageMaintenance(); }
    },
  };
}
