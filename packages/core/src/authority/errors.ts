export type AuthorityStorageErrorCode =
  | "artifact-missing"
  | "artifact-corrupt"
  | "commit-log-corrupt"
  | "invalid-authority-record";

export class AuthorityStorageError extends Error {
  readonly code: AuthorityStorageErrorCode;
  readonly reasonCode: string;

  constructor(code: AuthorityStorageErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AuthorityStorageError";
    this.code = code;
    this.reasonCode = {
      "artifact-missing": "AUTHORITY_ARTIFACT_MISSING",
      "artifact-corrupt": "AUTHORITY_ARTIFACT_CORRUPT",
      "commit-log-corrupt": "AUTHORITY_COMMIT_LOG_CORRUPT",
      "invalid-authority-record": "AUTHORITY_RECORD_INVALID",
    }[code];
  }
}
