/**
 * 首次引导的接口契约。
 *
 * 流程编排（runner）只依赖这些抽象，不感知 readline / stdin / TTY。
 * CLI 端用 ReadlineBootstrapInteraction 实现；未来 TUI / GUI 入口换实现。
 */

import type { MissingField } from "@zhixing/providers";

export interface BootstrapAskRequest {
  /** 当前要询问的缺失字段 */
  field: MissingField;
  /** 字段格式提示，向用户展示输入示例 */
  schemaExample: string;
  /** 是否屏蔽终端回显——含敏感字段时启用 */
  silent: boolean;
}

export type BootstrapAskAnswer =
  | { kind: "value"; value: string }
  | { kind: "cancel" };

/**
 * 引导交互——入口无关的输入输出抽象。
 *
 * 实现方负责：
 *   - 把消息显示给用户（printIntro / printSummary）
 *   - 收集用户输入并区分有效输入与取消信号（askField）
 *   - 释放底层资源（close，幂等）
 *
 * 不负责：判定缺失字段、决定写盘、计算 patch——这些都在 runBootstrap。
 */
export interface BootstrapInteraction {
  printIntro(args: {
    configPath: string;
    credentialsPath: string;
    missing: MissingField[];
  }): Promise<void>;

  askField(request: BootstrapAskRequest): Promise<BootstrapAskAnswer>;

  printSummary(args: {
    written: { config: boolean; credentials: boolean };
    nextStepHint: string;
  }): Promise<void>;

  /** 释放底层资源（关闭 readline 等）。幂等。 */
  close(): Promise<void>;
}

export type BootstrapResult = "completed" | "cancelled";
