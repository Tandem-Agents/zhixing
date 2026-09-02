export interface WorkspaceBindingCatalogRootDocument {
  readonly bytes: string;
  readonly snapshotToken: string;
}

export type WorkspaceBindingCatalogRootCommit =
  | {
      readonly kind: "committed";
      readonly snapshotToken: string;
    }
  | { readonly kind: "conflict" };

/** Physical root-manifest persistence demanded by the Workspace catalog. */
export interface WorkspaceBindingCatalogPersistencePort {
  load(): Promise<WorkspaceBindingCatalogRootDocument | undefined>;
  compareAndSwap(input: {
    readonly expectedSnapshotToken: string | undefined;
    readonly replacementBytes: string;
  }): Promise<WorkspaceBindingCatalogRootCommit>;
}
