# 开发协作白板 (.coordination)

> 多分支并行开发期的跨分支共享动态状态:谁在跑哪条 lane、各自目标与进度。约定层随仓库走、运行时状态留本地。并行开发的分支 agent 启动先读这里。

## 这是什么

并行开发期,各分支要有一处共享的动态状态来互相看见。它和静态规则分工:

- **静态规则**(根级 `PARALLEL-DEV.md`)—— 怎么同步、合并、解冲突,不变。
- **动态状态**(本目录)—— 谁在跑哪条 lane、目标、进度,时时在变。

## 机制:跨 worktree 怎么共享同一份

各分支挂在各自 worktree 里,但 board 只有一份、落在**主仓库根**的 `.coordination/`。任何 worktree 用 `git rev-parse --git-common-dir` 都解析到同一个主仓库 `.git`(linked worktree 共享它),其父目录即主仓库根——于是大家读写同一份 `.coordination/`,而非各自 worktree 的本地副本。同机共享就靠这个锚点。

## 目录布局

- `README.md` —— 本说明(进 git)。
- `branches/.gitkeep` —— 占位,保留空目录(进 git)。
- `branches/<branch>.json` —— 每条分支一格,**唯一真相源**;每分支只写自己那格(各写各的、无写冲突),看全貌就读整个目录。本地、不进 git。

不设聚合视图文件:"全局看板"是用时即读 `branches/*.json` 得到的,不落盘——免得派生文件漂移、又得有人维护。

## 进 git vs 留本地

- **进 git**(随仓库分发到每个分支、各分支应一致):`README.md`、`branches/.gitkeep`。
- **留本地**(运行态、gitignore,靠上面的 worktree 机制在同机各分支间可见):`branches/*.json`。

## 分支状态 schema

`branches/<branch>.json` —— 每条分支一格,纯 JSON(不带注释;字段含义见本节)。文件名把分支名的 `/` 拍平成 `-`(如 `feature/lane-a` → `feature-lane-a.json`),分支全名以文件内 `branch` 字段为准。

| 字段 | 含义 | 谁维护 |
|---|---|---|
| `branch` | 分支全名(带 `/`) | 建格时定 |
| `status` | `planned` 未建 / `active` 在跑 / `blocked` 卡住 / `merged` 已并入 main | 随实际推进 |
| `goal` | 这条 lane 要做什么 | 用户分派时填 |
| `progress` | 当前进度(做到哪步、下一步) | 该分支的 agent |

## 生效约定

- 分支 agent 启动先读本 README + 根级 `PARALLEL-DEV.md`。
- 进场先扫 `branches/*.json`,看清别的 lane 在跑什么、避免撞车。
- 维护自己那一格:`goal` 由用户分派时填,`progress` 随进度更新;**只写自己这格,绝不碰别人的**。
