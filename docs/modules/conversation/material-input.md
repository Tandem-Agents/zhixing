# 会话材料输入架构

用户交付的是本轮材料，不是文件名、路径或 UI 占位符。接入面可以采用不同采集方式，但进入会话后必须表达材料本身及其顺序；不能把图片编码塞进普通文本、把文件名当成文件内容，或静默降级来伪装成功。

## 职责与当前合同

接入面负责采集、输入态呈现和本地材料准备；会话入口接收结构化输入；核心负责消息转换与模型输入能力检查；Provider 负责厂商协议编码。材料选择、材料可读取、核心已接收、模型可消费是不同边界，不能相互代替。

当前 `UserTurnInput.parts` 是有序的 `text | image` 序列：

- `text` 保存正文；首尾空白不因展示或空输入判断而裁剪。
- `image` 携带 base64 或 URL 形式的 `ImageSource`，可附带名称、MIME 和大小。图片不是正文中的路径说明。
- 普通文件不是独立的核心 part；CLI 可把支持的文本文件转成 text，把图片转成 image。不支持的二进制文件不能假装已经被理解。

`userMessageFromTurnInput` 按序生成 text/image 消息块；名称等输入元数据并不会全部进入模型消息。`extractUserTurnInputText` 只是文本投影，会略过图片，不能替代完整输入。字符串调用经 `normalizeUserTurnInput` 转成同一结构，不形成第二套材料语义。

会话 owner 的接收与恢复合同使用 `UserTurnInput`，协议边界通过共享校验器验证非空输入；不能用接入面的宽松类型判断代替协议校验。输入进入消息后的持久化与恢复由[对话持久化](persistence.md)负责，不在材料模块再建一套历史。

## 能力检查与失败边界

Runtime 装配当前模型的输入能力，Agent Loop 在调用模型前执行 `validateMessagesAgainstInputCapabilities`；检查包含历史在内的实际消息，而不只看本次是否附图。模型目录声明与用户覆盖共同决定能力，用户覆盖优先；未声明图片支持时默认不支持。

当前检查维度是图片。发现模型不支持图片时返回明确错误，提示更换支持图片的模型或移除图片；Provider 不负责猜测文件路径，也不能把图片悄悄改成文本。消息可被协议接收不等于已通过模型能力检查，更不等于运行成功。

产品上，材料准备失败应可见且保留可恢复输入，不能先制造“已发送成功”的印象。CLI 已保护准备失败，但其输入 commit 与核心接受并非严格同一时刻，具体差异见[CLI 材料输入](../cli/material-input.md#提交与失败边界)。

## 现状与未落地设计

共同输入合同不意味着所有接入面已经具备相同采集能力；CLI 路径采集不能证明通道或系统剪贴板已支持同类材料。

当前没有旧稿设想的统一 `MaterialStore`、`UserMaterialRef` 或通用 `MaterialHandlerRegistry`。CLI registry 保存本地文件引用，提交时读取并生成输入，不是可跨设备恢复的材料仓库，也不保存添加时的不可变文件快照。核心 image source 支持 URL/base64，不代表已有通用的材料缓存与生命周期服务。

长期有效的原则是采集方式与共同输入语义分离，不能为每种材料建立平行主链；但音视频、网页快照、富文本、PDF/Office 解析和独立文件 part 尚非当前合同。不能承诺新增这些类型只加 handler 而不改变严格协议，也不因保留原则而预建框架。

## 维护验证

验证应覆盖正文保真、图文顺序、图片消息转换、文本投影不代替完整输入、协议拒绝非法 part、模型能力拒绝以及历史含图的检查。接入面测试还须证明实际提交的是 parts 而非 chip 字面文本；仅 UI 展示正确不能证明材料已到达模型。

实现入口：[输入类型与转换](../../../packages/core/src/types/user-input.ts)、[协议校验](../../../packages/core/src/protocol/values.ts)、[Owner 接收](../../../packages/owner-kernel/src/conversation-assignment.ts)、[Agent Loop](../../../packages/core/src/loop/agent-loop.ts)、[Runtime 装配](../../../packages/orchestrator/src/runtime/create-agent-runtime.ts)。
