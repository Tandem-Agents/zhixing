/**
 * CompactMarker → WindowCompact 过渡桥 —— 随 CompactMarker 一起退场。
 *
 * 现阶段窗口重构指令的生产端仍是 transcript 的 CompactMarker（budget /
 * 段切换累积器产物）；本桥把它映射为窗口自己的指令类型，让调用方
 * （REPL / server 会话层）拿到 marker 后直接喂窗口。
 *
 * 这是窗口模块里**唯一**允许依赖 transcript 类型的文件——主模块保持
 * 零 transcript 依赖（窗口是上下文层概念，存储无关），过渡耦合被隔离
 * 在这一个文件里，marker 概念删除时连文件一起删。
 */

import type { CompactMarker } from "../../transcript/types.js";
import type { WindowCompact } from "./types.js";

/** 把 transcript compact marker 映射为窗口重构指令（字段语义一一对应） */
export function windowCompactFromMarker(marker: CompactMarker): WindowCompact {
  return {
    summary: marker.summary,
    structuredSummary: marker.structuredSummary,
    segmentId: marker.segmentId,
    // marker 的 turnsCompacted 数的是"被替代的文件 Turn 数"；窗口配对与
    // 文件 Turn 一一对应，数值语义直接沿用
    pairsCompacted: marker.turnsCompacted,
    tokensBefore: marker.tokensBefore,
    tokensAfter: marker.tokensAfter,
  };
}
