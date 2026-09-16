/**
 * 同一会话的旁观端 turn 表现层。
 *
 * 宿主统一的是会话事实，不是每个接入面的屏幕。当前 CLI 打开某个对话时，
 * 其它接入面发起的 turn 应作为"正在同看这个对话"呈现：补一条远端用户边界，
 * 并在 turn 落定时关闭本端流式渲染，避免尾段被 markdown/thinking 批处理滞留。
 */

import chalk from "chalk";
import type { AgentEventMap, MessageInputIdentity } from "@zhixing/core";
import type { DecorateRunBusFn } from "@zhixing/orchestrator/runtime";
import { ADVANCEMENT_TURN_LABEL } from "../advancement-presentation.js";
import type { CliWriter } from "../screen/index.js";
import { clampLine } from "../tui/line-width.js";
import { layout } from "../tui/style.js";

type RunStartPayload = AgentEventMap["agent:run_start"];

export interface ObservedTurnIdentity {
  conversationId: string;
  turnId?: string;
}

export interface ObservedTurnPresenterOptions {
  writer: Pick<CliWriter, "ensureSegmentBreak" | "line">;
  /**
   * 关闭当前输出流。origin turn 由 send loop 调用；旁观 turn 没有本地 waiter，
   * 必须在 complete 通知到达时由这里收束。
   */
  flushOutput: () => void;
  isLocalTurn: (identity: ObservedTurnIdentity) => boolean;
  width?: () => number;
}

interface ActiveObservedTurn extends ObservedTurnIdentity {
  promptShown: boolean;
  sawOutput: boolean;
  fallbackTimer: ReturnType<typeof setTimeout> | null;
}

export class ObservedTurnPresenter {
  private active: ActiveObservedTurn | null = null;
  private readonly shownInputs = new Set<string>();

  constructor(private readonly opts: ObservedTurnPresenterOptions) {}

  readonly decorateRunBus: DecorateRunBusFn = (ctx) => {
    const identity: ObservedTurnIdentity = {
      conversationId: ctx.conversationId ?? "",
      turnId: ctx.turnContext?.turnId,
    };
    const originChannel = ctx.turnContext?.turnOrigin?.channel;
    const continuation = Boolean(ctx.turnContext?.turnOrigin?.worksceneContinuation);
    const messageIdentity = ctx.turnContext?.turnOrigin?.messageIdentity;
    const unsubs = [
      ctx.bus.on("agent:run_start", (payload) =>
        this.renderPrompt(identity, payload, originChannel, continuation, messageIdentity),
      ),
      ctx.bus.on("agent:input_received", payload => {
        this.onObservedInputs({ ...identity, inputs: payload.inputs });
      }),
      ctx.bus.on("agent:run_end", () => this.scheduleFallbackFlush(identity)),
    ];
    return () => {
      for (const unsub of unsubs) unsub();
    };
  };

  onObservedTurnDelta(identity: ObservedTurnIdentity): void {
    const active = this.ensureActive(identity);
    if (!active) return;
    active.sawOutput = true;
  }

  onObservedInputs(turn: ObservedTurnIdentity & AgentEventMap["agent:input_received"]): void {
    for (const input of turn.inputs) {
      const key = input.identity ? `${turn.conversationId}:${input.identity.id}` : undefined;
      if (key && this.shownInputs.has(key)) continue;
      if (key) {
        this.shownInputs.add(key);
        if (this.shownInputs.size > 2048) this.shownInputs.delete(this.shownInputs.values().next().value!);
      }
      const source = input.identity?.source;
      this.opts.flushOutput();
      this.opts.writer.ensureSegmentBreak();
      this.opts.writer.line(this.promptLine(collapsePrompt(input.text), undefined, source?.kind === "conversation" ? source.conversationId : undefined));
    }
  }

  onObservedTurnComplete(identity: ObservedTurnIdentity): void {
    if (this.isIgnorable(identity)) return;
    this.finish(identity);
  }

  private renderPrompt(
    identity: ObservedTurnIdentity,
    payload: RunStartPayload,
    originChannel: string | undefined,
    continuation = false,
    messageIdentity?: MessageInputIdentity,
  ): void {
    const prompt = continuation ? "原任务续接" : collapsePrompt(payload.prompt);
    if (prompt.length === 0) return;
    const active = this.ensureActive(identity);
    if (!active || active.promptShown) return;

    if (messageIdentity?.source.kind === "conversation") {
      this.onObservedInputs({ ...identity, inputs: [{ text: prompt, identity: messageIdentity }] });
    } else {
      this.opts.flushOutput();
      this.opts.writer.ensureSegmentBreak();
      this.opts.writer.line(continuation ? `${layout.contentPrefix}${chalk.dim(`◇ ${prompt}`)}` : this.promptLine(prompt, originChannel));
    }
    active.promptShown = true;
  }

  private scheduleFallbackFlush(identity: ObservedTurnIdentity): void {
    const active = this.ensureActive(identity);
    if (!active || active.fallbackTimer) return;
    active.fallbackTimer = setTimeout(() => this.finish(identity), 0);
    active.fallbackTimer.unref?.();
  }

  private ensureActive(
    identity: ObservedTurnIdentity,
  ): ActiveObservedTurn | null {
    if (this.isIgnorable(identity)) return null;
    if (this.active && sameTurn(this.active, identity)) {
      return this.active;
    }
    if (this.active) {
      this.finish(this.active);
    }
    this.active = {
      conversationId: identity.conversationId,
      turnId: identity.turnId,
      promptShown: false,
      sawOutput: false,
      fallbackTimer: null,
    };
    return this.active;
  }

  private finish(identity: ObservedTurnIdentity): void {
    const active = this.active;
    if (!active || !sameTurn(active, identity)) return;
    if (active.fallbackTimer) {
      clearTimeout(active.fallbackTimer);
      active.fallbackTimer = null;
    }
    this.active = null;
    if (active.promptShown || active.sawOutput) {
      this.opts.flushOutput();
    }
  }

  private isIgnorable(identity: ObservedTurnIdentity): boolean {
    return (
      identity.conversationId.length === 0 || this.opts.isLocalTurn(identity)
    );
  }

  private promptLine(prompt: string, originChannel: string | undefined, sourceConversationId?: string): string {
    const width = Math.max(
      20,
      this.opts.width?.() ?? process.stdout.columns ?? 80,
    );
    // 来源标记自解释：推进侧代理消息强到明说，零认知用户不得产生
    // 「这是我发的吗」的困惑；其它接入面保持既有旁观措辞。
    const label =
      sourceConversationId ? chalk.dim(`◇ 来自对话 ${sourceConversationId}:`) : originChannel === "advancement"
        ? chalk.dim(`◇ ${ADVANCEMENT_TURN_LABEL}:`)
        : chalk.dim("❯ 来自另一个接入面:");
    return clampLine(`${layout.contentPrefix}${label} ${prompt}`, width);
  }
}

export function createObservedTurnPresenter(
  opts: ObservedTurnPresenterOptions,
): ObservedTurnPresenter {
  return new ObservedTurnPresenter(opts);
}

function sameTurn(
  left: ObservedTurnIdentity,
  right: ObservedTurnIdentity,
): boolean {
  return (
    left.conversationId === right.conversationId && left.turnId === right.turnId
  );
}

function collapsePrompt(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim();
}
