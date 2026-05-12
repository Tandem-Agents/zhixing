/**
 * TaskTail —— 屏幕底部任务区控制器。
 *
 * 长生命周期模块：通过 TaskListService.subscribe 感知数据变化，
 * 调用 ScreenController.setStatusTail 投递渲染文本。
 *
 * 生命周期：
 *   - start()：订阅 service + 初次拉 cache 同步显示
 *   - refresh()：显式刷新（conversation 切换 /new / /switch 路径调用）
 *   - dispose()：取消订阅 + 清空屏幕 tail
 *
 * conversation 多路隔离：subscribe handler 内对比事件 conversationId 与
 * 当前活跃 conversationId，仅响应当前对话的变化。
 */

import type { TaskListState } from "@zhixing/core";
import type { TaskListService } from "@zhixing/tools-builtin";
import type { ScreenController } from "../screen/index.js";
import { renderTaskTail } from "./task-tail-render.js";

export interface TaskTailOptions {
  readonly screen: ScreenController;
  readonly service: TaskListService;
  /**
   * 取当前活跃 conversation id —— 应来自 cli REPL state.conversationId
   * （持久化对话场景），不是 task_list 工具的 ALS 路径（仅 turn run 内有效）。
   * 切换对话后由 caller 调 refresh()，subscribe 自身不感知 conversation 切换。
   */
  readonly getConversationId: () => string | null | undefined;
}

export class TaskTail {
  private unsubscribe: (() => void) | null = null;
  private disposed = false;

  constructor(private readonly opts: TaskTailOptions) {}

  start(): void {
    if (this.disposed) throw new Error("TaskTail.start called after dispose");
    if (this.unsubscribe) return; // start 幂等

    this.unsubscribe = this.opts.service.subscribe((event) => {
      if (this.disposed) return;
      if (event.conversationId !== this.opts.getConversationId()) return;
      this.applyState(event.state);
    });

    // 启动时显式拉 cache 同步初值 —— 不依赖未来 emit（service 已 prime 但未触发事件场景）
    this.refresh();
  }

  /**
   * 显式刷新 —— conversation 切换 / 重新装配场景调用。
   * 读 cache 当前状态渲染 tail；conversationId 缺失（ephemeral / 未恢复对话）时隐藏 tail。
   */
  refresh(): void {
    if (this.disposed) return;
    const convId = this.opts.getConversationId();
    if (!convId) {
      this.opts.screen.setStatusTail(null);
      return;
    }
    this.applyState(this.opts.service.getCached(convId));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.opts.screen.setStatusTail(null);
  }

  private applyState(state: TaskListState | null): void {
    const text = renderTaskTail(state);
    this.opts.screen.setStatusTail(text.length > 0 ? text : null);
  }
}
