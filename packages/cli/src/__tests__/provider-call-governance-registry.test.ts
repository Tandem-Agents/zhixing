import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 生产模型调用治理注册表——机械证明每个生产 provider 调用入口要么落在
 * 治理边界内（assignment meter 或 control acquireRoot），要么有显式后置依据。
 * 新增调用入口必须先登记，未登记的消费点直接判失败。
 */

const WORKSPACE_SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

/** 治理落点注册表：入口 × 适配器 × 治理方式 × 终结路径 */
const GOVERNED_CALL_SITES: ReadonlyArray<{
  readonly file: string;
  readonly marker: string;
  readonly governance: string;
}> = [
  {
    file: "cli/src/serve/conversation-protocol-runtime.ts",
    marker: "modelCallResourceMeter: {",
    governance: "assignment 根租约 meter——正常 durable run（reserveUsage/consume，失败先 flush）",
  },
  {
    file: "cli/src/serve/conversation-protocol-runtime.ts",
    marker: "sessionId: `recovered-perspectives:${conversationId}`",
    governance: "assignment meter 经恢复 synthetic runtime 透传（modelCallMetering 共享序列）",
  },
  {
    file: "server/src/perspectives/controller.ts",
    marker: "const meter = options?.modelCallResourceMeter;",
    governance: "assignment meter 经 durable synthetic runtime 透传至 allocation 与编排",
  },
  {
    file: "cli/src/serve/command.ts",
    marker: "governControlTextCall(",
    governance: "control 根治理——llm.complete（interactive/conversation-input）",
  },
  {
    file: "cli/src/serve/access-surfaces.ts",
    marker: "governControlTextCall(",
    governance: "control 根治理——turn 后台维护（scheduler/schedule-trigger）",
  },
  {
    file: "cli/src/serve/advancement-controller.ts",
    marker: "governControlProvider(",
    governance: "control 根治理——advancement 全部外调（rubric 草案/修订、准入、收场、裁判、摘要）经 governed roles 单点接入（advancement/advancement-control）",
  },
];

/** 后置依据表：当前不在治理域内的调用入口，必须写明原因与承载单元 */
const DEFERRED_CALL_SITES: ReadonlyArray<{
  readonly file: string;
  readonly marker: string;
  readonly reason: string;
}> = [
  {
    file: "cli/src/runtime/rpc-management-facade.ts",
    marker: "\"llm.complete\"",
    reason:
      "管理 CLI 进程经 RPC 打到宿主 llm.complete——宿主侧已由 control 治理边界覆盖，客户端无本地 provider 调用",
  },
];

/** 生产 provider 调用的原始入口指纹（callText 族与 meter 装配点）——扫描面 */
const SCAN_ROOTS = ["cli/src", "server/src/perspectives"] as const;
const CALL_PATTERN_ALL =
  /\b(callText|callTextWithUsage|llmComplete|createMainCallLLM|createLightCallLLM|createMainCallLLMWithUsage|createLightCallLLMWithUsage)\s*[(:]|\.provider\.chat\s*\(|\bprovider\.chat\s*\(/gu;

function listSourceFiles(root: string): string[] {
  const absolute = path.join(WORKSPACE_SRC, root);
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name === "__tests__" || name === "node_modules" || name === "dist") continue;
        walk(full);
        continue;
      }
      if (full.endsWith(".ts") && !full.endsWith(".test.ts")) out.push(full);
    }
  };
  walk(absolute);
  return out;
}

describe("provider call governance registry", () => {
  it("keeps every registered governed call site present in source", () => {
    for (const site of GOVERNED_CALL_SITES) {
      const source = readFileSync(path.join(WORKSPACE_SRC, site.file), "utf8");
      expect(source, `${site.file} 缺少治理标记：${site.governance}`).toContain(site.marker);
    }
    for (const site of DEFERRED_CALL_SITES) {
      const source = readFileSync(path.join(WORKSPACE_SRC, site.file), "utf8");
      expect(source, `${site.file} 后置依据失效`).toContain(site.marker);
    }
  });

  it("budgets every production text-call site per file so new bypasses fail closed", () => {
    // 行级计数预算：每个含调用形态的生产文件登记其命中数与治理性质。
    // 文件内新增一个命中（无论是否旁路）都会使本测试失败，迫使登记者
    // 先审视新调用的治理落点——文件级豁免造成的旁路盲区由此封死。
    const callSiteBudget: ReadonlyArray<{
      readonly file: string;
      readonly expected: number;
      readonly nature: string;
    }> = [
      {
        file: "cli/src/serve/advancement-controller.ts",
        expected: 4,
        nature: "governed roles 构造（createMain/LightCallLLM×2、summarize provider.chat、reviewer 经 roles）——全部经 governControlProvider",
      },
      {
        file: "cli/src/serve/command.ts",
        expected: 2,
        nature: "llmComplete 治理接线（governControlTextCall 包 ephemeralRuntime.callText）",
      },
      {
        file: "cli/src/serve/governed-control-llm.ts",
        expected: 3,
        nature: "治理边界定义处（GovernedTextCall 类型与 provider.chat 委托）",
      },
      {
        file: "cli/src/serve/turn-maintenance.ts",
        expected: 4,
        nature: "governCallText 透传签名与钩子（实际调用经 access-surfaces 治理注入）",
      },
      {
        file: "server/src/perspectives/allocation.ts",
        expected: 3,
        nature: "runtime callText 透传（metering 经 PerspectiveAllocationInput 注入）",
      },
      {
        file: "cli/src/runtime/rpc-management-facade.ts",
        expected: 1,
        nature: "RPC 客户端——打到宿主已治理的 llm.complete",
      },
      {
        file: "cli/src/commands/config-commands.ts",
        expected: 2,
        nature: "management facade 透传（经 RPC 到宿主治理边界）",
      },
      {
        file: "cli/src/repl.ts",
        expected: 1,
        nature: "management facade 消费（经 RPC 到宿主治理边界）",
      },
      {
        file: "cli/src/runtime/config-command.ts",
        expected: 2,
        nature: "接入向导类型与注释引用（经宿主 llm.complete）",
      },
    ];
    const budget = new Map(
      callSiteBudget.map((site) => [
        path.normalize(path.join(WORKSPACE_SRC, site.file)),
        site,
      ]),
    );
    const problems: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of listSourceFiles(root)) {
        const normalized = path.normalize(file);
        const source = readFileSync(file, "utf8");
        const matches = source.match(CALL_PATTERN_ALL)?.length ?? 0;
        const entry = budget.get(normalized);
        const relative = path.relative(WORKSPACE_SRC, file);
        if (!entry && matches > 0) {
          problems.push(relative + ' 出现 ' + matches + ' 个未登记调用形态');
        } else if (entry && matches !== entry.expected) {
          problems.push(
            relative + ' 调用形态计数 ' + matches + ' 与登记 ' + entry.expected + ' 不符——新增或删除调用须先过治理审视并同步登记',
          );
        }
      }
    }
    expect(problems, "生产模型调用计数预算失配").toEqual([]);
  });
});
