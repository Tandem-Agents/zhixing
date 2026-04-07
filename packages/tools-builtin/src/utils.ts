/**
 * 工具通用工具函数
 */

import * as path from "node:path";

/**
 * 将用户输入的路径解析为绝对路径。
 * 相对路径基于 workingDirectory 解析；绝对路径原样返回。
 */
export function resolveToolPath(filePath: string, workingDirectory: string): string {
  if (path.isAbsolute(filePath)) {
    return path.normalize(filePath);
  }
  return path.resolve(workingDirectory, filePath);
}

/**
 * 截断过长的工具结果。
 * 截断后附加提示信息，告知 LLM 有内容被省略。
 */
export function truncateResult(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;

  const truncated = content.slice(0, maxChars);
  const remaining = content.length - maxChars;
  return `${truncated}\n\n[truncated: showing first ${maxChars.toLocaleString()} of ${content.length.toLocaleString()} chars, ${remaining.toLocaleString()} chars omitted]`;
}

/**
 * 为文件内容添加行号。
 * LLM 引用具体行时需要行号作为锚点。
 */
export function addLineNumbers(content: string, startLine = 1): string {
  const lines = content.split("\n");
  const maxLineNum = startLine + lines.length - 1;
  const padWidth = String(maxLineNum).length;

  return lines
    .map((line, i) => {
      const lineNum = String(startLine + i).padStart(padWidth, " ");
      return `${lineNum}|${line}`;
    })
    .join("\n");
}

/**
 * 粗略判断文件内容是否为二进制。
 * 检查前 8KB 中是否包含 null 字节。
 */
export function isBinaryContent(buffer: Buffer): boolean {
  const checkLength = Math.min(buffer.length, 8192);
  for (let i = 0; i < checkLength; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}
