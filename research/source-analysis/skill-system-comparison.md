# Skill 系统横向对比 — OpenClaw vs Hermes（含 Claude Code 参照）

> **性质**：跨产品专题，基于真实源码深读的事实对比 ｜ **更新日期 2026-05-25**
> **依据**：[openclaw/skill-system.md](./openclaw/skill-system.md)（源码 v2026.5.25）、[hermes-agent/skill-system.md](./hermes-agent/skill-system.md)（源码 v0.14.0）；Claude Code 一列取自 [claude-code/architecture-overview.md](./claude-code/architecture-overview.md) 的 reverse 抓包实证（`<available_skills>` + 工具 schema）。
> 本文只做事实对比，不含知行的设计方案。

## 一句话结论

三家在"**怎么把技能放进上下文**"上**高度趋同**——都是「紧凑索引进 system 稳定层 + 渐进披露按需读全文 + 显式缓存」；真正分歧在"**技能从哪来、能不能自我进化、信任怎么建立**"：OpenClaw 是「作者撰写 / 远程安装」的静态库 + 安装期扫描；Hermes 是「能自主创建-迭代-淘汰」的活体库 + 来源溯源信任边界。

## 七维度对照表

| 维度 | OpenClaw (v2026.5.25) | Hermes (v0.14.0) | Claude Code（参照） |
|------|------|------|------|
| 磁盘格式 | `SKILL.md` + YAML frontmatter + 同目录附属文件 | `SKILL.md` + YAML frontmatter + `references/`/`templates/` 子文件 | `SKILL.md`（Agent Skills 格式）|
| 进上下文 | **仅索引** `<available_skills>`(name+description+location) 进 system，全文绝不进 | **仅索引**(name+description 按类别) 进 system stable 层 | **仅索引** `<available_skills>` 进 Skill 工具 description |
| 渐进披露 | 指令模型用 `read` 工具读 `<location>` 全文 | 模型调 `skill_view(name)` 工具按需读全文（带模板/内联 shell 渲染）| 模型按需展开 |
| 缓存 | 索引随 session 快照落盘（剥离全文）；字符预算降级 | 两层：进程内 LRU(max=8) + 磁盘快照 `.skills_prompt_snapshot.json`（mtime/size 校验）| 未在本地材料确认内部缓存细节 |
| 来源/优先级 | 六来源覆盖：`extra/plugin < bundled < managed < ~/.agents < <ws>/.agents < <ws>/skills`（按 name 去重） | 本地 `~/.hermes/skills/` + 外部只读 `external_dirs`（本地同名优先）；新技能只写本地 | — |
| 进化闭环 | **无自主进化**（撰写/安装/手动） | **有**：后台复盘 fork 创建/迭代 + 使用遥测状态机 + 自治 curator | 无（Anthropic 侧策划） |
| 分发/安装 | clawhub 远程 + archive/source 安装；按 `metadata.install` 跑包管理器装依赖 | Skills Hub(GitHub App) + `skills_sync` + provenance 溯源 | 官方/插件分发 |
| 安全扫描 | `skill-scanner.ts` 静态规则；**仅 critical 阻断、warn 不阻断**；clawhub 默认 `scan:false` | `skills_guard` + `skills_ast_audit`，安装/写入前扫；**自建技能默认不扫**(`guard_agent_created=False`) | 未在本地材料确认 |

## 趋同点：进上下文 = 索引 + 渐进披露 + 缓存（三家一致）

- **OpenClaw**：`formatSkillsForPrompt`（`skills/skill-contract.ts:44`）只输出 `<available_skills>`，每条 `<name>/<description>/<location>`；`buildSkillsSection`（`system-prompt.ts:243`）注入 system 的 `## Skills` 段并指令"扫描索引→命中再用 read 工具读 `<location>` 全文"。注释明写该 XML 布局与"上游 Agent Skills formatter 逐字节对齐"——即刻意对齐 Claude Code 的格式。
- **Hermes**：`build_skills_system_prompt`（`prompt_builder.py:997`）docstring 即"compact skill index for the system prompt"，按类别列 name+description；完整 SKILL.md 由 `skill_view`（`skills_tool.py:850`）按需加载。索引整 session 构建一次复用（保前缀缓存稳定），并有进程内 LRU + 磁盘快照两层缓存。
- **Claude Code**（reverse 实证）：技能以 `<available_skills>` 形式存在于 Skill 工具的 description 里，同样是 name+description 索引 + 按需展开。

**这正回答了"skill 清单与 prompt cache 是否矛盾"**：三家都把索引放进**稳定前缀**（system / 工具 description），并**只在技能集变化时才重建**（Hermes 用 mtime/size 快照校验，OpenClaw 用 session 快照 + 版本号 bump）——索引内容不变则前缀缓存命中，改/装技能才失效。没有银弹，靠"内容稳定 → 缓存命中"+ 缓存层把重扫成本降下来。

## 分歧点（设计相关，逐项事实）

### 1. 进化闭环：OpenClaw 无 vs Hermes 三层
- **OpenClaw**：技能是静态资产。有安装、状态(`skills-status.ts`)、doctor 体检，但**没有**"agent 回合后跑复盘、自动新建/泛化技能"的机制（深读以针对性搜索确认，标为"未发现"而非穷尽证明）。
- **Hermes 三层**：
  - **回合后台复盘 fork**：`_iters_since_skill >= _skill_nudge_interval`（默认 10，`conversation_loop.py:4207`）→ 回合末 daemon 线程 fork 受限 `AIAgent`（`background_review.py:404`，`max_iterations=16`、工具白名单 `["memory","skills"]`@:462、复用父 `_cached_system_prompt` 命中前缀缓存省 ~26%）。
  - **使用遥测状态机**：`skill_usage.py` 写 `.usage.json` sidecar，状态 active/stale/archived/pinned。
  - **自治 curator**：`curator.py` 7 天间隔触发（`should_run_now:199`），用 auxiliary 廉价模型，`max_iterations=9999`，做"伞式合并/泛化/淘汰"。

### 2. 信任边界：Hermes 的 write-origin provenance（OpenClaw 无对应物）
- Hermes 用 ContextVar 记"写入来源"（`skill_provenance.py`），哨兵 `BACKGROUND_REVIEW`；**只有后台复盘 fork 这个 origin 下创建的技能才 `mark_agent_created`**，前台(CLI/网关/cron/子代理)一律 `foreground`。
- **curator 只动 agent-created 技能**（`curator.py:269` + prompt 硬不变量 `:345-350`："绝不碰 bundled/hub 安装、绝不碰 pinned"）。这是"自治维护"敢放手的前提：自动化只在"机器自己造的"子集里活动，人/官方来源的技能 off-limits。
- 注意一处实现真相：curator 规则是"只归档不删"，但底层 `_delete_skill` 实为 `shutil.rmtree` 真删（`skill_manager_tool.py`）——**约束在 prompt + pinned_guard + 自动转换走 archive，而非 API 本身禁删**。
- OpenClaw 没有"自建 vs 外来"的进化信任概念，信任靠**安装期扫描**建立。

### 3. 分发与安装信任
- **OpenClaw**：clawhub 远程 + archive/source 安装；但信任假设不一致——clawhub 安装默认 `scan:false`（`skills-clawhub.ts:239`），source/archive 默认开扫；且安装扫描**只有 critical 阻断、warn 放行**（`install-security-scan.runtime.ts`）。
- **Hermes**：Skills Hub（GitHub App）+ `skills_sync` + `skill_provenance`；HubLockFile 的 `content_hash` **不是密码学验签**（深读已核库函数无验签，CLI 全链路未读，标存疑）。

### 4. 安全扫描模型
- **OpenClaw**：`security/skill-scanner.ts` 静态规则扫注入/外泄/凭证等模式，分 critical/warn；`audit-workspace-skills.ts` 防 workspace 逃逸。阻断只在 critical。
- **Hermes**：`skills_guard.py`(INSTALL_POLICY，信任×verdict) + `skills_ast_audit.py`(AST 审计)，在**安装/写入前**扫，block 则回滚(`shutil.rmtree`)；**但自建技能默认不扫**(`guard_agent_created` 默认 False)——即默认信任"自己造的"。

## 共识 vs 分歧（汇总）

- **共识（可直接借鉴的成熟做法）**：索引进 system 稳定前缀 + 渐进披露 + 缓存/快照；技能 = 带 frontmatter 的 `SKILL.md` 目录；`/<name>` 触发 + 模型按需读全文。
- **分歧（需要做取舍的设计点）**：要不要"自主进化"(Hermes 有/OpenClaw 无)；若要进化，怎么建**信任边界**(Hermes 的 write-origin provenance 是关键答案)；分发信任(扫描默认开关、是否验签)在两家都有**不一致/留白**，是可改进处。

## 仍存疑（供后续核实）
- OpenClaw "无自主进化"为针对性搜索结论，非穷尽证明。
- Hermes curator fork 是否带运行时工具白名单未深核（`_run_llm_review` 全函数无 `set_thread_tool_whitelist`，但 `platform="curator"` 是否在 `AIAgent.__init__` 内部裁剪未追全）。
- Hermes Hub `content_hash` 非验签的 CLI 安装全链路未读。
- 两篇深读文档各自末尾另有完整存疑清单。
