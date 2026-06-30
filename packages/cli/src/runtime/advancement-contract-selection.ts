import type { RubricContractDraftSnapshot } from "@zhixing/core";
import type { SelectionRequest } from "../tui/selection/index.js";

export type AdvancementContractSelectionValue =
  | "confirm"
  | "edit"
  | "direct"
  | "cancel";

export function createAdvancementContractSelectionRequest(
  draft: RubricContractDraftSnapshot,
): SelectionRequest<AdvancementContractSelectionValue> {
  return {
    id: `advancement:${draft.draftId}`,
    title: "确认推进准则",
    body: [
      "知行已为这次任务准备推进准则。确认后，将按这份准则判断任务是否完成。",
      `Rubric：${draft.title}`,
      draft.description,
    ],
    details: {
      title: "推进准则详情",
      body: renderRubricDraftDetails(draft),
    },
    options: [
      {
        value: "confirm",
        label: "确认并开始",
        description: "按这份推进准则执行任务",
        hotkey: "y",
        tone: "primary",
      },
      {
        value: "edit",
        label: "修改准则",
        description: "说明你想调整的验收标准，知行会重新生成草案",
        hotkey: "e",
        input: {
          placeholder: "例如：把文档更新也加入通过标准",
        },
      },
      {
        value: "direct",
        label: "直接执行",
        description: "不启用推进闭环，只按普通任务执行一次",
        hotkey: "d",
      },
      {
        value: "cancel",
        label: "取消任务",
        description: "不执行原任务，并关闭这次推进确认",
        hotkey: "c",
        tone: "danger",
        confirm: {
          title: "取消这次任务？",
          body: ["取消后不会执行原任务。"],
          confirmLabel: "确认取消",
          cancelLabel: "返回",
        },
      },
    ],
    initialValue: "confirm",
    submitLabel: "选择",
    cancelLabel: "取消任务",
  };
}

function renderRubricDraftDetails(
  draft: RubricContractDraftSnapshot,
): readonly string[] {
  const lines: string[] = [];
  appendSection(lines, "通过标准", draft.content.passCriteria);

  const evidence = draft.content.evidenceRequirements?.map((item) => {
    const required = item.required === false ? "可选" : "必需";
    return `${item.description}（${required}）`;
  });
  appendSection(lines, "证据要求", evidence ?? []);

  const failureHandling = draft.content.failureHandling.map(
    (item) => `${item.scenario}：${item.reply}`,
  );
  appendSection(lines, "未通过时的处理", failureHandling);

  return lines;
}

function appendSection(
  lines: string[],
  title: string,
  items: readonly string[],
): void {
  if (lines.length > 0) lines.push("");
  lines.push(`${title}:`);
  if (items.length === 0) {
    lines.push("  - 未指定");
    return;
  }
  items.forEach((item, index) => {
    lines.push(`  ${index + 1}. ${item}`);
  });
}
