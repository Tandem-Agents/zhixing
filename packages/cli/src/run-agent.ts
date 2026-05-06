/**
 * cli 单次运行便捷入口。
 *
 * createAgentRuntime / AgentRuntime 等核心契约都来自 @zhixing/orchestrator/runtime。
 * 本文件只负责一个 cli-bound 便捷函数 runOnce —— 内部自管 renderer + 渲染装饰
 * 订阅 + 安全事件 UI 通知,保持与 REPL 路径一致的可观测性。
 *
 * 其他 cli 内部消费 createAgentRuntime / AgentRuntime 的位置(REPL / serve)
 * 直接 import 自 @zhixing/orchestrator/runtime,不再过本文件转发。
 */

import { type AgentYield, type RunResult, userMessage } from "@zhixing/core";
import { createAgentRuntime } from "@zhixing/orchestrator/runtime";
import { createRenderSubscribers } from "./render.js";
import { createOutputRenderer } from "./output/index.js";
import {
  renderBlockedMessage,
  renderUserDeniedMessage,
} from "./security/index.js";

/**
 * runOnce 的入参 —— 一次性运行 agent 所需的最小字段集。
 *
 * 与 createAgentRuntime / RunParams 字段刻意不重合:本接口面向"一行命令式调用"
 * 场景(--print 模式 / 单元测试 / 脚本),内部把字段路由到 createAgentRuntime
 * 与 runtime.run() 两个边界。
 *
 * 设计原则:
 *   - UI 概念(spinner 暂停 / 终端清屏)由内部 renderer 自包含,不通过参数外露。
 *     调用方拿到 RunResult 即可,无需关心 EventBus 装饰细节。
 *   - onYield 仍开放:调用方若要做事件级埋点 / 测试观察可订阅,但不影响内部
 *     renderer 自动驱动的 spinner / 文本 / 工具卡片渲染。
 */
export interface RunOnceOptions {
  prompt: string;
  model?: string;
  provider?: string;
  workspace?: string;
  onYield?: (event: AgentYield) => void;
}

export async function runOnce(options: RunOnceOptions): Promise<RunResult> {
  // 内部独立 renderer:不与 REPL 共享,生命周期与 runOnce 调用对齐。
  // 启动 spinner —— 用户回车到首个 chunk 之间显示"思考中..."。
  const renderer = createOutputRenderer();
  renderer.startThinking();

  try {
    const runtime = await createAgentRuntime({
      model: options.model,
      provider: options.provider,
      workspace: options.workspace,
      decorateRunBus: createRenderSubscribers(renderer),
      onSecurityBlocked: renderBlockedMessage,
      onUserDenied: renderUserDeniedMessage,
      // 单次执行(prompt → 一次完整 run)同样开启 Task,与 REPL 路径行为对齐。
      enableTaskTool: true,
    });
    return await runtime.run({
      messages: [userMessage(options.prompt)],
      turnIndex: 0,
      // onYield 串联:内部 renderer 先吃事件驱动 spinner / 文本 /
      // 工具卡片渲染,再透传给调用方(若有)做埋点 / 观察。
      onYield: (event) => {
        renderer.handleEvent(event);
        options.onYield?.(event);
      },
    });
  } finally {
    // 兜底 stop:正常路径 turn_complete 已停一次 spinner;
    // 异常路径(provider 启动失败 / runtime.run throw)在此关闭定时器,
    // 防止进程退出前 spinner 仍在 stdout 刷字符。
    renderer.stop();
  }
}
