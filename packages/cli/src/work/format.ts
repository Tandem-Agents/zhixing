import type {
  JsonValue,
  WorkflowArtifact,
  WorkflowDecisionRecord,
  WorkflowInstance,
  WorkflowNodeRun,
} from "@zhixing/core";

const STATUS_LABELS: Record<WorkflowInstance["status"], string> = {
  created: "已创建",
  running: "进行中",
  waiting_decision: "等待裁决",
  succeeded: "已完成",
  failed: "失败",
  canceled: "已取消",
};

const NODE_LABELS: Record<string, string> = {
  goal_understanding: "理解目标",
  architecture_design: "架构设计",
  product_design: "产品判断",
  risk_design: "风险设计",
  design_join: "汇总设计视角",
  design_convergence: "收敛实施方向",
  direction_gate: "确认实施方向",
  implement_or_fix: "执行或修复",
  evidence_snapshot: "收集证据",
  correctness_review: "正确性审查",
  integration_review: "集成性审查",
  coverage_product_review: "覆盖与产品审查",
  review_join: "汇总审查意见",
  truth_filter: "复核真实问题",
  quality_gate: "确认质量结论",
  delivery_summary: "整理交付摘要",
};

export function formatWorkSnapshot(instance: WorkflowInstance): string {
  const lines: string[] = [];
  const progress = summarizeProgress(instance);
  const pendingDecision = firstPendingDecision(instance);

  lines.push("复杂任务");
  lines.push(`状态: ${STATUS_LABELS[instance.status]}`);
  lines.push(`任务: ${instance.goal}`);
  lines.push(`实例: ${instance.instanceId}`);
  lines.push(`阶段: ${currentStage(instance, pendingDecision)}`);
  lines.push(
    `进度: ${progress.succeeded}/${progress.total} 完成` +
      (progress.running > 0 ? ` · ${progress.running} 进行中` : "") +
      (progress.waiting > 0 ? ` · ${progress.waiting} 等待裁决` : ""),
  );

  if (pendingDecision) {
    lines.push("");
    lines.push(formatDecision(instance.instanceId, pendingDecision));
  }

  const finalText = readFinalText(instance);
  if (finalText) {
    lines.push("");
    lines.push("交付摘要");
    lines.push(finalText);
  }

  if (instance.errors.length > 0) {
    lines.push("");
    lines.push("最近错误");
    for (const error of instance.errors.slice(-3)) {
      lines.push(`- ${error.code}: ${error.message}`);
    }
  }

  return lines.join("\n");
}

export function formatMissingWork(instanceId: string): string {
  return `未找到复杂任务: ${instanceId}`;
}

export function formatWorkStarted(instance: WorkflowInstance): string {
  return [
    "复杂任务已启动",
    `实例: ${instance.instanceId}`,
    `状态: ${STATUS_LABELS[instance.status]}`,
    `查看: zhixing work status ${instance.instanceId}`,
  ].join("\n");
}

function formatDecision(
  instanceId: string,
  decision: WorkflowDecisionRecord,
): string {
  const lines = [
    "需要你决定",
    `问题: ${decision.question}`,
    `决策: ${decision.decisionId}`,
  ];
  if (decision.rationale) lines.push(`依据: ${decision.rationale}`);
  lines.push("选项:");
  for (const option of decision.options) {
    const recommended =
      option.optionId === decision.recommendedOptionId ? "（推荐）" : "";
    lines.push(`- ${option.optionId}: ${option.label}${recommended}`);
    if (option.description) lines.push(`  ${option.description}`);
  }
  lines.push(`提交: zhixing work decide ${instanceId} <optionId>`);
  return lines.join("\n");
}

function currentStage(
  instance: WorkflowInstance,
  pendingDecision: WorkflowDecisionRecord | undefined,
): string {
  if (pendingDecision) return labelNode(pendingDecision.nodeId);
  const running = instance.nodeRuns.filter((run) => run.status === "running");
  if (running.length > 0) return running.map((run) => labelNode(run.nodeId)).join("、");
  if (instance.status === "created") return "等待启动";
  const latest = [...instance.nodeRuns].sort(compareRunTime).at(-1);
  return latest ? labelNode(latest.nodeId) : "准备中";
}

function summarizeProgress(instance: WorkflowInstance): {
  total: number;
  succeeded: number;
  running: number;
  waiting: number;
} {
  const latest = latestRunsByNode(instance.nodeRuns);
  return {
    total: instance.definition.nodes.length,
    succeeded: latest.filter((run) => run.status === "succeeded").length,
    running: latest.filter((run) => run.status === "running").length,
    waiting: latest.filter((run) => run.status === "waiting_decision").length,
  };
}

function latestRunsByNode(
  runs: readonly WorkflowNodeRun[],
): readonly WorkflowNodeRun[] {
  const latest = new Map<string, WorkflowNodeRun>();
  for (const run of [...runs].sort(compareRunTime)) {
    latest.set(run.nodeId, run);
  }
  return [...latest.values()];
}

function compareRunTime(a: WorkflowNodeRun, b: WorkflowNodeRun): number {
  return timestamp(a.updatedAt ?? a.createdAt) - timestamp(b.updatedAt ?? b.createdAt);
}

function timestamp(value: string | undefined): number {
  return value ? Date.parse(value) || 0 : 0;
}

function firstPendingDecision(
  instance: WorkflowInstance,
): WorkflowDecisionRecord | undefined {
  return instance.decisions.find((decision) => !decision.resolvedAt);
}

function readFinalText(instance: WorkflowInstance): string | null {
  const deliveryRuns = instance.nodeRuns
    .filter(
      (run) =>
        run.nodeId === "delivery_summary" &&
        run.status === "succeeded" &&
        run.outputArtifactRefs &&
        run.outputArtifactRefs.length > 0,
    )
    .sort(compareRunTime);
  const latestRun = deliveryRuns.at(-1);
  if (!latestRun) return null;

  const artifact = latestRun.outputArtifactRefs
    ?.map((artifactId) =>
      instance.artifacts.find((entry) => entry.artifactId === artifactId),
    )
    .find((entry): entry is WorkflowArtifact => entry?.key === "output");
  if (!artifact) return null;
  return finalTextFromValue(artifact.value);
}

function finalTextFromValue(value: JsonValue): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (!isRecord(value)) return null;
  const finalText = value["finalText"];
  return typeof finalText === "string" && finalText.trim().length > 0
    ? finalText.trim()
    : null;
}

function labelNode(nodeId: string): string {
  return NODE_LABELS[nodeId] ?? nodeId;
}

function isRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
