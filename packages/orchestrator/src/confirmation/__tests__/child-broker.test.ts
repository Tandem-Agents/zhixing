/**
 * resolveSubAgentResolver — 子 agent confirmation 策略路由单测
 *
 * 覆盖矩阵:
 *   - 全部 SubAgentConfirmationPolicy 字面量值各自路径(均为生产安全 fail-deny 语义)
 *   - 必填 policy 参数(无字面默认值)的 caller 契约
 *   - 返回值即 broker 注入的实际 NonInteractiveResolver,可直接驱动 broker 路径验证
 *
 * 安全姿态测试: failToAllowResolver 不在本路径暴露,验证逻辑见
 * core/confirmation/__tests__/broker.test.ts 的"failToAllowResolver 注入"用例
 * (强制走"显式 new ConfirmationBroker({nonInteractiveResolver:failToAllowResolver})"路径)
 */

import { describe, expect, it } from "vitest";
import { ConfirmationBroker, failToDenyResolver } from "@zhixing/core";
import { resolveSubAgentResolver } from "../child-broker.js";
import type { SubAgentConfirmationPolicy } from "../../subagent/budget.js";

/**
 * 把 policy 字面量元组与 `SubAgentConfirmationPolicy` 联合类型**双向严格绑定**:
 *   - 反向覆盖(数组 → 联合):约束 T extends readonly SubAgentConfirmationPolicy[]
 *     —— 数组里写非法字面值(如 typo `"inherit-r-deny"`)立即编译失败
 *   - 正向覆盖(联合 → 数组):条件类型 SubAgentConfirmationPolicy extends T[number]
 *     —— 数组缺值(漏列联合类型某字面值)实参类型推断为 `never`,实参传入失败
 *
 * 任一方向断裂均触发 TS 编译错误,实现"加新 policy 字面值时强制更新本数组"
 * 的编译期契约保护。
 *
 * 该 helper 只服务测试场景(运行时只是 identity 返回),抽到生产代码无收益,
 * 故就近留在测试文件本地。
 */
function exhaustivePolicyList<
  T extends readonly SubAgentConfirmationPolicy[],
>(list: SubAgentConfirmationPolicy extends T[number] ? T : never): T {
  return list;
}

function makeRequest(id: string) {
  const now = Date.now();
  return {
    id,
    tool: "bash",
    toolInput: { command: "ls" },
    workingDirectory: "/tmp",
    display: {
      title: "Bash",
      body: { kind: "bash" as const, command: "ls", commandPreview: "ls" },
      cwd: "/tmp",
    },
    options: [
      { kind: "allow-once" as const, label: "allow once" },
      { kind: "deny" as const, label: "deny" },
    ],
    sessionType: "ci" as const,
    contextId: { kind: "main" },
    createdAt: now,
    expiresAt: now + 60_000,
  };
}

describe("resolveSubAgentResolver — 策略路由", () => {
  it("inherit-or-deny → failToDenyResolver (默认安全姿态)", () => {
    expect(resolveSubAgentResolver("inherit-or-deny")).toBe(failToDenyResolver);
  });

  it("policy 参数必填(无字面默认值)—— 编译期类型契约强制 caller 走 resolveSubAgentBudget", () => {
    // 编译期类型契约:Parameters<typeof resolveSubAgentResolver> 必须严格匹配
    // [SubAgentConfirmationPolicy](必填,无 optional 修饰)。
    //
    // 契约保护机制:若有人为 policy 加默认值(如 = "inherit-or-deny"),Parameters
    // 会被 TS 推断为 [policy?: SubAgentConfirmationPolicy] —— 不再 extends
    // [SubAgentConfirmationPolicy] —— `_ParamsAreRequired` 推断为 false ——
    // `const _contract: false = true` 编译错误 → 测试失败。
    //
    // 必填语义对应单一真相源原则:default 必须由 resolveSubAgentBudget 统一提供,
    // 避免 resolveSubAgentResolver 与 budget.ts 各自维护字面 default 导致行为漂移。
    type _ParamsAreRequired = Parameters<
      typeof resolveSubAgentResolver
    > extends [SubAgentConfirmationPolicy]
      ? true
      : false;
    const _contract: _ParamsAreRequired = true;
    expect(_contract).toBe(true);
  });

  it("安全姿态契约:SubAgentConfirmationPolicy 全集字面值都映射到 fail-deny resolver", () => {
    // exhaustivePolicyList 通过双向类型绑定,在加新字面值(如 'inherit-or-prompt')
    // 或误加非生产字面值(如 'auto-approve')时强制本数组同步更新,否则 TS 编译失败,
    // 审查者立即捕获。这是"misuse 防御"的编译期实施层。
    const allPolicies = exhaustivePolicyList([
      "inherit-or-deny",
    ] as const);

    for (const policy of allPolicies) {
      const resolver = resolveSubAgentResolver(policy);
      expect(resolver.name).not.toBe("fail-to-allow");
      expect(resolver.name).toBe("fail-to-deny");
    }
  });
});

describe("resolveSubAgentResolver — broker 集成路径", () => {
  it("inherit-or-deny resolver 注入 broker 后,无 listener 路径 auto-resolve 为 deny", async () => {
    const broker = new ConfirmationBroker({
      nonInteractiveResolver: resolveSubAgentResolver("inherit-or-deny"),
    });
    const decision = await broker.requestConfirmation(makeRequest("d1"));
    expect(decision.kind).toBe("deny");
  });
});
