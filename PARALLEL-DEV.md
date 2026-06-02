# 多分支并行开发手册

## 协作规则

### 硬性约束

- **main 只进不直改**:只经 PR 合入,绝不在 main 上 commit、绝不直推 `origin/main`。
- **commit 由用户执行**:你写代码、测到全绿;commit 是用户的背书。你负责 push 分支、开 PR、执行合并。
- **只有全绿才并入**:未达「合并门槛」的改动绝不进 main。
- **force-push 只限自己**:rebase 后用 `--force-with-lease`,只针对自己的 feature 分支;绝不碰 main 或共享分支。
- **语义冲突不自动解**:见「冲突处理」。

### 同步与边界

- **跟住最新 main**:main 一有前进就 `git fetch origin` + `git rebase origin/main`,保持线性、把冲突在自己这边消化;rebase 改写了历史,推送用 `--force-with-lease`。
- **守住边界**:只在本分支任务范围内改;旁逸发现的问题记录下来、不顺手改——顺手改会扩大冲突面、模糊 PR 边界。

### 合并门槛

- 按改动范围构建绿:改 CLI 用 `pnpm cli:build`;动到上游包(core / orchestrator 等)用 `pnpm build`(`-r` 递归全仓)。
- `pnpm test`(递归全仓)与 `pnpm lint` 全过。

### 并入 main

1. 做最后一次 `git rebase origin/main`,在分支侧把冲突解净、重过合并门槛——冲突绝不带进 main。
2. 唯一入口是 PR,任何情况不直推 main。
3. 合并选 merge-commit(`gh pr merge --merge`,不用 squash / rebase-merge):保留本分支完整 commit + 一个合并节点。
4. 职责链:你写代码 + 测绿 → 用户 commit(背书)→ 你 push、开 PR、执行合并。

### 冲突处理

- **文本冲突**(行级、语义清楚,如 import 顺序、互不相关的相邻改动):自解,解完无条件重跑 build + test。
- **语义冲突**(涉及同一函数逻辑、接口签名、共享状态,或你拿不准,或解完 test 挂):停下、上报用户、绝不自动解。

rebase 逐个重放提交遇到的冲突同理:文本可解,语义停下上报。
