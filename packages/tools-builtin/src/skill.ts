/**
 * load_skill 工具 —— 命中索引后按需加载技能全文(渐进披露的"展开"动作)。
 *
 * 两条触发统一收口到本工具:(1)模型扫到 Available Skills 索引里某个 id 与当前任务
 * 相关 → 主动加载;(2)用户发来一条恰为「斜杠 + 技能 id」的消息(如 `/deploy`,由
 * cli 的 /<name> 唤醒派发为普通 user message)→ 显式调用该技能。手动唤醒不走旁路、
 * 与自动命中同经本工具,故技能全集(含未进 top-N 索引的)都可达。取回技能完整正文
 * (做法 / 约定 / 坑)。固定工具:技能再增删,工具集恒只此一个加载工具。
 *
 * 依赖按接口隔离:只依赖 `SkillTextLoader`(按 id 取全文),不耦合整个 SkillStore,
 * 便于注入与测试。读全文 + 写命中度量属知行应用本地状态,声明 app-state 边界 →
 * 判 internal 自动放行,不每次弹确认;不设 maxResultChars,全文须完整入上下文。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  acquireToStaging,
  computeStagingDigest,
  parseFrontmatter,
  ADMISSION_TOKEN_TTL_MS,
} from "@zhixing/core";
import type {
  AdmissionAssessment,
  ContentThreat,
  SkillDraft,
  SkillMode,
  SkillSaveOutcome,
  SkillTextLoader,
  ToolDefinition,
  ToolResult,
} from "@zhixing/core";

export function createLoadSkillTool(loader: SkillTextLoader): ToolDefinition {
  return {
    name: "load_skill",
    description:
      "Load the full instructions of a skill by its id. The Available Skills index lists skills with a " +
      "one-line description — that description is only a pointer; the loaded full text tells you how to do " +
      "the task (the user's conventions, steps, pitfalls). Two triggers: (1) a listed skill matches the " +
      "current task — load it before proceeding; (2) the user's message is exactly a slash followed by a " +
      "skill id (for example `/deploy`) — they are explicitly invoking that skill, so call this tool with " +
      "that id even if it is not shown in the index. Pass the exact id.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The skill id, exactly as shown in the Available Skills index.",
        },
      },
      required: ["id"],
    },

    isReadOnly: false, // 写命中度量(usage)
    isParallelSafe: true, // per-id 锁护 usage 写
    needsPermission: false,
    // 技能数据 = 知行应用本地状态(~/.zhixing/skills):读全文 + 写 usage、无外部副作用
    // → 经 app-state 边界判 internal(自动放行),不每次加载弹确认。
    boundaries: [{ boundaryType: "app-state", access: "write", dynamic: false }],

    async call(input): Promise<ToolResult> {
      const id = typeof input.id === "string" ? input.id.trim() : "";
      if (!id) {
        return { content: "load_skill 需要非空的 id 参数。", isError: true };
      }
      try {
        const { name, body } = await loader.loadText(id);
        return { content: `# ${name}\n\n${body}`, isError: false };
      } catch (e) {
        return {
          content: `加载技能 "${id}" 失败:${
            e instanceof Error ? e.message : String(e)
          }`,
          isError: true,
        };
      }
    },
  };
}

/**
 * save_skill 对保存管线的最小依赖契约(接口隔离)—— 工具只需"把草稿交给
 * 管线",不耦合 SkillStore 与管线内部;装配期把 runSkillSavePipeline 绑定
 * store 后注入,测试可注入轻量 mock。
 */
export type SkillSaver = (draft: SkillDraft) => Promise<SkillSaveOutcome>;

/**
 * save_skill 工具 —— 创建 / 打磨技能的唯一落盘口(upsert:同名即更新)。
 *
 * 定位 = SkillSavePipeline + 用户确认护栏的工具包装:四不变量(脱敏 / own
 * 落位 / 格式 / 索引版本)焊在管线里;本包装层承载用户路径的系统护栏——
 * **刻意不声明 boundaries**:持久化用户方法资产不该静默放行,无边界声明经
 * 影响分类 fail-to-confirm 走确认管线(与 load_skill 的 app-state 自动放行
 * 形成有意不对称:读放行、写确认)。产品层护栏(保存前必须拿到用户明确
 * 同意)由内置方法「提炼技能」承载,双层互补。
 */
export function createSaveSkillTool(
  saver: SkillSaver,
  defaultMode: SkillMode,
): ToolDefinition {
  return {
    name: "save_skill",
    description:
      "Save a skill (create new, or update when a skill with the same name exists). Call this ONLY after " +
      "the user has explicitly approved the draft you showed them in conversation (e.g. they said 'save it' " +
      "or '就这样'). Never call it silently. The pipeline scrubs credentials, writes the standard SKILL.md " +
      "into the user's own skill area, and refreshes the index. Returns the skill id (usable as /<id>) and " +
      "how many secrets were scrubbed — relay both honestly to the user.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Skill display name; its id (and /<id> command) derives from this.",
        },
        description: {
          type: "string",
          description:
            "One line oriented to WHEN to use the skill (drives future retrieval), not a content summary.",
        },
        body: {
          type: "string",
          description:
            "Skill body in markdown: the user's specific conventions, pitfalls, proven steps — no generic knowledge.",
        },
        mode: {
          type: "string",
          enum: ["main", "work"],
          description:
            "Where the skill belongs: 'work' for workscene-specific, 'main' for general. Defaults to the current scene.",
        },
      },
      required: ["name", "description", "body"],
    },

    isReadOnly: false,
    isParallelSafe: false, // 写技能库结构性状态(index/目录),串行执行
    needsPermission: false, // 确认由影响分类管线承担(无边界声明 → 确认),与此字段正交

    async call(input): Promise<ToolResult> {
      const name = typeof input.name === "string" ? input.name.trim() : "";
      const description =
        typeof input.description === "string" ? input.description.trim() : "";
      const body = typeof input.body === "string" ? input.body.trim() : "";
      if (!name || !description || !body) {
        return {
          content: "save_skill 需要非空的 name / description / body。",
          isError: true,
        };
      }
      const mode: SkillMode = input.mode === "work" || input.mode === "main"
        ? input.mode
        : defaultMode;
      try {
        const result = await saver({ name, description, body, mode });
        const action = result.outcome === "created" ? "新建" : "更新";
        const lines = [
          `已${action}技能「${result.name}」(id: ${result.id})。用户可输入 /${result.id} 唤起它。`,
        ];
        if (result.scrubbedCount > 0) {
          lines.push(
            `对话中有 ${result.scrubbedCount} 处密钥已自动抹掉、不会写进技能 —— 请如实告知用户。`,
          );
        }
        return { content: lines.join("\n"), isError: false };
      } catch (e) {
        return {
          content: `保存技能失败:${e instanceof Error ? e.message : String(e)}`,
          isError: true,
        };
      }
    },
  };
}

/**
 * admit_skill 对 Store 接入面的最小依赖契约(接口隔离)——SkillStore 结构上满足。
 */
export interface SkillAdmissionPort {
  prepareStaging(): Promise<string>;
  discardStaging(dir: string): Promise<void>;
  admit(
    stagingDir: string,
    opts?: { mode?: SkillMode },
  ): Promise<{ id: string; name: string }>;
  sweepStaleStaging(maxAgeMs: number): Promise<number>;
}

/** 独立安全裁判的评估入口(闭包 = assessSkill 绑 admissionLlm,不带对话上下文)。 */
export type SkillAdmissionAssess = (skill: {
  name: string;
  content: string;
}) => Promise<AdmissionAssessment>;

/** needs-confirm 的内存登记 —— token → 已审查 artifact 的绑定。 */
interface PendingAdmission {
  stagingDir: string;
  digest: string;
  threats: readonly ContentThreat[];
  reason: string;
  mode: SkillMode;
  expiresAt: number;
}

/**
 * admit_skill 工具 —— 外部技能接入的对话流入口(二段协议,artifact 绑定)。
 *
 * 安全模型四件套:
 *   - **裁判独立**:审查经注入的 assess 闭包(独立单发 LLM、不带对话上下文)——
 *     外部技能可能含 prompt 注入,主模型读过其内容后自身可能被操纵,裁决不归它。
 *   - **escalate 结构性不可绕**:确凿恶意直接拒、不发 token,确认重调无从指向。
 *   - **artifact 绑定**:needs-confirm 保留暂存并登记 token(暂存目录 + 内容
 *     digest + 裁决 + 过期时刻);确认重调重算 digest 比对——用户确认的必须是
 *     审查过的那一份,落库前内容被改写即拒(TOCTOU 焊死)。
 *   - **路径进安全管线**:顶层 path 参数 + filesystem/read + app-state/write
 *     双边界 + permissionArgumentKey——工具化后授权方是模型,接入源路径必须
 *     被 realpath / 禁区规则看见(嵌套结构会绕过 PathResolveMiddleware)。
 *
 * 暂存清理责任全在本工具(Store.admit 不自清):safe 入库后清;escalate 清;
 * needs-confirm 保留;首调异常清;重调成功 / 失败均清(并清登记)。跨进程孤儿
 * (token 在内存,进程退出后暂存无主)由首调前的 sweepStaleStaging 按 mtime 收走。
 */
export function createAdmitSkillTool(
  store: SkillAdmissionPort,
  assess: SkillAdmissionAssess,
  defaultMode: SkillMode,
): ToolDefinition {
  const pending = new Map<string, PendingAdmission>();

  const dropPending = async (token: string): Promise<void> => {
    const entry = pending.get(token);
    pending.delete(token);
    if (entry) await store.discardStaging(entry.stagingDir).catch(() => {});
  };

  return {
    name: "admit_skill",
    description:
      "Admit an external skill (from a local path) into the skill library after an independent security " +
      "review. First call with `path`: a safe verdict installs it immediately; a malicious verdict rejects " +
      "it (final, never try to bypass); an uncertain verdict returns the reviewer's reason, threat list and " +
      "an admissionToken WITHOUT installing — relay the report to the user verbatim, and only after they " +
      "explicitly approve, call again with that admissionToken to complete the install. Tokens expire.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Local path of the skill to admit (a directory containing SKILL.md, or a single SKILL.md file). Required on the first call.",
        },
        mode: {
          type: "string",
          enum: ["main", "work"],
          description:
            "Where the skill belongs: 'work' for workscene-specific, 'main' for general. Defaults to the current scene.",
        },
        admissionToken: {
          type: "string",
          description:
            "Confirmation token from a previous needs-confirm result. Pass it ONLY after the user explicitly approved admitting that reviewed content.",
        },
      },
      required: [],
    },

    isReadOnly: false,
    isParallelSafe: false, // 写技能库结构性状态,串行执行
    needsPermission: false,
    permissionArgumentKey: "path",
    // 读接入源(用户给的本地路径)+ 写技能库(app-state):双边界让路径经
    // 安全管线 realpath / 禁区规则;复核本身由二段 token 协议承载(见上)。
    boundaries: [
      { boundaryType: "filesystem", access: "read", dynamic: false },
      { boundaryType: "app-state", access: "write", dynamic: false },
    ],

    async call(input): Promise<ToolResult> {
      // 跨进程孤儿暂存清扫:token 在内存,进程重启后无主 candidate 按 mtime 收走;
      // 顺扫内存登记里已过期的项(及其暂存)。
      await store.sweepStaleStaging(ADMISSION_TOKEN_TTL_MS).catch(() => {});
      const now = Date.now();
      for (const [token, entry] of pending) {
        if (entry.expiresAt <= now) await dropPending(token);
      }

      const token =
        typeof input.admissionToken === "string"
          ? input.admissionToken.trim()
          : "";
      if (token) return confirmAdmission(token);

      const srcPath = typeof input.path === "string" ? input.path.trim() : "";
      if (!srcPath) {
        return {
          content:
            "admit_skill 首调需要 path(接入源本地路径);确认重调需要 admissionToken。",
          isError: true,
        };
      }
      const mode: SkillMode =
        input.mode === "work" || input.mode === "main"
          ? input.mode
          : defaultMode;
      return firstCall(srcPath, mode);
    },
  };

  async function firstCall(srcPath: string, mode: SkillMode): Promise<ToolResult> {
    let staging: string | null = null;
    try {
      staging = await store.prepareStaging();
      await acquireToStaging({ kind: "local-path", path: srcPath }, staging);

      const raw = await fs.readFile(path.join(staging, "SKILL.md"), "utf-8");
      const { data } = parseFrontmatter(raw);
      const name = typeof data.name === "string" ? data.name.trim() : "";
      if (!name) {
        await store.discardStaging(staging);
        return {
          content: "接入失败:技能缺少 name(SKILL.md frontmatter)。",
          isError: true,
        };
      }

      const { threats, verdict } = await assess({ name, content: raw });

      if (verdict.decision === "escalate") {
        await store.discardStaging(staging);
        return {
          content:
            `接入被挡死(审查判定确凿恶意),不可绕过。\n裁判理由:${verdict.reason}\n` +
            renderThreats(threats),
          isError: true,
        };
      }

      if (verdict.decision === "safe") {
        const rec = await store.admit(staging, { mode });
        await store.discardStaging(staging);
        return {
          content: `已接入技能「${rec.name}」(id: ${rec.id})。用户可输入 /${rec.id} 唤起它;它在接入区,可在 /skills 里管理。`,
          isError: false,
        };
      }

      // needs-confirm:保留暂存、登记 token——返回报告,等用户明确同意后重调
      const digest = await computeStagingDigest(staging);
      const newToken = randomUUID();
      pending.set(newToken, {
        stagingDir: staging,
        digest,
        threats,
        reason: verdict.reason,
        mode,
        expiresAt: Date.now() + ADMISSION_TOKEN_TTL_MS,
      });
      staging = null; // 所有权移交登记表,本函数不再负责清理
      return {
        content:
          `审查拿不准,需要用户决定(未接入)。请把以下报告原样转述给用户:\n` +
          `裁判理由:${verdict.reason}\n${renderThreats(threats)}\n` +
          `用户明确同意接入后,带 admissionToken 重调本工具完成接入(有时效):${newToken}`,
        isError: false,
      };
    } catch (e) {
      if (staging) await store.discardStaging(staging).catch(() => {});
      return {
        content: `接入失败:${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      };
    }
  }

  async function confirmAdmission(token: string): Promise<ToolResult> {
    const entry = pending.get(token);
    if (!entry || entry.expiresAt <= Date.now()) {
      await dropPending(token);
      return {
        content: "确认已失效(token 不存在或已过期),需要重新审查:请用 path 重新发起接入。",
        isError: true,
      };
    }
    try {
      const digestNow = await computeStagingDigest(entry.stagingDir);
      if (digestNow !== entry.digest) {
        await dropPending(token);
        return {
          content: "接入中止:暂存内容与用户确认时不一致(可能被改写),已丢弃,需要重新审查。",
          isError: true,
        };
      }
      const rec = await store.admit(entry.stagingDir, { mode: entry.mode });
      await dropPending(token);
      return {
        content: `已接入技能「${rec.name}」(id: ${rec.id})。用户可输入 /${rec.id} 唤起它;它在接入区,可在 /skills 里管理。`,
        isError: false,
      };
    } catch (e) {
      await dropPending(token);
      return {
        content: `接入失败:${e instanceof Error ? e.message : String(e)}(已丢弃,需重新审查)`,
        isError: true,
      };
    }
  }

  function renderThreats(threats: readonly ContentThreat[]): string {
    if (threats.length === 0) return "静态扫描信号:(无)";
    return (
      "静态扫描信号:\n" +
      threats.map((t) => `- ${t.category}/${t.rule}: ${t.excerpt}`).join("\n")
    );
  }
}
