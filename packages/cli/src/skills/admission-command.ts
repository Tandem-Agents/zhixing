/**
 * `/skill-add` 命令 —— 外部技能接入的 REPL 层接线:把接入源落暂存 → 静态扫描 + AI 研判 →
 * 分级裁决 → 过审则 `Store.admit` 落 linked → 清暂存。审查管线在 core(`admission.ts`),
 * 本文件只做装配 + 裁决交互。
 *
 * 裁决:`safe` 自动接入;`escalate` 确凿恶意挡死(`--force` 也不越);`needs-confirm` 可疑,
 * 展示威胁 + 研判后收一个确认键(`y` 接入、其它取消),或用户预先带 `--force` 表示"已复核、
 * 接入"。确认读键复用 `createKeyEventStream`(同 /skill-new 的 stdin 接管,不碰 chrome 输入区)。
 *
 * 接入源 v1 为本地路径;URL / 仓库由 `acquireToStaging` 的 `SkillImportSource` 按 kind 增量。
 */

import chalk from "chalk";
import { createKeyEventStream, layout, type KeyEventStream } from "../tui/index.js";
import {
  acquireToStaging,
  assessSkill,
  parseFrontmatter,
  skillNameToId,
  type AdmissionVerdict,
  type ContentThreat,
  type ICommandRegistry,
  type SkillRecord,
} from "@zhixing/core";
import fs from "node:fs/promises";
import path from "node:path";
import type * as readline from "node:readline/promises";
import type { CommandDispatcher } from "../command-dispatcher.js";
import type { CliWriter, ScreenController } from "../screen/index.js";

/** Store 的接入相关子集(接口隔离,便于装配 / 测试)。 */
export interface AdmissionStore {
  prepareStaging(): Promise<string>;
  discardStaging(dir: string): Promise<void>;
  admit(stagingDir: string, opts?: { mode?: "main" | "work" }): Promise<SkillRecord>;
}

export interface SkillAdmissionDeps {
  readonly registry: ICommandRegistry;
  readonly dispatcher: CommandDispatcher;
  readonly rl: readline.Interface;
  readonly renderer: { stop: () => void };
  readonly screen: ScreenController | null;
  readonly writer: CliWriter;
  /** main 档单发 LLM(接入研判,质量敏感)—— 绑 `callText(_, "main")`。 */
  readonly callText: (prompt: string) => Promise<string>;
  readonly skillStore: AdmissionStore;
  readonly refreshCommands: () => void | Promise<void>;
}

/** 解析 `/skill-add` 参数:路径 + 可选 `--force`。路径含空格按单空格重组。 */
export function parseAddArgs(rest: string): { path: string; force: boolean } {
  const tokens = rest.trim().split(/\s+/).filter(Boolean);
  const force = tokens.includes("--force");
  const pathArg = tokens.filter((t) => t !== "--force").join(" ");
  return { path: pathArg, force };
}

/**
 * 据研判 + 是否 `--force` 决定接入处置(纯函数,安全护栏单测点):
 *   - `admit`   直接接入(safe,或 needs-confirm 带 force)
 *   - `reject`  拒绝(escalate 确凿恶意 —— **`--force` 也不越**)
 *   - `confirm` 需用户当场确认(needs-confirm 未带 force)
 */
export function admissionOutcome(
  decision: AdmissionVerdict["decision"],
  force: boolean,
): "admit" | "reject" | "confirm" {
  if (decision === "escalate") return "reject";
  if (decision === "safe") return "admit";
  return force ? "admit" : "confirm"; // needs-confirm
}

export function registerSkillAddCommand(deps: SkillAdmissionDeps): void {
  deps.registry.register({
    id: "skill-add:repl",
    name: "skill-add",
    description: "接入一个外部技能(本地路径)—— 扫描 + AI 研判后入库",
    category: "tools",
    execution: "local",
    tag: "builtin",
  });

  deps.dispatcher.registerHandler("skill-add:repl", async (ctx) => {
    const rest = typeof ctx.args["_rest"] === "string" ? ctx.args["_rest"] : "";
    const { path: srcPath, force } = parseAddArgs(rest);
    const line = (s: string): void => deps.writer.line(`${layout.contentPrefix}${s}`);

    if (!srcPath) {
      line(chalk.dim("用法:/skill-add <本地路径> [--force]"));
      return {};
    }

    deps.renderer.stop();
    deps.rl.pause();
    // 全程接管 stdin(摘 InputController 的 keypress)—— 审查的 LLM 调用耗时数秒,期间不接管
    // 会让按键串入 InputController(累积 / 重入 submit);接管后审查期按键进流队列、确认前 drain。
    const stream = createKeyEventStream(process.stdin);
    stream.start();
    let staging: string | null = null;
    try {
      staging = await deps.skillStore.prepareStaging();
      await acquireToStaging({ kind: "local-path", path: srcPath }, staging);

      const raw = await fs.readFile(path.join(staging, "SKILL.md"), "utf-8");
      const { data } = parseFrontmatter(raw);
      const name = typeof data.name === "string" ? data.name.trim() : "";
      if (!name) {
        line(chalk.red("接入失败:技能缺少 name(SKILL.md frontmatter)"));
        return {};
      }

      line(chalk.dim(`审查接入技能「${name}」中…`));
      const { threats, verdict } = await assessSkill(
        { llm: deps.callText },
        { name, content: raw },
      );
      renderAssessment(line, threats, verdict);

      const approved = await decide(verdict, force, line, stream);
      if (!approved) return {};

      const rec = await deps.skillStore.admit(staging);
      line(
        chalk.green(`✓ 已接入「${rec.name}」,可 /${skillNameToId(rec.name)} 唤醒。`),
      );
      await deps.refreshCommands();
    } catch (err) {
      line(
        chalk.red(`接入失败:${err instanceof Error ? err.message : String(err)}`),
      );
    } finally {
      stream.stop();
      if (staging) await deps.skillStore.discardStaging(staging);
      deps.rl.resume();
      deps.screen?.reassertCursorHidden();
    }
    return {};
  });

  /** 按裁决决定是否接入(可能询问用户)。escalate 始终拒;needs-confirm 看 force / 用户确认。 */
  async function decide(
    verdict: AdmissionVerdict,
    force: boolean,
    line: (s: string) => void,
    stream: KeyEventStream,
  ): Promise<boolean> {
    const outcome = admissionOutcome(verdict.decision, force);
    if (outcome === "reject") {
      line(chalk.red("已拒绝接入:研判为确凿恶意,不接入(--force 也不可越)。"));
      return false;
    }
    if (outcome === "admit") {
      if (verdict.decision === "needs-confirm") {
        line(chalk.yellow("已带 --force,接受可疑信号、继续接入。"));
      }
      return true;
    }
    line(chalk.yellow("研判为可疑 —— 按 y 接入,其它键取消(复核后也可重跑加 --force)。"));
    return confirmKey(stream);
  }

  /** 收一个确认键。先 drain 掉审查等待期累积的按键,再读用户对确认提示的回应,y 即接入。 */
  async function confirmKey(stream: KeyEventStream): Promise<boolean> {
    stream.drain();
    const key = await stream.next();
    return key.type === "char" && key.ch.toLowerCase() === "y";
  }
}

function renderAssessment(
  line: (s: string) => void,
  threats: readonly ContentThreat[],
  verdict: AdmissionVerdict,
): void {
  if (threats.length) {
    line(chalk.yellow("静态扫描信号:"));
    for (const t of threats) {
      line(chalk.dim(`  · ${t.category}/${t.rule}: ${t.excerpt}`));
    }
  }
  line(chalk.dim(`研判:${verdict.decision} —— ${verdict.reason}`));
}
