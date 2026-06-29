import { describe, expect, it } from "vitest";
import {
  parseRubricDocument,
  stringifyRubricDraft,
} from "../document.js";
import { RubricProtocolError } from "../types.js";

describe("Rubric 协议文档", () => {
  it("解析 title / description / 通过标准 / 证据要求 / 未通过处理", () => {
    const document = parseRubricDocument(`---
id: code-review-done
title: 代码开发完成验收
description: 当任务要求修改代码并确认完成时使用
---

## 通过标准

- 用户提出的核心需求已经落地。
- 没有遗留直接冲突的问题。

## 证据要求

- 查看相关文件 diff。
- 查看测试或构建结果。

## 未通过时的处理

- 场景：仍有验收项未满足
  回复：当前任务还未达到验收标准。请继续处理以下未满足项：{missing_items}。

- 场景：缺少验证证据
  回复：当前结果缺少可核对的验证证据。请补充验证过程、结果，或说明无法验证的具体原因。
`);

    expect(document.id).toBe("code-review-done");
    expect(document.title).toBe("代码开发完成验收");
    expect(document.description).toBe("当任务要求修改代码并确认完成时使用");
    expect(document.content.passCriteria).toEqual([
      "用户提出的核心需求已经落地。",
      "没有遗留直接冲突的问题。",
    ]);
    expect(document.content.evidenceRequirements.map((item) => item.text)).toEqual([
      "查看相关文件 diff。",
      "查看测试或构建结果。",
    ]);
    expect(document.content.failureHandling).toMatchObject([
      {
        scenario: "仍有验收项未满足",
        reply: "当前任务还未达到验收标准。请继续处理以下未满足项：{missing_items}。",
      },
      {
        scenario: "缺少验证证据",
        reply:
          "当前结果缺少可核对的验证证据。请补充验证过程、结果，或说明无法验证的具体原因。",
      },
    ]);
  });

  it("支持协议示例里的冒号标签写法", () => {
    const document = parseRubricDocument(`---
title: 需求收敛推进
description: 当任务是梳理尚未收敛的产品想法时使用
---

通过标准：
- 核心问题已经被明确。

未通过时的处理：
- 场景：核心问题仍不清楚
  回复：当前需求还没有收敛到核心问题。请重新说明问题本质。
`);

    expect(document.content.passCriteria).toEqual(["核心问题已经被明确。"]);
    expect(document.content.failureHandling[0]?.reply).toBe(
      "当前需求还没有收敛到核心问题。请重新说明问题本质。",
    );
  });

  it("缺少必要内容时抛出协议错误", () => {
    expect(() =>
      parseRubricDocument(`---
title: 不完整
description: 缺少未通过处理
---

## 通过标准

- 有标准
`),
    ).toThrow(RubricProtocolError);
  });

  it("显式 id 无效时抛出协议错误", () => {
    expect(() =>
      parseRubricDocument(`---
id: ///
title: 身份损坏准则
description: 有标题但 id 无效
---

## 通过标准

- 有标准

## 未通过时的处理

- 场景：未完成
  回复：继续。
`),
    ).toThrow(RubricProtocolError);
  });

  it("结构化草稿可序列化并回读", () => {
    const raw = stringifyRubricDraft({
      title: "文档审查完成验收",
      description: "当任务要求审查文档是否完成时使用",
      content: {
        passCriteria: ["文档覆盖用户提出的核心需求。"],
        evidenceRequirements: ["查看目标文档内容。"],
        failureHandling: [
          {
            scenario: "覆盖不完整",
            reply: "当前文档还没有覆盖以下核心点：{missing_items}。",
          },
        ],
      },
    });

    const document = parseRubricDocument(raw);
    expect(raw).toContain("id: 文档审查完成验收");
    expect(document.id).toBe("文档审查完成验收");
    expect(document.title).toBe("文档审查完成验收");
    expect(document.content.evidenceRequirements[0]?.text).toBe(
      "查看目标文档内容。",
    );
    expect(document.content.failureHandling[0]?.scenario).toBe("覆盖不完整");
  });
});
