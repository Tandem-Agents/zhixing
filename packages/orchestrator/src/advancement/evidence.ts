import {
  extractText,
  finalAssistantMessageOf,
  type Message,
  type RunRecordInput,
} from "@zhixing/core";
import type {
  EvidenceRequirementSpec,
  ObjectiveSignalKind,
  ReviewEvidence,
} from "@zhixing/core/advancement";
import type {
  AdvancementEvidenceCollectionInput,
  AdvancementEvidenceProvider,
} from "./types.js";

const OBJECTIVE_EVIDENCE_KINDS = new Set<ObjectiveSignalKind>([
  "file-diff",
  "test-result",
  "build-result",
  "log",
  "artifact",
]);

export function requiresIndependentEvidence(kind: ObjectiveSignalKind): boolean {
  return OBJECTIVE_EVIDENCE_KINDS.has(kind);
}

export function createDefaultAdvancementEvidenceProvider(): AdvancementEvidenceProvider {
  return new DefaultAdvancementEvidenceProvider();
}

export function completeMissingRequiredEvidence(input: {
  readonly requirements: readonly EvidenceRequirementSpec[];
  readonly evidence: readonly ReviewEvidence[];
}): ReviewEvidence[] {
  const evidence = [...dedupeEvidence(input.evidence)];
  const requirementsById = new Map(
    input.requirements.map((requirement) => [requirement.id, requirement]),
  );
  const coveredRequired = new Set(
    evidence
      .filter((item) => {
        if (!item.requirementId) return false;
        const requirement = requirementsById.get(item.requirementId);
        return (
          requirement !== undefined &&
          item.kind === requirement.kind &&
          item.source === "independent" &&
          item.passed === true
        );
      })
      .map((item) => item.requirementId),
  );

  for (const requirement of input.requirements) {
    if (requirement.required !== true) continue;
    if (!requiresIndependentEvidence(requirement.kind)) continue;
    if (coveredRequired.has(requirement.id)) continue;

    evidence.push({
      id: `missing-required-${requirement.id}`,
      kind: requirement.kind,
      requirementId: requirement.id,
      summary: `未取得可独立核验的客观证据：${requirement.description}`,
      passed: false,
    });
  }

  return evidence;
}

export function summarizeRunRecord(runRecord: RunRecordInput): string {
  const parts: string[] = [];
  const finalText = extractText(finalAssistantMessageOf(runRecord.messages));
  if (finalText.trim()) {
    parts.push(`最终回复：${truncate(finalText.trim(), 1200)}`);
  }

  const toolSummaries = summarizeToolResults(runRecord.messages);
  if (toolSummaries.length > 0) {
    parts.push(`工具结果：\n${toolSummaries.join("\n")}`);
  }

  return parts.join("\n\n") || "本轮没有可提取的执行结果。";
}

class DefaultAdvancementEvidenceProvider implements AdvancementEvidenceProvider {
  async collect(
    input: AdvancementEvidenceCollectionInput,
  ): Promise<readonly ReviewEvidence[]> {
    const finalText = extractText(finalAssistantMessageOf(input.runRecord.messages)).trim();
    const evidence: ReviewEvidence[] = [];

    if (finalText) {
      evidence.push({
        id: "run-final-response",
        kind: "conversation-fact",
        summary: `执行侧最终回复：${truncate(finalText, 800)}`,
        source: "execution-report",
      });
    }

    for (const requirement of input.requirements ?? []) {
      if (requiresIndependentEvidence(requirement.kind)) continue;
      evidence.push({
        id: `conversation-requirement-${requirement.id}`,
        kind: requirement.kind,
        requirementId: requirement.id,
        summary: `该要求需要按对话事实审查：${requirement.description}`,
        source: "execution-report",
      });
    }

    return evidence;
  }
}

function summarizeToolResults(messages: readonly Message[]): string[] {
  const out: string[] = [];
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== "tool_result") continue;
      const status = block.isError ? "失败" : "完成";
      out.push(`- ${block.toolUseId} (${status})：${truncate(block.content, 500)}`);
    }
  }
  return out;
}

function dedupeEvidence(evidence: readonly ReviewEvidence[]): ReviewEvidence[] {
  const seen = new Set<string>();
  const out: ReviewEvidence[] = [];
  for (const item of evidence) {
    if (!item.id || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...`;
}
