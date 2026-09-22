# 记录：跨会话协作体系迁移落地（2026-09-22）

**性质**：关键进展留痕（只增不改）。来源线程：`collab/threads/20260922-collab-migration-verify-7e3a/`（本地运行态，终态后按保留策略归档）。

## 结果

Ownward 跨会话智能体协作体系迁移至 zhixing，四项验收全部达成：

1. 权威文档 `docs/workbench/cross-session-collaboration.md`（481 行，含 §3.11 决策门 / §3.12 任务书保真 / §3.13 终审质量门）与技能包 `.agents/skills/session-collab/`（8 文件）字节级就位；唯一宿主适配＝§3.11 登记角色句。
2. `maintain-project-docs` 为**分叉合并**而非覆盖：保留 zhixing 本地规则（assets/brand、incidents/postmortems 拆分），合入 `collab/` 目录树条目。合并决策经 ownward 侧复核确认。
3. 运行态就位：`collab/` 空树、`resources/config.md`（默认额度）、`.gitignore /collab/`、角色文件三份（donald-knuth / ken-thompson / linus-torvalds，用户指认三兄弟，职责与 ownward 对应）。
4. 首次闭环验证完成：一般协作·串行线程，含 request / 回复 / 终态消息，双重独立核对（multi-agent-comm 只读核对＋ken-thompson 协议完整回路）结论一致——迁移产物与源一致，预期差异外无新增不一致。

## 可复用教训

1. **跨项目协作＝文件交付＋用户/对端会话转达**：opencode 每项目独立 server 实例，`session_send` 跨实例静默丢失且无报错。判据：发前 `session_list`，目标 ID 不在列表＝跨实例，改走文件（本次即用此法：跨项目任务书＋底部沟通区，经用户转达）。
2. **L0.5 宿主规则碰撞是常态而非异常**：宿主安全规则严格的会话会把跨会话指令当数据、全程只读（合规行为）。发起此类会话协作时，结果可能只出现在其会话内而不落线程文件；协议完整回路（先落盘＋回发）应交由已登记、已引导的角色执行。
3. **防锚定适用于核对复用**：多位核对者先后介入同一对象时，后到者须在自己 findings 落盘前不读前者结论（本线程实践：结论暂存＋落盘后对照）。
