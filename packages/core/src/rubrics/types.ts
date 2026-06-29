export type RubricSource = "own" | "linked";

export interface RubricEvidenceRequirement {
  id: string;
  text: string;
}

export interface RubricFailureHandling {
  id: string;
  scenario: string;
  reply: string;
  body: string;
}

export interface RubricContent {
  passCriteria: string[];
  evidenceRequirements: RubricEvidenceRequirement[];
  failureHandling: RubricFailureHandling[];
}

export interface RubricDocument {
  id?: string;
  title: string;
  description: string;
  content: RubricContent;
  body: string;
  raw: string;
}

export interface RubricDraft {
  id?: string;
  title: string;
  description: string;
  content: {
    passCriteria: string[];
    evidenceRequirements?: string[];
    failureHandling: Array<{
      scenario: string;
      reply: string;
    }>;
  };
}

export interface RubricState {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface RubricRecord {
  id: string;
  title: string;
  description: string;
  source: RubricSource;
  dir: string;
  createdAt: string;
  updatedAt: string;
}

export interface RubricIndexEntry {
  id: string;
  title: string;
  description: string;
  source: RubricSource;
  createdAt: string;
  updatedAt: string;
}

export interface RubricAsset extends RubricRecord {
  document: RubricDocument;
  file: string;
}

export interface RubricValidationIssue {
  field: string;
  message: string;
}

export class RubricProtocolError extends Error {
  readonly issues: RubricValidationIssue[];

  constructor(issues: RubricValidationIssue[]) {
    super(issues.map((issue) => issue.message).join("; "));
    this.name = "RubricProtocolError";
    this.issues = issues;
  }
}
