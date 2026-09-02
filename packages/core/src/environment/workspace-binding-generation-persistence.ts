export interface WorkspaceBindingGenerationPersistenceObservation {
  readonly establishmentMarker: "absent" | "present";
  readonly authorityLog: "absent" | "present";
}

/**
 * Physical persistence demanded by one workspace-binding catalog generation.
 *
 * The domain owner decides whether the generation is established from its
 * Authority facts. The Host adapter owns the generation directory, marker
 * bytes and the concrete WAL path paired with this instance.
 */
export interface WorkspaceBindingGenerationPersistencePort {
  inspectEstablishment(): Promise<WorkspaceBindingGenerationPersistenceObservation>;
  publishEstablishment(): Promise<void>;
}
