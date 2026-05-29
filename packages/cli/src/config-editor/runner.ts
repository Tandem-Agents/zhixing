/**
 * 编辑器主循环：panel stack + KeyEvent → Action 派发。
 *
 * 状态层次：
 *   - WorkingState：业务数据（config / credentials / inputBuffer），事务性提交
 *   - PanelStack：面板导航栈，元素是 PanelDescriptor + 该面板的光标
 *   - 每次 KeyEvent → 当前 panel 的 handler 处理 → 应用 action 到 stack / state
 *
 * Action 处理：
 *   - stay：仅 state 更新，重渲染当前 panel
 *   - navigate：push 新 panel，初始光标 0
 *   - pop：弹出当前 panel，回上一级；空栈时退出
 *   - exit：直接结束循环，返回 result（completed / cancelled）
 */

import type {
  ConfigEditorContext,
  ConfigEditorResult,
  PanelAction,
  PanelDescriptor,
  WorkingState,
} from "./types.js";
import {
  Renderer,
  createKeyEventStream,
  type KeyEvent,
  type KeyEventStream,
} from "../tui/index.js";
import { createInitialState } from "./state.js";
import {
  handleMainPanelKey,
  initialMainCursor,
  renderMainPanel,
  type MainPanelCursor,
} from "./panels/main.js";
import {
  handleListPanelKey,
  renderListPanel,
} from "./panels/list.js";
import {
  handleEntityPanelKey,
  renderEntityPanel,
} from "./panels/entity.js";
import {
  handleAddModelPanelKey,
  handleInputPanelKey,
  handleThinkingBudgetPanelKey,
  renderAddModelPanel,
  renderInputPanel,
  renderThinkingBudgetPanel,
} from "./panels/input.js";
import {
  handleMcpAddInputPanelKey,
  handleMcpAddPanelKey,
  handleMcpChoicesPanelKey,
  handleMcpServerPanelKey,
  renderMcpAddInputPanel,
  renderMcpAddPanel,
  renderMcpChoicesPanel,
  renderMcpServerPanel,
} from "./panels/mcp.js";
import { runLoadingAction, renderLoadingFrame } from "./loading.js";

interface PanelFrame {
  descriptor: PanelDescriptor;
  cursor: { index: number };
  /** 当前面板的错误消息——entity 面板按钮校验失败时设置，下次 render 显示 */
  errorMessage?: string;
}

interface MainFrame {
  cursor: MainPanelCursor;
  /** 当前 main 面板的错误消息——校验失败时显示 */
  errorMessage?: string;
}

export async function runEventLoop(
  ctx: ConfigEditorContext,
): Promise<ConfigEditorResult> {
  if (!ctx.isTTY) {
    return { kind: "non-tty" };
  }

  const renderer = new Renderer(ctx.stdout);
  const stream: KeyEventStream = createKeyEventStream(ctx.stdin);

  let state: WorkingState = createInitialState(ctx.initialConfig, ctx.initialCredentials);
  let main: MainFrame = { cursor: initialMainCursor() };
  const stack: PanelFrame[] = [];

  // 三层退出防御：finally（正常 / throw）+ process.exit 兜底（process.exit 调用 / 异常未捕获），
  // 防止 alternate screen buffer 切了但没切回导致用户终端"坏掉"。
  // SIGKILL / OOM 不在覆盖范围（任何方案都救不回）。
  const onProcessExit = (): void => {
    ctx.stdout.write("\x1b[?1049l\x1b[?25h");
  };
  process.once("exit", onProcessExit);

  stream.start();
  renderer.enterAlternateScreen();
  renderer.hideCursor();
  renderer.flush();

  try {
    while (true) {
      if (stack.length === 0) {
        renderMainPanel(ctx, state, main.cursor, renderer, main.errorMessage);
      } else {
        const top = stack[stack.length - 1]!;
        renderTopPanel(ctx, state, top, renderer);
      }
      // 每帧渲染完一次性 write 到 stdout——双缓冲减少分段闪烁
      renderer.flush();

      const key = await stream.next();
      let action = dispatchKey(ctx, state, main, stack, key);

      // loading：执行异步任务（带取消），用其结果继续；支持多阶段链式 loading。
      while (action.type === "loading") {
        action = await runLoadingAction(action, stream, (message) => {
          renderLoadingFrame(renderer, message);
          renderer.flush();
        });
      }

      if (action.type === "exit") {
        return action.result;
      }

      if (
        action.type === "stay" ||
        action.type === "navigate" ||
        action.type === "pop" ||
        action.type === "replace"
      ) {
        state = action.state;
      }

      if (action.type === "navigate") {
        stack.push({ descriptor: action.panel, cursor: { index: 0 } });
        main.errorMessage = undefined;
      } else if (action.type === "pop") {
        stack.pop();
      } else if (action.type === "replace") {
        // 替换栈顶面板（不改变栈深）；空栈时无栈顶可替换，忽略。
        if (stack.length > 0) {
          stack[stack.length - 1] = {
            descriptor: action.panel,
            cursor: { index: 0 },
          };
        }
      }
    }
  } finally {
    stream.stop();
    renderer.showCursor();
    renderer.exitAlternateScreen();
    renderer.flush();
    process.off("exit", onProcessExit);
  }
}

function renderTopPanel(
  ctx: ConfigEditorContext,
  state: WorkingState,
  frame: PanelFrame,
  renderer: Renderer,
): void {
  const d = frame.descriptor;
  switch (d.kind) {
    case "main":
      // main 不在 stack 中
      return;
    case "provider-list":
    case "model-list":
    case "thinking-config":
      renderListPanel(state, d, frame.cursor, renderer);
      return;
    case "provider-config":
    case "channel-config":
      renderEntityPanel(state, d, frame.cursor, renderer, frame.errorMessage);
      return;
    case "mcp-server":
      renderMcpServerPanel(state, d, frame.cursor, renderer, ctx.runtime);
      return;
    case "mcp-add":
      renderMcpAddPanel(state, d, renderer);
      return;
    case "mcp-add-input":
      renderMcpAddInputPanel(state, d, renderer);
      return;
    case "mcp-choices":
      renderMcpChoicesPanel(state, d, renderer);
      return;
    case "input":
      renderInputPanel(state, d, renderer);
      return;
    case "add-model":
      renderAddModelPanel(state, d, renderer);
      return;
    case "thinking-budget":
      renderThinkingBudgetPanel(state, d, renderer);
      return;
  }
}

function dispatchKey(
  ctx: ConfigEditorContext,
  state: WorkingState,
  main: MainFrame,
  stack: PanelFrame[],
  key: KeyEvent,
): PanelAction {
  // 栈空——main 面板处理
  if (stack.length === 0) {
    const result = handleMainPanelKey(ctx, state, main.cursor, key);
    main.cursor = result.cursor;
    main.errorMessage = result.errorMessage;
    return result.action;
  }

  const top = stack[stack.length - 1]!;
  const d = top.descriptor;

  switch (d.kind) {
    case "provider-list":
    case "model-list":
    case "thinking-config": {
      const result = handleListPanelKey(state, d, top.cursor, key);
      top.cursor = result.cursor;
      return result.action;
    }
    case "provider-config":
    case "channel-config": {
      const result = handleEntityPanelKey(state, d, top.cursor, key);
      top.cursor = result.cursor;
      top.errorMessage = result.errorMessage;
      return result.action;
    }
    case "mcp-server": {
      const result = handleMcpServerPanelKey(state, d, top.cursor, key);
      top.cursor = result.cursor;
      return result.action;
    }
    case "mcp-add":
      return handleMcpAddPanelKey(ctx, state, d, key);
    case "mcp-add-input":
      return handleMcpAddInputPanelKey(ctx, state, d, key);
    case "mcp-choices":
      return handleMcpChoicesPanelKey(ctx, state, d, key);
    case "input":
      return handleInputPanelKey(state, d, key);
    case "add-model":
      return handleAddModelPanelKey(state, d, key);
    case "thinking-budget":
      return handleThinkingBudgetPanelKey(state, d, key);
    default:
      return { type: "stay", state };
  }
}
