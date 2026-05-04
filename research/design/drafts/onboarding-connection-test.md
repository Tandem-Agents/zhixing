# 首次配置·连接测试（被动）

> **状态**：📋 待起草（2026-05-04）
> **目标合并到**：[specifications/credentials-and-onboarding.md](../specifications/credentials-and-onboarding.md)
> **触发**：UI 视觉重构审查（2026-05-04）发现首次配置缺连接验证步骤——配错 API Key 只能在 REPL 第一句话失败时暴露。

## 背景

`runConfigEditor` 当前对 API Key 仅校验"非空"——不验证 key 是否真能调通。后果：

- 用户首次配置最易出错的环节（手抖、复制粘贴失误、key 已过期）反而无即时反馈
- 错误暴露推迟到 REPL 第一句话——彼时已退出配置编辑器，回归路径长（`/config` 重进 → 重选 provider → 重输 key）

## 已确认决策

- **被动触发**：连接测试作为**用户主动调用**的功能提供——不在配置流中自动执行
  - 自动测试会打断配置流（每次完成 provider 都加载等待）
  - 自动测试的失败处理涉及"是否阻塞 完成"——产品定位不清
  - 被动让用户掌控；不想测就不测，配完即走
- **与 UI 优化解耦**：本 todo 是**功能优化**，不属于 [cli-ui-design-language.md](../specifications/cli-ui-design-language.md) 视觉重构范围
  - 落地时复用 design language 的加载态规范（届时补充）

## 待对齐决策

1. **入口位置**：测试动作放哪里？候选：provider-config 面板新增"测试连接"按钮 / input 面板 Enter 之外提供 Ctrl+T 双键位 / 独立 slash 子命令
2. **失败 UX**：错误信息位置（footer 红字 / 整段 banner）；失败后是否阻止用户"完成"，还是仅提示让用户决定
3. **调用什么端点**：`/v1/models` GET（最便宜 + 通用）/ 最便宜 chat completion（更真实但耗 token）；各 provider 是否需要注册"健康检查 endpoint"
4. **超时与取消**：等多久算失败？测试中能否 Esc 取消？

## 范围边界

- 仅覆盖 **provider API Key** 测试
- channel 凭证（飞书 appId/appSecret 等）测试不在范围——若要做走独立草稿（outbound 调用形态不同）

## 实施前置

- 不依赖 UI 视觉重构落地
- 落地时引用 design language 的加载态规范（届时补 P8）
