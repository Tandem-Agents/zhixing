export type AuthorityStorageErrorCode =
  | "artifact-missing"
  | "artifact-corrupt"
  | "commit-log-corrupt"
  | "invalid-authority-record";

export class AuthorityStorageError extends Error {
  readonly validation?: string;
  readonly code: AuthorityStorageErrorCode;
  readonly reasonCode: string;

  constructor(code: AuthorityStorageErrorCode, message: string, options?: ErrorOptions & { validation?: AuthorityValidation }) {
    super(message, options);
    this.name = "AuthorityStorageError";
    this.code = code;
    this.validation = options?.validation && VALIDATION_CODES.has(options.validation) ? options.validation
      : Object.hasOwn(VALIDATION_FAILURES, message) ? VALIDATION_FAILURES[message] : undefined;
    this.reasonCode = {
      "artifact-missing": "AUTHORITY_ARTIFACT_MISSING",
      "artifact-corrupt": "AUTHORITY_ARTIFACT_CORRUPT",
      "commit-log-corrupt": "AUTHORITY_COMMIT_LOG_CORRUPT",
      "invalid-authority-record": "AUTHORITY_RECORD_INVALID",
    }[code];
  }
}

export type AuthorityValidation = 'artifact-reference' | 'stored-reference-fields' | 'protocol-identifier' | 'delivery-identifier' | 'execution-kind' | 'registered-artifact' | 'artifact-byte-conflict';
const VALIDATION_CODES = new Set<AuthorityValidation>(['artifact-reference', 'stored-reference-fields', 'protocol-identifier', 'delivery-identifier', 'execution-kind', 'registered-artifact', 'artifact-byte-conflict']);

// Exact constant messages only. Paths, IDs, JSON and exception prose are never
// projected as diagnostic fields.
const VALIDATION_FAILURES: Readonly<Record<string, string>> = Object.freeze({
  'Commit envelope is not valid JSON': 'envelope-json',
  'Commit envelope must be an object': 'envelope-object',
  'Commit envelope fields are invalid': 'envelope-fields',
  'Commit envelope digest is invalid': 'envelope-digest',
  'Commit envelope bytes are not canonical': 'envelope-canonical',
  'Commit envelope contains unknown or missing fields': 'envelope-keys',
  'Logical record must be an object': 'record-object',
  'Logical record stream must be a string': 'record-stream',
});
