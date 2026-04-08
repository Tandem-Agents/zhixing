/**
 * 知行 CLI 入口
 *
 * 两种运行模式：
 * - 单次模式：zhixing -p "prompt" → 流式输出 → 退出
 * - 交互模式：zhixing → REPL 多轮对话
 *
 * 配置加载顺序（由 @zhixing/providers 处理）：
 * - 环境变量 → 项目 zhixing.config.json → 全局 ~/.zhixing/config.json
 */

import { Command } from "commander";
import { runOnce } from "./run-agent.js";
import { startRepl } from "./repl.js";
import { createRenderer, renderSummary, renderError } from "./render.js";

const program = new Command();

program
  .name("zhixing")
  .description("知行 — 智能体引擎")
  .version("0.1.0")
  .option("-p, --print <prompt>", "单次模式：执行 prompt 后退出")
  .option("-m, --model <model>", "指定模型")
  .option("--provider <provider>", "指定 Provider ID")
  .action(async (options: {
    print?: string;
    model?: string;
    provider?: string;
  }) => {
    try {
      if (options.print) {
        const renderer = createRenderer();
        renderer.startThinking();

        const { agentResult, durationMs } = await runOnce({
          prompt: options.print,
          model: options.model,
          provider: options.provider,
          onYield: (e) => renderer.handleEvent(e),
        });

        renderer.stop();
        renderSummary(agentResult, durationMs);
        process.exit(0);
      }

      await startRepl({
        model: options.model,
        provider: options.provider,
      });
    } catch (err) {
      renderError(err);
      process.exit(1);
    }
  });

// pnpm run 会将 `--` 原样传递给脚本，导致 Commander 将后续选项误认为位置参数。
// 移除 argv 中首个独立的 `--`，使 `-p` 等选项正常解析。
const argv = [...process.argv];
const dashIdx = argv.indexOf("--", 2);
if (dashIdx !== -1) {
  argv.splice(dashIdx, 1);
}

program.parseAsync(argv).catch((err: unknown) => {
  renderError(err);
  process.exit(1);
});
