import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { PathGuard, type Message } from "@zhixing/core";
import type {
  EvidenceCapabilitySet,
  EvidenceRequirementSpec,
  ObjectiveSignalKind,
  ReviewEvidence,
} from "@zhixing/core/advancement";
import type {
  AdvancementEvidenceCollectionInput,
  AdvancementEvidenceProvider,
} from "./types.js";
import { summarizeRunRecord } from "./evidence.js";

/**
 * 第一级独立取证：文件系统与 git 工作区的纯只读核验。
 *
 * 「独立」指读取独立——推进侧亲自读产物，不经执行侧自述；它证明「产物存在
 * 且记述了什么」，不证明「事情真实发生过」（来源独立要未来的验证性执行层）。
 * 取证是确定性预取：按契约的证据要求逐条读取，失败与越界一律按「该项证据
 * 缺失」处理——缺失自有裁判层的判定上限规则兜底，不抛权限确认、不让取证
 * 变成确认风暴。
 *
 * 能力边界：
 * - file-diff：git 工作区变更只读读取（在「执行侧不自主 commit」的产品纪律
 *   下即任务变更的良好近似）；非 git 工作区时该 kind 不进能力集。
 * - log / artifact：按契约 locator.paths 定位读取，路径经 realpath 归一 +
 *   工作区边界校验（symlink 不可逃逸），越界按缺失处理。
 * - test-result / build-result：独立核验需要重跑（验证性执行），不在第一级
 *   能力集内——照默认行为跳过，等执行侧自述与裁判保守判定兜底。
 */

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 5_000;
const MAX_FILE_EXCERPT_CHARS = 1_200;
const MAX_DIFF_SUMMARY_CHARS = 1_600;

export type GitExecFn = (
  args: readonly string[],
  cwd: string,
) => Promise<{ stdout: string }>;

const defaultGitExec: GitExecFn = async (args, cwd) =>
  await execFileAsync("git", [...args], {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  });

/**
 * 运行时探测取证能力集——能力集是系统事实：git 可用且 workspace 是仓库时
 * file-diff 在集内；log / artifact 的文件系统读取恒可用。探测结果传入草案
 * 生成策略，required 落点约束由此生效。
 */
export async function detectEvidenceCapabilities(
  workspace: string,
  exec: GitExecFn = defaultGitExec,
): Promise<EvidenceCapabilitySet> {
  const kinds: ObjectiveSignalKind[] = ["log", "artifact"];
  try {
    const { stdout } = await exec(
      ["rev-parse", "--is-inside-work-tree"],
      workspace,
    );
    if (stdout.trim() === "true") kinds.unshift("file-diff");
  } catch {
    // git 不可用或非仓库——file-diff 不进能力集
  }
  return { independentKinds: kinds };
}

export interface FirstPartyEvidenceProviderOptions {
  /** 取证根——locator 路径的解析基准与不可逃逸边界。 */
  readonly workspace: string;
  readonly gitExec?: GitExecFn;
}

export function createFirstPartyEvidenceProvider(
  options: FirstPartyEvidenceProviderOptions,
): AdvancementEvidenceProvider {
  return new FirstPartyEvidenceProvider(options);
}

class FirstPartyEvidenceProvider implements AdvancementEvidenceProvider {
  private readonly workspace: string;
  private readonly gitExec: GitExecFn;

  constructor(options: FirstPartyEvidenceProviderOptions) {
    this.workspace = options.workspace;
    this.gitExec = options.gitExec ?? defaultGitExec;
  }

  async collect(
    input: AdvancementEvidenceCollectionInput,
  ): Promise<readonly ReviewEvidence[]> {
    const evidence: ReviewEvidence[] = [];

    const finalSummary = summarizeRunRecord(input.runRecord);
    if (finalSummary.trim()) {
      evidence.push({
        id: "run-final-response",
        kind: "conversation-fact",
        summary: `执行侧本轮产出：${truncate(finalSummary, MAX_FILE_EXCERPT_CHARS)}`,
        source: "execution-report",
      });
    }

    for (const requirement of input.requirements ?? []) {
      const collected = await this.collectForRequirement(requirement, input);
      evidence.push(...collected);
    }
    return evidence;
  }

  private async collectForRequirement(
    requirement: EvidenceRequirementSpec,
    input: AdvancementEvidenceCollectionInput,
  ): Promise<ReviewEvidence[]> {
    switch (requirement.kind) {
      case "file-diff":
        return await this.collectWorkspaceDiff(requirement, input);
      case "log":
      case "artifact":
        return await this.collectLocatedFiles(requirement);
      case "conversation-fact":
      case "none":
        return [
          {
            id: `conversation-requirement-${requirement.id}`,
            kind: requirement.kind,
            requirementId: requirement.id,
            summary: `该要求需要按对话事实审查：${requirement.description}`,
            source: "execution-report",
          },
        ];
      default:
        // test-result / build-result：第一级无独立核验能力，留给裁判按
        // 执行侧自述保守判定（判定上限规则不允许据此判 met）
        return [];
    }
  }

  private async collectWorkspaceDiff(
    requirement: EvidenceRequirementSpec,
    input: AdvancementEvidenceCollectionInput,
  ): Promise<ReviewEvidence[]> {
    // 定位语义三分：显式 locator 全部越界 = 证据缺失（不得静默降级为全量，
    // 否则 required 硬门槛会被工作区里任何无关变更打开）；无 locator 时以
    // 执行侧本轮工具调用触碰的路径收窄；两者皆无才落全工作区变更。
    const declared = requirement.locator?.paths;
    let scopedPaths: string[];
    let scopeLabel: string;
    if (declared?.length) {
      scopedPaths = this.resolveLocatorWithinWorkspace(declared);
      if (scopedPaths.length === 0) return [];
      scopeLabel = "定位路径范围内";
    } else {
      scopedPaths = this.resolveLocatorWithinWorkspace(
        extractTouchedPaths(input.runRecord.messages),
      );
      scopeLabel = scopedPaths.length > 0 ? "执行侧本轮写入路径范围内" : "工作区";
    }
    const pathArgs = scopedPaths.length > 0 ? ["--", ...scopedPaths] : [];

    // status 是变更事实的必需来源；diff --stat 只是摘要增强——unborn HEAD
    //（新 init 仓库无任何 commit）等场景 diff 会失败，不得连累 status。
    let statusLines: string[];
    try {
      const status = await this.gitExec(
        ["status", "--porcelain", ...pathArgs],
        this.workspace,
      );
      // porcelain 每行是「XY<空格>路径」——逐行切前缀，不得整体 trim（会吃掉首行状态位）
      statusLines = status.stdout
        .split("\n")
        .filter((line) => line.trim().length > 0);
    } catch {
      // git 不可用——证据缺失，交由裁判层的判定上限规则兜底
      return [];
    }
    let statText = "";
    try {
      const stat = await this.gitExec(
        ["diff", "--stat", "HEAD", ...pathArgs],
        this.workspace,
      );
      statText = stat.stdout.trim();
    } catch {
      // 无 HEAD 基线时退化为 status 行摘要
    }

    const changedFiles = statusLines.map((line) => line.slice(3).trim());
    return [
      {
        id: `workspace-diff-${requirement.id}`,
        kind: "file-diff",
        requirementId: requirement.id,
        summary:
          changedFiles.length > 0
            ? `${scopeLabel}存在未提交变更（${changedFiles.length} 个文件）：\n${truncate(
                statText || changedFiles.join("\n"),
                MAX_DIFF_SUMMARY_CHARS,
              )}`
            : `${scopeLabel}没有未提交变更。`,
        source: "independent",
        passed: changedFiles.length > 0,
        refs: changedFiles.slice(0, 20),
      },
    ];
  }

  private async collectLocatedFiles(
    requirement: EvidenceRequirementSpec,
  ): Promise<ReviewEvidence[]> {
    const located = this.resolveLocatorWithinWorkspace(requirement.locator?.paths);
    const out: ReviewEvidence[] = [];
    for (const relative of located) {
      const absolute = PathGuard.resolve(relative, this.workspace);
      try {
        const info = await fs.stat(absolute);
        if (!info.isFile()) continue;
        const excerpt =
          requirement.kind === "log"
            ? await readFileTail(absolute, info.size, MAX_FILE_EXCERPT_CHARS)
            : "";
        out.push({
          id: `located-${requirement.kind}-${requirement.id}-${out.length + 1}`,
          kind: requirement.kind,
          requirementId: requirement.id,
          summary: excerpt
            ? `文件 ${relative} 存在（${info.size} 字节），尾部内容：\n${excerpt}`
            : `文件 ${relative} 存在（${info.size} 字节）。`,
          source: "independent",
          passed: true,
          refs: [relative],
        });
      } catch {
        // 文件不存在 / 不可读——该路径证据缺失
      }
    }
    return out;
  }

  /** locator 路径过滤：realpath 归一 + 工作区边界校验，越界路径按证据缺失丢弃。 */
  private resolveLocatorWithinWorkspace(
    paths: readonly string[] | undefined,
  ): string[] {
    if (!paths?.length) return [];
    return paths.filter((p) =>
      PathGuard.isWithinWorkspace(p, this.workspace, this.workspace),
    );
  }
}

/**
 * 执行侧本轮写类工具触碰的路径投影——file-diff 无显式 locator 时的收窄兜底。
 * 只认写类工具：Read / Glob / Grep 的路径是读与搜索目标、不代表变更位置，
 * 混入会把 scope 错误收窄到没有变更的路径上（产出虚假的"无变更"独立证据）；
 * 经 Bash 等无路径字段的方式写文件时投影为空，正确退化为全工作区变更。
 */
const WRITE_TOOL_NAMES = new Set(["write", "edit"]);

function extractTouchedPaths(messages: readonly Message[]): string[] {
  const PATH_FIELDS = ["file_path", "path", "filePath", "notebook_path"];
  const out = new Set<string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== "tool_use") continue;
      if (!WRITE_TOOL_NAMES.has(block.name.toLowerCase())) continue;
      const inputRecord = block.input as Record<string, unknown> | undefined;
      if (!inputRecord || typeof inputRecord !== "object") continue;
      for (const field of PATH_FIELDS) {
        const value = inputRecord[field];
        if (typeof value === "string" && value.trim()) out.add(value.trim());
      }
    }
  }
  return [...out];
}

/** 只读文件尾部窗口——大文件不整读进内存（取证目标只是尾部摘录）。 */
async function readFileTail(
  absolute: string,
  fileSize: number,
  maxChars: number,
): Promise<string> {
  const maxBytes = maxChars * 4;
  const readLength = Math.min(fileSize, maxBytes);
  if (readLength <= 0) return "";
  const handle = await fs.open(absolute, "r");
  try {
    const buffer = Buffer.alloc(readLength);
    // 按实际读到的字节切片——stat 与 read 之间文件可能被轮转截断，
    // 直接 toString 会把未写满的 NUL 字节混进摘录
    const { bytesRead } = await handle.read(
      buffer,
      0,
      readLength,
      Math.max(0, fileSize - readLength),
    );
    const text = buffer.subarray(0, bytesRead).toString("utf8").trimEnd();
    if (text.length <= maxChars) return text;
    return `...${text.slice(-maxChars)}`;
  } finally {
    await handle.close();
  }
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...`;
}
