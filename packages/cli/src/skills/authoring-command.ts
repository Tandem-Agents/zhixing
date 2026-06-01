/**
 * `/skill-new` 命令 —— 创作入口的 REPL 层接线:把"起草引擎 + main 档 LLM + Store 写 +
 * 外部编辑器"组装成 AI 编辑屏要的注入访问器,照 `/config`·`/mcp` 同款开屏(停 spinner +
 * 让出 readline → 跑 alt-screen 编辑屏 → 退屏后恢复 readline + 重申光标不变量)。
 *
 * 一个命令覆盖 spec 的两个创建入口,按对话上下文自适应:有最近对话(做完某事后触发)→ 进屏即
 * 从对话起草;空库冷启动(无对话)→ 空白编辑屏、等用户第一句说意图。可附一句"指向"作首句。
 *
 * 起草引擎、脱敏、编辑屏都是下层件;本文件只做装配 + 注册,不含 LLM / 渲染逻辑。LLM 经
 * `callText("main")` 注入(质量敏感撰写),屏不感知;落盘经 `store.create`(已落地的 own
 * 写 API);外部编辑器用确定性解析 + 无闪 spawn,文件作两路编辑的单一真相源。
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import chalk from "chalk";
import {
  draftSkill,
  reviseSkill,
  skillNameToId,
  stringifyFrontmatter,
  parseFrontmatter,
  extractText,
  type ICommandRegistry,
  type Message,
  type SkillDraft,
  type SkillDraftLlm,
  type SkillMode,
} from "@zhixing/core";
import type * as readline from "node:readline/promises";
import { resolveEditor, openInEditor } from "./editor-resolve.js";
import {
  runSkillEditor,
  type SkillEditorRunDeps,
} from "./editor-screen.js";
import type { SkillEditorDeps } from "./editor-controller.js";
import type { CommandDispatcher } from "../command-dispatcher.js";
import type { CliWriter, ScreenController } from "../screen/index.js";
import { layout } from "../tui/index.js";

/** 拼进起草上下文的最近对话条数上限 —— 够蒸馏出"刚做的事",又不撑爆单发 prompt。 */
const CONTEXT_MESSAGE_LIMIT = 24;

/** 把最近对话转成起草上下文文本(同工作场景纪要的转写口径)。 */
export function buildSkillContext(
  messages: readonly Message[],
  limit = CONTEXT_MESSAGE_LIMIT,
): string {
  return messages
    .slice(-limit)
    .map((m) => {
      const text = extractText(m).trim();
      if (!text) return null;
      const who =
        m.role === "user" ? "用户" : m.role === "assistant" ? "助手" : m.role;
      return `${who}: ${text}`;
    })
    .filter((line): line is string => line !== null)
    .join("\n");
}

/** 草稿 → 外部编辑器临时文件内容。mode 也写进 frontmatter,让用户在外部编辑器里也能改它。 */
export function draftToExternalFile(draft: SkillDraft): string {
  return stringifyFrontmatter(
    { name: draft.name, description: draft.description, mode: draft.mode },
    draft.body,
  );
}

/** 外部编辑器改过的文件 → 草稿。缺失 / 非法字段回落到打开时的 `base`(mtime 比对已确认文件变过)。 */
export function externalFileToDraft(raw: string, base: SkillDraft): SkillDraft {
  const { data, content } = parseFrontmatter(raw);
  const name = typeof data.name === "string" ? data.name.trim() : "";
  return {
    name: name || base.name,
    description:
      typeof data.description === "string" ? data.description : base.description,
    body: content,
    mode: data.mode === "main" || data.mode === "work" ? data.mode : base.mode,
  };
}

/** 在 PATH 上探测命令(which / where);找不到返回 null。 */
function probeOnPath(command: string): string | null {
  try {
    const finder = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(finder, [command], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
    });
    return out.split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? null;
  } catch {
    return null;
  }
}

export interface SkillAuthoringDeps {
  readonly registry: ICommandRegistry;
  readonly dispatcher: CommandDispatcher;
  readonly rl: readline.Interface;
  readonly renderer: { stop: () => void };
  readonly screen: ScreenController | null;
  readonly writer: CliWriter;
  /** main 档单发 LLM(质量敏感撰写)—— 绑 `session.runtime.callText(_, "main")`。 */
  readonly callText: (prompt: string) => Promise<string>;
  /** 从草稿创建 own 技能 —— 绑 `session.skillStore.create`。 */
  readonly createSkill: (draft: SkillDraft) => Promise<unknown>;
  /** 取当前对话消息(闭包动态读 `state.conv.messages`)。 */
  readonly getMessages: () => readonly Message[];
  /** 默认 mode:工作场景 → `work`,否则 `main`(可在屏内由 AI 改)。 */
  readonly getDefaultMode: () => SkillMode;
  /** 变更后刷新 `/<name>` 补全,让新技能即时可唤醒。 */
  readonly refreshCommands: () => void | Promise<void>;
  /** 技能库是否为空 —— 等意图态据此决定是否顶"技能=…"认知解释(新手降门槛、老手不啰嗦)。 */
  readonly isLibraryEmpty: () => Promise<boolean>;
}

/** 组装一次编辑屏运行所需的注入(每次开屏重建,捕获当下对话上下文 / 场景 mode / 库是否为空)。 */
function buildEditorDeps(
  deps: SkillAuthoringDeps,
  initialInstruction: string,
  isLibraryEmpty: boolean,
  onSaved: (draft: SkillDraft) => void,
): SkillEditorRunDeps {
  const llm: SkillDraftLlm = (prompt) => deps.callText(prompt);
  const context = buildSkillContext(deps.getMessages());
  const defaultMode = deps.getDefaultMode();
  const tmpFile = path.join(os.tmpdir(), `zhixing-skill-${process.pid}.md`);
  // 外部编辑两路衔接:记下打开时的草稿,回读时为缺失字段兜底(尤其文件未写全 mode 时)。
  let externalBase: SkillDraft | null = null;

  // 起草 / 改写两个访问器(屏不感知 LLM)。signal 仅供上层放弃等待(callText 不收 signal、
  // 底层不中断),故访问器不透传。draftSkill / reviseSkill 直接产出含元信息的结果。
  const draft: SkillEditorDeps["draft"] = (intent) =>
    draftSkill(llm, {
      context: context || undefined,
      intent: intent || undefined,
      defaultMode,
    });
  const revise: SkillEditorDeps["revise"] = (current, instruction) =>
    reviseSkill(llm, current, instruction);

  const save: SkillEditorDeps["save"] = async (d) => {
    await deps.createSkill(d);
    onSaved(d);
  };

  const openExternal: SkillEditorDeps["openExternal"] = async (current) => {
    // 手写直通车:还没起草(current=null)也能进编辑器,落一个带引导的空骨架。
    const toWrite: SkillDraft = current ?? {
      name: "",
      description: "",
      body: "在这里写正文：你的特定约定、踩过的坑、最优路径。\n",
      mode: defaultMode,
    };
    externalBase = toWrite;
    await fs.writeFile(tmpFile, draftToExternalFile(toWrite), "utf-8");
    const stat = await fs.stat(tmpFile);
    openInEditor(
      tmpFile,
      resolveEditor({
        visual: process.env["VISUAL"],
        editor: process.env["EDITOR"],
        platform: process.platform,
        probe: probeOnPath,
      }),
    );
    return { file: tmpFile, mtime: stat.mtimeMs };
  };

  const rereadExternal: SkillEditorDeps["rereadExternal"] = async (file, since) => {
    const stat = await fs.stat(file).catch(() => null);
    if (!stat || stat.mtimeMs <= since) return null;
    const raw = await fs.readFile(file, "utf-8");
    const base = externalBase ?? { name: "", description: "", body: "", mode: defaultMode };
    return { draft: externalFileToDraft(raw, base), mtime: stat.mtimeMs };
  };

  return {
    draft,
    revise,
    save,
    openExternal,
    rereadExternal,
    autoDraft: context.length > 0 || initialInstruction.length > 0,
    initialInstruction,
    isLibraryEmpty,
    title: "新建技能",
    stdin: process.stdin,
    stdout: process.stdout,
    isTTY: Boolean(process.stdin.isTTY),
  };
}

export function registerSkillNewCommand(deps: SkillAuthoringDeps): void {
  deps.registry.register({
    id: "skill-new:repl",
    name: "skill-new",
    description: "把刚做的事 / 一个想法收成技能(AI 起草,你来策展确认)",
    category: "tools",
    execution: "local",
    tag: "builtin",
  });

  deps.dispatcher.registerHandler("skill-new:repl", async (ctx) => {
    const rest =
      typeof ctx.args["_rest"] === "string" ? ctx.args["_rest"].trim() : "";

    let saved: SkillDraft | null = null;
    deps.renderer.stop();
    deps.rl.pause();
    try {
      const libraryEmpty = await deps.isLibraryEmpty();
      const result = await runSkillEditor(
        buildEditorDeps(deps, rest, libraryEmpty, (draft) => {
          saved = draft;
        }),
      );
      if (result === "non-tty") {
        deps.writer.line(
          chalk.yellow(`${layout.contentPrefix}当前终端非 TTY,无法打开技能编辑屏`),
        );
      }
    } finally {
      deps.rl.resume();
      deps.screen?.reassertCursorHidden();
    }

    if (saved) {
      const draft = saved as SkillDraft;
      const id = skillNameToId(draft.name);
      // 诚实闭环:只承诺 v1 真有的能力 —— 手动唤起 + description 检索命中。**不说**"自动想起它"
      // (那是 v2 技能管家的主动唤醒,v1 做不到,承诺即在兑现的第一刻失信)。
      deps.writer.line(
        chalk.green(`${layout.contentPrefix}✓ 技能「${draft.name}」存好了。`),
      );
      deps.writer.line(
        `${layout.contentPrefix}${chalk.dim("· 回到聊天输入框,打")} ${chalk.cyan(`/${id}`)} ${chalk.dim("就能唤起它")}`,
      );
      deps.writer.line(
        `${layout.contentPrefix}${chalk.dim(`· 下次你聊到「${draft.description}」,我会检索到它`)}`,
      );
      await deps.refreshCommands();
    }
    return {};
  });
}
