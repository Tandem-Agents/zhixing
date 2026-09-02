export interface WorkspaceProbePersistenceObservation {
  readonly establishmentMarker: "absent" | "present";
  readonly authorityLog: "absent" | "present";
}

/**
 * Workspace probe demand's complete physical-persistence boundary.
 *
 * The probe owner decides establishment and replay from Authority facts. The
 * Host adapter owns where the shared Authority log and its durable sidecar
 * marker live, and exposes only the two observations needed by that decision.
 */
export interface WorkspaceProbePersistencePort {
  inspectEstablishment(): Promise<WorkspaceProbePersistenceObservation>;
  publishEstablishment(): Promise<void>;
}
