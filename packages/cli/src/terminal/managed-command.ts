import type { RuntimeLogging } from '../logging/runtime.js';
import type { PairCommandOptions } from '../serve/mesh-pair-command.js';
import type { BackupCommandOptions } from '../serve/backup-command.js';
import type { DisasterRecoveryCommandOptions } from '../serve/disaster-recovery-command.js';
import type { DutyMigrationCommandOptions } from '../runtime/duty-migration-command.js';
import type { DeviceRemovalCommandOptions, DeviceRemovalSelectionIO } from '../runtime/device-removal-command.js';
import type { AnchorUninstallCommandOptions, AnchorUninstallIO } from '../runtime/anchor-uninstall-command.js';

/** The existing command registry borrows these exact domain ports from N. */
export interface ManagedCommandPorts {
  readonly logging: RuntimeLogging;
  readonly prepare: (management: boolean) => Promise<void>;
  readonly write: (stream: 'stdout' | 'stderr', text: string) => void;
  readonly pair: PairCommandOptions;
  readonly backup: BackupCommandOptions;
  readonly recovery: DisasterRecoveryCommandOptions;
  readonly duty: DutyMigrationCommandOptions;
  readonly device: DeviceRemovalCommandOptions;
  readonly deviceIO: DeviceRemovalSelectionIO;
  readonly uninstall: AnchorUninstallCommandOptions;
  readonly uninstallIO: AnchorUninstallIO;
}
