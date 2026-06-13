/**
 * REPL typeahead 候选删除编排。
 *
 * Ctrl+D 二次确认后的物理动作都在宿主执行；本模块只做接入面 UI 编排：
 * 工作场景删除、信任规则撤销、对话删除后的当前指针恢复。抽出为独立单元，
 * 让 REPL 主循环保持装配代码，用户可见的删除路径可被单测锁住。
 */

import chalk from "chalk";
import type { SuggestionItem } from "@zhixing/core";
import type { CliWriter } from "../screen/index.js";
import type { ConversationController } from "./conversation-controller.js";
import type { RpcManagementFacade } from "./rpc-management-facade.js";
import type { RpcWorksceneFacade } from "./rpc-workscene-facade.js";

type CleanupTimer = (
  callback: () => void,
  ms: number,
) => { unref?: () => void };

export interface CandidateDeleteControllerDeps {
  readonly controller: Pick<
    ConversationController,
    "current" | "deleteConversation" | "newConversation"
  >;
  readonly workscene: Pick<RpcWorksceneFacade, "delete">;
  readonly management: Pick<RpcManagementFacade, "trustRevoke">;
  readonly writer: Pick<CliWriter, "line">;
  readonly locallyDeletingConversations: Set<string>;
  readonly syncCurrentTaskListView: () => Promise<void>;
  readonly scheduleCleanup?: CleanupTimer;
}

export function createCandidateDeleteHandler(
  deps: CandidateDeleteControllerDeps,
): (item: SuggestionItem) => Promise<void> {
  const schedule =
    deps.scheduleCleanup ??
    ((callback, ms) => setTimeout(callback, ms));

  return async (item) => {
    const meta = item.acceptPayload.metadata;
    const value =
      typeof meta?.argValue === "string" ? meta.argValue : undefined;
    if (!value) return;
    const commandId =
      typeof meta?.commandId === "string" ? meta.commandId : "";

    if (commandId === "work:repl") {
      try {
        await deps.workscene.delete(value);
      } catch (err) {
        deps.writer.line(
          chalk.red(
            `\n  删除工作场景失败: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
      }
      return;
    }

    if (commandId === "trust:repl") {
      try {
        await deps.management.trustRevoke(
          value,
          deps.controller.current.conversationId,
        );
      } catch (err) {
        deps.writer.line(
          chalk.red(
            `\n  撤销信任规则失败: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
      }
      return;
    }

    const wasActive = value === deps.controller.current.conversationId;
    if (wasActive) deps.locallyDeletingConversations.add(value);

    try {
      await deps.controller.deleteConversation(value);
    } catch (err) {
      deps.locallyDeletingConversations.delete(value);
      deps.writer.line(
        chalk.red(
          `\n  删除对话失败: ${err instanceof Error ? err.message : String(err)}\n`,
        ),
      );
      return;
    }

    if (!wasActive) return;

    try {
      await deps.controller.newConversation();
      await deps.syncCurrentTaskListView();
    } catch (err) {
      deps.writer.line(
        chalk.red(
          `\n  新建空对话失败: ${err instanceof Error ? err.message : String(err)}\n`,
        ),
      );
    } finally {
      schedule(
        () => deps.locallyDeletingConversations.delete(value),
        1000,
      ).unref?.();
    }
  };
}
