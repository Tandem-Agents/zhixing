# 工作场景 workdir 延迟绑定 + 拖拽/粘贴路径识别

> **状态**: 待架构设计(2026-05-22 备忘)
> **依赖**: [staging.md](../staging.md) 的 `/work` 二级面板 topic ① 先落地(Ctrl+N 新建场景产出 `workdir=undefined` 的场景,本文 ② 负责后续绑定)
> **来源**: `/work` UX 改进讨论 —— workdir 关联的颠覆性设计
> **不在范围**: `/work` 面板本体(list / 进入 / 删 / 改名 / 新建 name)走 staging topic ①

## 背景:为什么 workdir 关联是个难题

`WorkScene.workdir?: string` 是场景绑定的工作目录(可选)。影响 power runtime 进入工作模式后 file ops 的相对路径基准(workdir 若有 / cwd 若无)。系统数据(meta + me + conversations)永远在 `~/.zhixing/workscenes/<id>/`,与 workdir 无关;用户的 workdir 永不被 zhixing 操作(remove 时也不动)。

现状 `/work add <name> --workdir <path>` 命令行手敲路径 —— 长路径易错,无补全。

**关键架构约束(用户明确)**:zhixing 与运行 cwd **完全解耦** —— zhixing 在任何目录运行效果一致,**不能捕获 `process.cwd()` 作 workdir 来源**。这排除了"创建即捕获当前目录"的银弹方案。

## ② 延迟绑定(lazy workdir binding)

**第一性原理颠覆点**:不是优化"怎么输入 workdir",而是质疑"何时需要 workdir"。用户创建场景时未必想好 / 未必需要 workdir,强制塞进创建流程是把"按需属性"变成"必填流程"。

**设计**:
- 创建场景只起名字,`workdir = undefined`(topic ① 的 Ctrl+N 已是此行为)
- 真正需要 workdir 的那一刻 —— **进入场景后第一次让 agent 读/写文件,而场景还没 workdir** —— zhixing 此刻问一次"这个场景关联哪个目录?"(走 ③ 的拖拽/粘贴/补全)
- 绑定后持久,后续 file op 再不问
- 用户提供路径的时机,从"创建时(上下文最弱,还没想好)"推迟到"首次 file op 时(上下文最强,正要操作文件)"

**核心架构挑战(待调研 + 设计)**:
- agent file op 执行流的**中断交互** —— power runtime 执行文件工具前检查当前场景 workdir → 无则中断 agent loop,回 cli 问用户 → 绑定后 agent 继续。这是新机制,需调研:
  - power runtime 的文件工具在哪、执行前 hook 点在哪
  - 如何在工具执行中途暂停 + 弹 cli 交互 + 恢复(类似 confirmation 弹窗的中断协议?复用 SelectOperationRegion / 类似 modal?)
  - 绑定写入 `registry` 的 workdir 字段(现 registry 无 update workdir 能力,只有 add/rename/remove/setArchived → 需新增)
- **兜底**(用户原则:不阻塞):用户 Esc / 留空 → 跳过本次绑定,用默认 base 继续 agent 执行,下次 file op 再问一次

## ③ 拖拽/粘贴路径 normalize

**核心洞察**:拖拽文件夹 = 终端把路径字符串写 stdin = paste。zhixing 的 paste detector(`paste-detector.ts` microtask batcher)**已捕获**,无需专门"实现拖拽"。要做的只是 workdir 输入态对 paste content 做"路径规范化"。

**用户原则**:只做最稳的平台,不稳定的宁可不做、也不要报错,留兜底。

**只做最稳的两类格式**(平台感知,`process.platform` 分支):
- **Windows**(`win32`):strip 首尾双引号 `"D:\x\y"` → `D:\x\y`;反斜杠是路径分隔符**不动**
- **macOS**(`darwin`):unescape 反斜杠空格转义 `/Users/x/My\ Doc` → `/Users/x/My Doc`;strip 引号
- 两类都 trim 首尾空白 / 换行(拖拽常带末尾 `\r\n`)

**不稳定的不做**(不报错):Linux `file://` URI、SSH 本地路径(对远程主机无意义)、tmux/screen 嵌套。

**兜底语义**:normalize 后字符串**原样填入输入框**(无论识别成功与否),用户能看到、手敲编辑、删了重输。**任何情况不弹错误** —— 最差用户手动修正。

**边界**:
- 仅 `workdir` 输入态生效;普通对话输入框 paste **不受影响**(否则粘贴含引号正常文本会被误改)
- SSH 远程是最危险场景:拖拽产生本地机器路径,在远程不存在 → silent failure。属"不稳定不做"范围,但需文档/提示警示

**实现成本**:workdir 输入态加一个 `normalizePastedPath(content)` 纯函数 + 单测,约 1 个函数。

## 跨终端兼容性矩阵(调研结论,2026-05-22)

| 终端 | 拖拽 | 写入格式 | 处置 |
|---|---|---|---|
| Windows Terminal | ✅ | 含空格时双引号 `"D:\x\y"` | ✅ strip 引号 |
| Windows 旧 conhost | ✅ | 同上 | ✅ |
| macOS Terminal.app | ✅ | 反斜杠转义空格 | ✅ unescape |
| iTerm2 | ✅(可配置) | 转义空格 / 可配引号 | ✅ |
| GNOME Terminal | ✅ | 可能 `file://` URI | ⚠️ 不做 |
| Konsole | ✅(弹菜单) | 路径 / URI | ⚠️ 不做 |
| VS Code 集成终端 | ✅ | 路径(可能相对) | ⚠️ 不做 |
| tmux / screen | 透传或拦截 | 不可预测 | ⚠️ 不做 |
| SSH 远程 | ✅(本地拖拽) | **本地机器路径** | ❌ 语义错,不做 |

## 待确认的产品细节(进 staging 设计前对齐)

- **路径存在性校验**:倾向不阻塞。可选加 dim 非阻塞提示(目录不存在显示淡灰 `↳ 该目录当前不存在`),但不阻止绑定、不报错。或更纯粹完全静默 —— 待定
- **registry 需新增 update workdir 能力**:现 registry 只有 add/rename/remove/setArchived,延迟绑定需要"为已存在场景设置 workdir"的方法

## 依赖关系

- ② 依赖 topic ①(① 的 Ctrl+N 产出 `workdir=undefined` 场景,② 在首次 file op 时补绑)
- ③ 服务于 ②(workdir 输入态的路径输入便利)+ 可独立用于 `/work add` 命令行的 workdir 参数
