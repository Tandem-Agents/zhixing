// S7 结构闸的行为承接登记：结构检查只核有限归属、导入导出、注册与声明关系；运行顺序、等待、拒绝与数据来源的
// 效果由下面登记的行为用例承担。结构闸核对每个用例在文件里有声明（s7-entry-coverage.mjs）；
// `pnpm s7:lint` 经 s7-behavior.mjs 从源码运行它们，并按“登记文件 + 实际用例标题”逐条核对恰好收集到一个且通过，
// 缺失、跳过、todo、重名或空登记都不算通过。迁入新职责时在这里补一条，写明它替代的结构断言。
// test 是文件里声明的标题（参数化用例写模板）；参数化用例另在 cases 里列出展开后的实际标题。
import path from "node:path";


export const S7_BEHAVIOR_EVIDENCE = Object.freeze([
  // Workscene 各模式投影的信任范围（场景、主模式、工作区绑定、job）
  {
    responsibility: "Workscene product owner forms each runtime projection with its trust scope",
    file: "packages/cli/src/serve/__tests__/workscene-runtime-projection.test.ts",
    test: "forms frozen main and scene projections with the exact product tool split",
  },
  {
    responsibility: "Workscene ephemeral and durable-job projections come from the same product facts",
    file: "packages/cli/src/serve/__tests__/workscene-runtime-projection.test.ts",
    test: "forms ephemeral and durable-job projections from the same exact product facts",
  },
  // 权限基础设施的范围只来自已认证事实，并经领域推导
  {
    responsibility: "Permission infrastructure derives trust scope only from authenticated facts",
    file: "packages/cli/src/serve/__tests__/permission-storage-infrastructure.test.ts",
    test: "derives the trust scope only from authenticated scope facts, never from the local path",
  },
  {
    responsibility: "Job sediment scope comes from the manifest workspace and freezes into the next snapshot",
    file: "packages/cli/src/serve/__tests__/permission-storage-infrastructure.test.ts",
    test: "derives a job sediment's scope from its manifest workspace and freezes the same scope into the next job snapshot",
  },
  // Advancement：取消、确认、新任务作用域与生命周期由领域应用决定
  {
    responsibility: "Advancement application owns cancellation and publishes its Fact before original-task handoff",
    file: "packages/core/src/advancement/__tests__/application.test.ts",
    test: "owns cancellation and publishes its committed Fact before original-task handoff",
  },
  {
    responsibility: "Advancement application owns confirmation before original-task admission",
    file: "packages/core/src/advancement/__tests__/application.test.ts",
    test: "owns confirmation, publishes the committed Fact before admission and settles the durable run identity",
  },
  {
    responsibility: "Advancement new-task decision only judges scope and accepts pending proposals first",
    file: "packages/core/src/advancement/__tests__/application.test.ts",
    test: "新任务只判作用域：先接受待接受提议，无未终结会话为 new-task，有则 not-applicable，不调模型准入",
  },
  {
    responsibility: "Conversation lifecycle cancellation is owned by the lifecycle application",
    file: "packages/core/src/advancement/__tests__/application.test.ts",
    test: "treats a missing open session as an idempotent cancellation success",
  },
  {
    responsibility: "Conversation lifecycle application durably cancels an open session on Conversation retirement",
    file: "packages/core/src/advancement/__tests__/application.test.ts",
    test: "cancels an open %s session with the Conversation-retirement decision",
    cases: [
      "cancels an open awaiting-rubric-confirmation session with the Conversation-retirement decision",
      "cancels an open active session with the Conversation-retirement decision",
    ],
  },
  {
    responsibility: "Conversation lifecycle application owns the orphan sweep decision",
    file: "packages/core/src/advancement/__tests__/application.test.ts",
    test: "owns the alive/dead orphan decision and isolates per-candidate failures",
  },
  {
    responsibility: "Proposal application aborts in-flight work when the conversation is deleted",
    file: "packages/core/src/advancement/__tests__/proposal-application.test.ts",
    test: "删除取消会话后中止在途调用：迟到结果作废，不写结果不明也不发布",
  },
  {
    responsibility: "Original-task admission uses the Conversation application once",
    file: "packages/cli/src/serve/__tests__/advancement-original-task-application.test.ts",
    test: "uses the Conversation application once with the original identity and surface effects",
  },
  // 调度失败策略：领域判定、owner 摘要计数与自动停用
  {
    responsibility: "Schedule domain owns next-fire, failure streak and auto-disable identity",
    file: "packages/core/src/scheduler/application.test.ts",
    test: "owns next-fire, failure streak and auto-disable operation identity",
  },
  {
    responsibility: "Owner failure summary equals the full-order consecutive-failure reference",
    file: "packages/owner-kernel/src/__tests__/job-failure-summary.test.ts",
    test: "matches the full-order reference at every step and touches only the located path",
  },
  {
    responsibility: "Committed auto-disable obligations redrive to one disabled definition",
    file: "packages/owner-kernel/src/__tests__/scheduler-authority.test.ts",
    test: "redrives a committed auto-disable obligation to one disabled definition",
  },
  // Delivery：遇 uncertain 停止收束已受理工作
  {
    responsibility: "Accepted-work settlement stops at an uncertain outcome",
    file: "packages/core/src/delivery/__tests__/authority-pipeline.test.ts",
    test: "blocks lifecycle settlement when a manual outcome becomes uncertain",
  },
]);

/** 每条登记在运行层要核对的实际用例：{ file, title }。 */
export function behaviorEvidenceCases(evidence = S7_BEHAVIOR_EVIDENCE) {
  return evidence.flatMap((entry) => (entry.cases ?? [entry.test]).map((title) => ({ file: entry.file, title })));
}

/**
 * 按 vitest JSON 结果核对登记：每个“登记文件 + 实际标题”在该文件的结果里恰好出现一次且状态为 passed。
 * 缺失（未收集或名字不符）、skipped/pending/todo/failed、同名多例、空登记、空结果都返回失败说明；不比较总数。
 */
export function behaviorEvidenceFailures(report, root, evidence = S7_BEHAVIOR_EVIDENCE) {
  const cases = behaviorEvidenceCases(evidence);
  if (cases.length === 0) return ["S7 behavior evidence registry is empty"];
  const files = Array.isArray(report?.testResults) ? report.testResults : [];
  const relative = (name) => path.relative(root, name).split(path.sep).join("/");
  const failures = [];
  for (const { file, title } of cases) {
    const results = files.filter((entry) => relative(entry.name) === file)
      .flatMap((entry) => entry.assertionResults ?? [])
      .filter((result) => result.title === title);
    if (results.length === 0) failures.push(`${file}: S7 behavior evidence was not collected: ${title}`);
    else if (results.length > 1) failures.push(`${file}: S7 behavior evidence title is ambiguous (${results.length} cases): ${title}`);
    else if (results[0].status !== "passed") failures.push(`${file}: S7 behavior evidence did not pass (${results[0].status}): ${title}`);
  }
  return failures;
}
