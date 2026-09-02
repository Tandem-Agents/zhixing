export type BackupTargetBinding =
  | {
      readonly kind: "directory";
      readonly targetId: string;
      readonly directory: string;
    }
  | {
      readonly kind: "paired-device";
      readonly targetId: string;
      readonly deviceId: string;
    };

export interface BackupTargetConfiguration {
  readonly currentTargetId: string;
  readonly bindings: readonly BackupTargetBinding[];
}

/** Finite configuration demand shared by backup and recovery product consumers. */
export interface BackupTargetConfigurationRepository {
  readonly load: () => Promise<BackupTargetConfiguration | undefined>;
  readonly select: (binding: BackupTargetBinding) => Promise<void>;
}

/** Hides physical configuration storage capabilities from every demand-side consumer. */
export function projectBackupTargetConfigurationRepository(
  repository: BackupTargetConfigurationRepository,
): BackupTargetConfigurationRepository {
  if (typeof repository.load !== "function" || typeof repository.select !== "function") {
    throw new TypeError("Backup target configuration repository requires load and select");
  }
  return Object.freeze({
    load: async () => {
      const configuration = await repository.load();
      return configuration === undefined ? undefined : freezeConfiguration(configuration);
    },
    select: (binding: BackupTargetBinding) => repository.select(freezeBinding(binding)),
  });
}

function freezeConfiguration(
  configuration: BackupTargetConfiguration,
): BackupTargetConfiguration {
  return Object.freeze({
    currentTargetId: configuration.currentTargetId,
    bindings: Object.freeze(configuration.bindings.map(freezeBinding)),
  });
}

function freezeBinding(binding: BackupTargetBinding): BackupTargetBinding {
  switch (binding.kind) {
    case "directory":
      return Object.freeze({
        kind: binding.kind,
        targetId: binding.targetId,
        directory: binding.directory,
      });
    case "paired-device":
      return Object.freeze({
        kind: binding.kind,
        targetId: binding.targetId,
        deviceId: binding.deviceId,
      });
  }
}
