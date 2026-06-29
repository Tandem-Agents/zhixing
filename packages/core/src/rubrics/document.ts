import { parseFrontmatter, stringifyFrontmatter } from "../memory/frontmatter.js";
import { normalizeRubricId, rubricTextToId, rubricTitleToId } from "./id.js";
import {
  RubricProtocolError,
  type RubricDocument,
  type RubricDraft,
  type RubricEvidenceRequirement,
  type RubricFailureHandling,
  type RubricValidationIssue,
} from "./types.js";

type SectionName = "passCriteria" | "evidenceRequirements" | "failureHandling";

interface SectionStart {
  name: SectionName;
  lineIndex: number;
}

const SECTION_ALIASES: Record<SectionName, readonly string[]> = {
  passCriteria: ["通过标准"],
  evidenceRequirements: ["证据要求"],
  failureHandling: ["未通过时的处理"],
};

export function parseRubricDocument(raw: string): RubricDocument {
  const { data, content } = parseFrontmatter(raw);
  const parsedId = readOptionalRubricId(data);
  const title = readString(data, "title");
  const description = readString(data, "description");
  const sections = parseRubricSections(content);

  const document: RubricDocument = {
    title,
    description,
    content: {
      passCriteria: parseListSection(sections.passCriteria),
      evidenceRequirements: parseEvidenceRequirements(
        sections.evidenceRequirements,
      ),
      failureHandling: parseFailureHandling(sections.failureHandling),
    },
    body: content,
    raw,
  };
  if (parsedId.id) document.id = parsedId.id;

  const issues = validateRubricDocument(document);
  if (parsedId.issue) issues.unshift(parsedId.issue);
  if (issues.length > 0) throw new RubricProtocolError(issues);
  return document;
}

export function stringifyRubricDraft(draft: RubricDraft): string {
  const id = normalizeRubricId(draft.id ?? draft.title);
  const passCriteria = renderList(draft.content.passCriteria);
  const evidenceRequirements = draft.content.evidenceRequirements?.length
    ? `\n\n## 证据要求\n\n${renderList(draft.content.evidenceRequirements)}`
    : "";
  const failureHandling = draft.content.failureHandling
    .map(
      (item) =>
        `- 场景：${item.scenario.trim()}\n  回复：${item.reply.trim()}`,
    )
    .join("\n\n");

  const body = [
    "## 通过标准",
    "",
    passCriteria,
    evidenceRequirements,
    "",
    "## 未通过时的处理",
    "",
    failureHandling,
  ]
    .filter((part) => part !== "")
    .join("\n");

  return stringifyFrontmatter(
    {
      id: id || undefined,
      title: draft.title.trim(),
      description: draft.description.trim(),
    },
    body,
  );
}

export function rubricDocumentId(
  document: Pick<RubricDocument, "id" | "title">,
): string {
  return normalizeRubricId(document.id ?? "") || rubricTitleToId(document.title);
}

export function assertValidRubricDocument(document: RubricDocument): void {
  const issues = validateRubricDocument(document);
  if (issues.length > 0) {
    throw new RubricProtocolError(issues);
  }
}

export function validateRubricDocument(
  document: RubricDocument,
): RubricValidationIssue[] {
  const issues: RubricValidationIssue[] = [];
  if (document.id !== undefined && !normalizeRubricId(document.id)) {
    issues.push({ field: "id", message: "Rubric id 无效" });
  }
  if (!document.title.trim()) {
    issues.push({ field: "title", message: "Rubric 缺少 title" });
  }
  if (!document.description.trim()) {
    issues.push({ field: "description", message: "Rubric 缺少 description" });
  }
  if (document.content.passCriteria.length === 0) {
    issues.push({
      field: "content.passCriteria",
      message: "Rubric 缺少通过标准",
    });
  }
  if (document.content.failureHandling.length === 0) {
    issues.push({
      field: "content.failureHandling",
      message: "Rubric 缺少未通过时的处理",
    });
  }
  for (const [index, item] of document.content.failureHandling.entries()) {
    if (!item.reply.trim()) {
      issues.push({
        field: `content.failureHandling.${index}.reply`,
        message: "未通过处理缺少给执行侧的回复内容",
      });
    }
  }
  return issues;
}

function readString(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  return typeof value === "string" ? value.trim() : "";
}

function readOptionalRubricId(data: Record<string, unknown>): {
  id?: string;
  issue?: RubricValidationIssue;
} {
  if (!Object.prototype.hasOwnProperty.call(data, "id")) return {};
  const value = data.id;
  if (typeof value !== "string") {
    return { issue: { field: "id", message: "Rubric id 必须是字符串" } };
  }
  const id = normalizeRubricId(value.trim());
  return id ? { id } : { issue: { field: "id", message: "Rubric id 无效" } };
}

function parseRubricSections(body: string): Partial<Record<SectionName, string>> {
  const lines = body.split(/\r?\n/);
  const starts: SectionStart[] = [];
  for (const [lineIndex, line] of lines.entries()) {
    const name = matchSectionStart(line);
    if (name) starts.push({ name, lineIndex });
  }

  const sections: Partial<Record<SectionName, string>> = {};
  for (const [index, start] of starts.entries()) {
    const next = starts[index + 1]?.lineIndex ?? lines.length;
    const contentLines = lines.slice(start.lineIndex + 1, next);
    sections[start.name] = contentLines.join("\n").trim();
  }
  return sections;
}

function matchSectionStart(line: string): SectionName | null {
  const normalized = line
    .trim()
    .replace(/^#{1,6}\s*/, "")
    .replace(/[：:]\s*$/, "")
    .trim();
  for (const [name, aliases] of Object.entries(SECTION_ALIASES)) {
    if (aliases.includes(normalized)) return name as SectionName;
  }
  return null;
}

function parseListSection(section: string | undefined): string[] {
  const text = section?.trim() ?? "";
  if (!text) return [];
  const items = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
  return items.length > 0 ? items : [text];
}

function parseEvidenceRequirements(
  section: string | undefined,
): RubricEvidenceRequirement[] {
  return parseListSection(section).map((text, index) => ({
    id: rubricTextToId(text, `evidence-${index + 1}`),
    text,
  }));
}

function parseFailureHandling(
  section: string | undefined,
): RubricFailureHandling[] {
  const text = section?.trim() ?? "";
  if (!text) return [];

  const blocks = splitFailureBlocks(text);
  if (blocks.length === 0) {
    const reply = extractReply(text);
    return reply
      ? [
          {
            id: "default",
            scenario: "默认",
            reply,
            body: text,
          },
        ]
      : [];
  }

  return blocks
    .map((block, index): RubricFailureHandling => {
      const scenario = block.scenario.trim();
      return {
        id: rubricTextToId(scenario, `failure-${index + 1}`),
        scenario,
        reply: extractReply(block.body),
        body: block.body.trim(),
      };
    })
    .filter((item) => item.scenario || item.reply);
}

function splitFailureBlocks(
  text: string,
): Array<{ scenario: string; body: string }> {
  const lines = text.split(/\r?\n/);
  const blocks: Array<{ scenario: string; lines: string[] }> = [];

  for (const line of lines) {
    const scenario = matchScenarioLine(line);
    if (scenario !== null) {
      blocks.push({ scenario, lines: [line] });
      continue;
    }
    blocks.at(-1)?.lines.push(line);
  }

  return blocks.map((block) => ({
    scenario: block.scenario,
    body: block.lines.join("\n"),
  }));
}

function matchScenarioLine(line: string): string | null {
  const match = line.trim().match(/^-\s*场景[：:]\s*(.+)$/);
  return match?.[1]?.trim() ?? null;
}

function extractReply(text: string): string {
  const lines = text.split(/\r?\n/);
  const replyLines: string[] = [];
  let inReply = false;

  for (const line of lines) {
    const scenario = matchScenarioLine(line);
    if (inReply && scenario !== null) break;

    const replyMatch = line.trim().match(/^(?:-\s*)?回复[：:]\s*(.*)$/);
    if (replyMatch) {
      inReply = true;
      const firstLine = replyMatch[1]?.trim();
      if (firstLine) replyLines.push(firstLine);
      continue;
    }

    if (inReply) {
      const trimmed = line.trim();
      if (trimmed) replyLines.push(trimmed);
    }
  }

  return replyLines.join("\n").trim();
}

function renderList(items: string[]): string {
  return items.map((item) => `- ${item.trim()}`).join("\n");
}
