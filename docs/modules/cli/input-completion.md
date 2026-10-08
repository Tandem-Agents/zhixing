# 输入补全架构

输入补全帮助发现命令、填写参数和引用文件，不拥有业务状态，也不替用户裁决执行权限。[命令系统](command-system.md)负责声明与分派，本文负责草稿、候选和接受结果的交界。

## 当前装配与状态归属

```text
U TerminalInputSession（草稿、光标、版本）
    → U TerminalCandidateSession（查询代际、选中项、删除准备态）
    → N TerminalCandidatesOwner（registry、Provider、当前候选身份）
    → ArgumentProvider / CommandProvider / FileProvider
    → U 有界候选列表 → 回填草稿，按接受结果决定是否提交
```

core/typeahead 提供不依赖终端的匹配和 Providers；新终端直接消费这些纯机制，没有装配旧 TypeaheadBroker。N 保留查询 AbortController、候选业务元数据与 revision；U 保留页面是否活跃、草稿版本、光标及查询窗口。接受必须同时匹配这些身份，迟到结果不修改更晚草稿或另一个页面。

候选会话不是对话会话。补全是草稿的派生状态，确认是等待业务决定的独立页面，不能共用一个模态状态机。所有输入与绘制仍由 U 根持有。

## 触发与来源

按光标前 token 匹配，Unicode 字符与 UTF-16 编辑坐标在接入边界转换，不按 UTF-8 字节截断文字。统一 handle patterns 作为额外词边界，避免材料和粘贴 token 污染 query。默认要求行首或空白边界。

| 来源 | 优先级 | 职责 |
|---|---|---|
| ArgumentProvider | 90 | 按参数位置查询静态／异步枚举及布尔候选；text/path/number 不因此拥有业务校验能力 |
| CommandProvider | 100 | 从 registry 可见集合检索命令；名称与别名优先于描述中的偶然匹配 |
| FileProvider | 200 | @file:path 与非空 @path 的目录枚举；裸 @ 不触发，@tool: 让出但不表示已有工具补全 |

N 按优先级选择第一个匹配来源，不混合结果。文件根动态取当前 workspace，缺失时使用 CLI cwd；查询的是 CLI 本地文件系统，不是远端浏览服务。支持相对路径、..、~/ 和可解析的绝对路径；显式 @file: 才展示点开头文件。目录优先、名称排序，目录接受后可继续浏览，文件接受后加空格，不立即提交。

路径范围标记不是授权或沙箱；候选回填不等于读取文件内容，更不等于模型已接收材料。

## 有界查询、排序与错误

U 只发送光标附近的有限查询窗口，保留一项在途请求及一项可替换后继；新状态使旧代际结果失效。N 限制输入和候选字节，并最多返回 100 项。U 默认选中首项，上下导航到边界停止，列表按视口显示。

当前 sync 会清除上一批普通候选后发起查询；/trust 即使正在加载或返回空列表，也保留管理模式，避免 Enter 误发草稿。Provider 异常转成有限错误结果；Abort 表示取消消费，不证明底层 I/O 已物理停止。旧 Broker 的 3 秒查询计时器和保留旧候选策略未因复用 Providers 自动迁入。

CommandProvider 保留 Fuse 多字段检索、名称／别名前缀与模糊分数排序。新装配未注入 UsageTracker，也没有实际使用计分或跨重启频度存储；[迁移设计](../../workbench/terminal-architecture-migration.md) D09 不新增频度计分／持久化。不得把核心库具备的算法写成终端已接通的能力。

N 从同一 Provider 投影无歧义前缀和渐进参数提示；U 在公共信息栏展示，不把 placeholder 或 ghost 放进编辑原文。Tab 在有效 ghost 存在时只补齐原前缀，不执行候选命令；提示、回填与普通候选共用 revision 和草稿快照校验。

## 接受、提交与管理动作

| 状态 | 行为 |
|---|---|
| 普通列表有候选 | ↑／↓ 选择；Tab 有有效前缀时仅补全，无前缀时接受候选；Enter 接受候选，依据 execute 回填或提交 |
| 命令尚需参数 | 接受名称只回填，后续由候选或手打补齐 |
| 没有候选 | Enter 提交草稿；slash 经命令入口，不降级为模型猜测执行 |
| 管理面板 | Enter 不接受或发送，包括加载和空列表；只执行声明的管理动作 |
| Esc | 有有效候选范围时移除当前 token；无可移除范围时清空草稿并关闭候选 |

N 根据候选身份返回接受结果；U 先核对快照，再更新草稿，最后按 execute 决定提交。候选接受不等于领域操作已经成功，参数合法性和执行权限仍由业务适配及宿主检查。

会话／工作场景候选通过连续两次 Ctrl+D 确认删除；换项、改输入、改光标或其他按键解除准备态。Ctrl+R 改名、Ctrl+N 新建仅在声明能力存在时生效。/trust 的撤销使用其管理协议，不与普通候选接受混用。

动作由 U 发 candidate-manage，N 验证 revision、候选身份与当前能力，再调用会话、工作场景或管理 facade。改名／新建通过同一 U 页面输入，完成后回到原页面并刷新；不再使用 InlineTextPromptRegion、candidate-delete-controller 或第二个输入监听者。删除当前对话后的新建与指针衔接仍由会话应用处理。

## 页面、粘贴与生命周期

切页时停用候选并保留原草稿，返回后重新同步当前身份；不会为每个面板卸载、重新抢占 stdin/raw mode。U 根统一控制键盘、鼠标、编辑器与光标。候选消失不能留残行，光标和 IME 位置须保持正确；布局见[输入视觉](input-visual.md)及[屏幕渲染](screen-rendering.md)。

右键优先沿宿主粘贴通路；应用处理时由 N 的受管剪贴板读取进入同一输入流。读取／粘贴未完成不得抢先发送，迟到结果核对页面、版本与光标。滚轮和选区不因粘贴被禁用；原文与历史保活见[文本粘贴](text-paste.md)。

本模块提供 / 与 @ 输入辅助，没有工具／MCP／Agent 专用补全、文件命令目录、Plugin SDK 或 Web renderer。文本入口消费同源命令声明和业务适配，不复制候选界面。

实现依据：[Providers](../../../packages/core/src/typeahead/providers)、[N 候选](../../../packages/cli/src/terminal/candidates.ts)、[U 候选状态](../../../packages/terminal-ui/src/candidate-session.ts)、[输入状态](../../../packages/terminal-ui/src/input-session.ts)、[U 根](../../../packages/terminal-ui/src/root.tsx)。核对迟到拒收、接受与执行区分、管理空态、删除准备取消、页面往返、剪贴板版本和真实按键消费，不能只测候选快照。
