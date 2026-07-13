export type AuthorityStorageErrorCode =
  | "artifact-missing"
  | "artifact-corrupt"
  | "commit-log-corrupt"
  | "invalid-authority-record";

export class AuthorityStorageError extends Error {
  readonly code: AuthorityStorageErrorCode;

  constructor(code: AuthorityStorageErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AuthorityStorageError";
    this.code = code;
  }
}
