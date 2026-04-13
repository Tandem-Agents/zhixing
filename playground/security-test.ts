import { SecurityPipeline } from "../packages/core/src/security/index.js";
import { EventBus } from "../packages/core/src/events/event-bus.js";
import type { AgentEventMapWithSecurity } from "../packages/core/src/security/index.js";
import * as path from "node:path";

async function main() {
  console.log("🛡️  知行安全系统 Phase 1 自动化边界测试 \n");

  const eventBus = new EventBus<AgentEventMapWithSecurity>();
  
  eventBus.onAny((eventName, payload) => {
    if (eventName.startsWith("security:")) {
      console.log(`   [EventBus] 🔔 ${eventName}`);
      if (eventName === "security:evaluation" || eventName === "security:blocked") {
        const p = payload as any;
        console.log(`      => 决策: ${p.decision || 'block'} | 风险: ${p.riskLevel} | 匹配规则: ${p.matchedRules?.join(', ')}`);
      }
      if (eventName === "security:env_sanitized") {
        console.log(`      => 清理的变量: ${(payload as any).removedVars.join(', ')}`);
      }
      if (eventName === "security:path_resolved") {
        const p = payload as any;
        console.log(`      => 路径解析: ${p.originalPath} -> 工作区内: ${p.withinWorkspace}`);
      }
    }
  });

  const workspacePath = process.cwd();
  const pipeline = new SecurityPipeline({
    workspace: workspacePath,
    sessionType: "interactive",
    eventBus,
  });

  // 注入一条用户自定义规则用于测试
  pipeline.getPolicyEngine().loadRules([
    {
      id: "user-block-docker",
      name: "禁止 Docker",
      description: "测试自定义规则",
      enabled: true,
      match: { type: "command_prefix", prefixes: ["docker"] },
      action: "block",
      bypassImmune: false,
      severity: "high",
      category: "privilege_escalation",
      source: "user",
      message: "Docker 被用户规则明确禁止"
    }
  ]);

  console.log("==================================================");

  const cases = [
    {
      name: "1. 环境劫持防护 (LD_PRELOAD)",
      tool: "bash",
      args: { command: "export LD_PRELOAD=/tmp/evil.so && ls" },
      envSetup: () => { process.env['LD_PRELOAD'] = '/tmp/evil.so'; },
      envCleanup: () => { delete process.env['LD_PRELOAD']; }
    },
    {
      name: "2. 用户自定义规则 (拦截 docker)",
      tool: "bash",
      args: { command: "docker run -it ubuntu bash" },
    },
    {
      name: "3. 路径遍历防护 (超出工作区)",
      tool: "write",
      args: { path: "../../../etc/passwd" },
    },
    {
      name: "4. 工作区内的合法操作 (包含 ../ 解析)",
      tool: "read",
      args: { path: "./src/../package.json" },
    },
    {
      name: "5. 绝对不可覆盖规则 (修改 .git)",
      tool: "write",
      args: { path: path.join(workspacePath, ".git/HEAD") },
    }
  ];

  for (const c of cases) {
    console.log(`\n▶️ 测试用例: ${c.name}`);
    console.log(`   工具: ${c.tool}, 参数:`, c.args);
    
    if (c.envSetup) c.envSetup();
    
    const result = await pipeline.evaluate(c.tool, c.args, workspacePath);
    
    if (result.allowed) {
      console.log(`   🟢 结果: 允许执行 (Allowed: true)`);
    } else {
      console.log(`   🔴 结果: 阻止执行 (Allowed: false)`);
      console.log(`   🛑 原因: ${result.reason}`);
    }
    
    if (c.envCleanup) c.envCleanup();
    
    await new Promise(resolve => setTimeout(resolve, 50));
    console.log("--------------------------------------------------");
  }
}

main().catch(console.error);
