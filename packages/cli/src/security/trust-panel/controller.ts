/**
 * /trust 面板控制器 —— 副作用层。
 *
 * 职责：
 * - 进出 raw mode + stdin 独占（复用 `tui/_internal/stdin-ownership` 共享工具，
 *   不依赖 config-editor / typeahead 模块）。
 * - inline 重绘：记录上次写出的行数 `lastRenderedLineCount`，重绘前 ANSI 上移 +
 *   清屏到末尾再重写，避免视觉闪烁但不进 alt-screen。
 * - keypress → mapKey → reduce → effect 调度：revoke 走 store + reload + 回灌
 *   `rules-reloaded`，exit 走 cleanup + resolve。
 *
 * lifecycle：runTrustPanel 返回 Promise，面板关闭时 resolve。caller（handler）
 * 在 await 后恢复 readline / renderer。
 */

import * as readline from "node:readline";
import type { PermissionRule, SecurityPipeline } from "@zhixing/core";
import { acquireStdinOwnership } from "../../tui/_internal/stdin-ownership.js";
import { renderState, type RenderContext } from "./render.js";
import {
  createInitialState,
  reduce,
  type TrustPanelAction,
  type TrustPanelState,
} from "./state.js";
import { mapKey } from "./key-handler.js";

export interface TrustPanelDeps {
  pipeline: SecurityPipeline;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  agentDisplayName: string;
  /** 注入时间源；测试可固定。生产默认 Date.now。 */
  now?: () => number;
}

export async function runTrustPanel(deps: TrustPanelDeps): Promise<void> {
  if (!deps.stdin.isTTY) {
    deps.stdout.write("(/trust 面板需要 TTY 终端)\n");
    return;
  }

  const now = deps.now ?? Date.now;
  const store = deps.pipeline.getPermissionStore();
  const contextId = deps.pipeline.getContextId();

  const loadRules = (): PermissionRule[] =>
    store.list(contextId).filter((r) => r.scope !== "builtin");

  let state: TrustPanelState = reduce(createInitialState(), {
    kind: "init",
    rules: loadRules(),
  }).state;

  // 进入 raw mode + 独占 keypress
  readline.emitKeypressEvents(deps.stdin);
  const ownership = acquireStdinOwnership(deps.stdin);
  const wasRaw = deps.stdin.isRaw;
  deps.stdin.setRawMode(true);
  deps.stdin.resume();

  let lastRenderedLineCount = 0;

  const renderFrame = (): void => {
    if (lastRenderedLineCount > 0) {
      deps.stdout.write(`\x1b[${lastRenderedLineCount}A\x1b[J`);
    }
    // 每帧新建 RenderContext —— now 反映用户视角的当下时间，readonly 字段不复用对象
    const ctx: RenderContext = {
      agentDisplayName: deps.agentDisplayName,
      now: now(),
    };
    const lines = renderState(state, ctx);
    deps.stdout.write(lines.join("\n") + "\n");
    lastRenderedLineCount = lines.length;
  };

  renderFrame();

  return new Promise<void>((resolve) => {
    let exited = false;

    const cleanup = (): void => {
      if (exited) return;
      exited = true;
      deps.stdin.off("keypress", onKeypress);
      deps.stdin.setRawMode(wasRaw);
      ownership.release();
      // 在面板最后多写一空行让 prompt 接续在独立行 —— 避免 readline 与面板内容
      // 共行
      deps.stdout.write("\n");
      resolve();
    };

    const dispatch = (action: TrustPanelAction): void => {
      const result = reduce(state, action);
      state = result.state;
      renderFrame();

      if (result.effect?.kind === "revoke") {
        // revoke 返回值如失败（极少：规则刚被并发删）走 reload 让 UI 反映真实状态
        store.revoke(result.effect.ruleId);
        const reloaded = loadRules();
        state = reduce(state, { kind: "rules-reloaded", rules: reloaded }).state;
        renderFrame();
      }

      if (result.effect?.kind === "exit") {
        cleanup();
      }
    };

    const onKeypress = (_str: string | undefined, key: readline.Key | undefined): void => {
      const action = mapKey(key);
      if (!action) return;
      dispatch(action);
    };

    deps.stdin.on("keypress", onKeypress);
  });
}
