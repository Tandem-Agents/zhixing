import { FEISHU_DEFAULTS } from "./config.js";

export function toFeishuMarkdown(markdown: string, maxLength?: number): string {
  const limit = maxLength ?? FEISHU_DEFAULTS.maxMessageLength;
  let result = convertTables(markdown);

  if (result.length > limit) {
    result = safeTruncate(result, limit);
  }
  return result;
}

function safeTruncate(text: string, limit: number): string {
  let end = limit - 3;
  if (end > 0 && isHighSurrogate(text.charCodeAt(end - 1))) {
    end--;
  }
  return text.slice(0, end) + "...";
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

const FENCED_CODE_RE = /```[\s\S]*?```/g;
const TABLE_RE = /^(\|.+\|)\n(\|[\s:|-]+\|)\n((?:\|.+\|\n?)+)/gm;

function convertTables(text: string): string {
  const codeBlocks: string[] = [];
  const shielded = text.replace(FENCED_CODE_RE, (match) => {
    codeBlocks.push(match);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  const converted = shielded.replace(
    TABLE_RE,
    (_match, headerRow: string, _separator: string, bodyBlock: string) => {
      const headers = parseCells(headerRow);
      const rows = bodyBlock.trimEnd().split("\n").map(parseCells);
      const lines: string[] = [];

      for (const row of rows) {
        const parts = row.map((cell, i) => {
          const header = headers[i];
          return header ? `**${header}**: ${cell}` : cell;
        });
        lines.push(`- ${parts.join(" | ")}`);
      }
      return lines.join("\n");
    },
  );

  return converted.replace(/\x00CB(\d+)\x00/g, (_, idx) => codeBlocks[Number(idx)]);
}

function parseCells(row: string): string[] {
  return row
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
}
