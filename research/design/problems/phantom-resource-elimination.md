# Phantom Resource 消除 — 路径解析中心化

> 触发于 2026-05-06 全量审计：用户担心知行在用户机器上"凭空"创建文件夹/资源吃占用。审计揭示根因不是单点 leak，而是 **`~/.zhixing/` 这个唯一物理位置在代码里有多处独立逻辑表达**。本文档是架构方案的"脱过程版"——保留问题描述、最终设计、实施步骤，去掉对话痕迹。

## 问题描述

**现象**：`@zhixing/test-utils` 的 `createTempDir` (commit `148c9b1`) 解决了一类测试残留临时目录的问题。审计后发现这只是症状之一，根因的更广症状包括：

1. **生产代码 9 处**直接 `os.homedir() + .zhixing` 拼路径，绕过 `getZhixingHome()`
2. **`~/.zhixing/server.token` 一个物理路径在系统里有 3 处独立字符串定义**：`server/paths.ts:41` `getDefaultTokenPath()` / `cli/serve/token.ts:16` `DEFAULT_TOKEN_PATH` / `server/client/discovery.ts:18` `DEFAULT_TOKEN_PATH`
3. **`~` 展开有 5 处独立实现**：`path-guard.ts:144 PathGuard.expandHome` (含 Windows `~\`) / `policy-engine.ts:410 expandPath` (private) / `resolve-file-refs.ts:115` / `file-provider.ts:274` / `config-loader.ts:67`
4. **两个 env var 互不知情**：`ZHIXING_HOME` 由 core 的 `getZhixingHome()` 消费；`ZHIXING_CONFIG_PATH`（ADR-003 锁定的产品 surface）由 providers 的 config-loader 消费；两者完全隔离 → `ZHIXING_HOME=/foo` 后 conversations 走 /foo 但 credentials/config 仍打 `~/.zhixing/`，**测试隔离失效**
5. **测试期 41 个文件**仍走 raw `mkdtemp + 手写 afterEach` 旧模式，`createTempDir` 只迁移了 4 个；新旧两套写法并存 → 后人复制旧模式
6. **生产辅助代码 2 处 default fallback 落 tmpdir**：`scheduler.test.ts:17` 与 `pipeline.test.ts:31` 当 `storePath`/`queueFilePath` 参数没传时 fallback 到 `tmpdir() + Date.now().json` —— 当前是死代码，但是**埋在签名里引诱新代码踩**的陷阱
7. **测试 helper 不覆盖 beforeAll 模式**：`createTempDir` 基于 `onTestFinished`，对 describe-scope 共享 dir 场景无 API（2 个测试文件 `classifier.test.ts` + `file-provider.test.ts` 走经典 `beforeAll + afterAll`）

**直接原因**：上述 7 类是相同根因在不同 layer 的投射。

**本质**：路径解析没有强制单一入口。`getZhixingHome()` 是约定不是强制，任何代码都能 import `node:os` 自己拼。约定可绕过 = 终会被绕过。

## 解决方向（一句话）

让 `~/.zhixing/` 在代码里**只有一种说法**——三层架构（基础原语 / domain 路径 / ESLint 防回归），同一物理路径只在一处拼接。

---

## 架构方案

### 三层结构

```
[基础原语]    packages/core/src/paths.ts
              • getZhixingHome()      ~/.zhixing 唯一入口（保留现有）
              • expandUserHome()      ~ 展开唯一入口（新增）
              • getProjectId()        现有
              • toSafePathSegment()   现有

[domain 路径]  各 domain 自治
              • providers/paths.ts    新建：getConfigPath / getCredentialsPath（多路径 + env 优先级）
              • server/paths.ts       现有：getDefaultPidPath/...（模板）
              • {scheduler/task-store, typeahead/usage-tracker, security/permission-store}.ts
                                      单路径 → 主模块顶部 inline export
              • cli/serve/token.ts + server/client/discovery.ts
                                      不自定义：import server/paths.ts 的 getDefaultTokenPath

[防回归]      monorepo 根 .eslintrc / eslint.config
              • no-restricted-imports + path-based 白名单
              • 白名单 = packages/core/src/paths.ts + packages/test-utils/src/temp-dir.ts
                       （仅此两文件可直接 import node:os homedir/tmpdir 与 node:fs mkdtemp）
```

### 关键设计

#### 命名约定
- `getXxxPath()` — 单文件路径
- `getXxxDir()` — 容器目录
- `expandUserHome(input)` — `~` 展开纯函数

#### env var 优先级（消除两 env var 互不知情）
config / credentials 路径解析按 4 级层叠：
1. caller 显式参数（最高）
2. `ZHIXING_CONFIG_PATH`（精确路径覆盖；credentials 跟其 dirname）
3. `ZHIXING_HOME`（join 子路径）
4. 默认 `os.homedir() + .zhixing`

实现：providers/paths.ts 在 level 3 调用 `getZhixingHome()` —— 一行让两 env var 互通。

#### 测试期 helper 双 API
- `createTempDir(label): Promise<string>` — it-scope，`onTestFinished` 自动清理（现有）
- `createDescribeTempDir(label): { getDir(): string }` — describe-scope，内部 `beforeAll` 创建 + `afterAll` 清理（新增）
- 两者命名形态对偶，区别仅作用域

#### 不引入新概念
- 不建新包
- domain paths 文件按需创建（多路径建文件，单路径 inline export）—— 模式与 `server/paths.ts` 一致
- ESLint 路径白名单写 `.eslintrc` 一处，零 per-line `eslint-disable` 注释

#### 不留 backward-compat shim
- `PathGuard.expandHome` static method 直接删除（不留 wrapper）
- `policy-engine.ts` 内 `expandPath` private 删除
- `cli/serve/token.ts` 与 `server/client/discovery.ts` 的 `DEFAULT_TOKEN_PATH` 局部 const 直接删除

---

## 实施步骤

每 Step 独立可验证、独立可提交。

### Step 1：基础原语
- `core/paths.ts` 加 `expandUserHome(input: string): string`
- 处理 `"~"` / `"~/..."` / `"~\..."` (Windows)，其他原样返回
- 补 unit test

### Step 2：~ 展开 5 处迁移
- `path-guard.ts:144` 删 `PathGuard.expandHome` static
- `path-guard.ts:118` `os.homedir()` 改 `expandUserHome("~")`
- `policy-engine.ts:410` 删 `expandPath` private，调用方改 `expandUserHome`
- `resolve-file-refs.ts:115` / `file-provider.ts:274` / `config-loader.ts:67` 改 `expandUserHome`

### Step 3a：providers 路径中心化
- 新建 `providers/src/paths.ts`：`getConfigPath` / `getCredentialsPath`，4 级优先级
- `providers/credentials-loader.ts` 改调
- `providers/config-loader.ts` 改调（path 解析迁出，业务保留）

### Step 3b：单路径 domain inline export
- `core/scheduler/task-store.ts` 删 `DEFAULT_PATH`，inline export `getSchedulerStorePath()` 走 `getZhixingHome`
- `core/typeahead/usage-tracker.ts` L154 改走 `getZhixingHome`
- `core/security/permission-store.ts` L218 改走 `getZhixingHome`

### Step 3c：token 路径去重
- `cli/serve/token.ts` 删 `DEFAULT_TOKEN_PATH` const，import `@zhixing/server` 的 `getDefaultTokenPath`
- `server/client/discovery.ts` 同上

### Step 4：测试 helper 扩展
- `test-utils/src/temp-dir.ts` 加 `createDescribeTempDir(label): { getDir(): string }`
- `getDir()` 在 `beforeAll` 跑完前调 throw
- 补 unit test

### Step 5：测试文件迁移
- 41 文件 raw `mkdtemp/mkdtempSync` → `createTempDir` 或 `createDescribeTempDir`
- `classifier.test.ts` + `file-provider.test.ts` 走 describe-scope
- 删 `scheduler.test.ts:17` + `pipeline.test.ts:31` 两处 default fallback，参数改必传

### Step 6：ESLint 防回归
- 启用 `no-restricted-imports`
- 路径白名单 = `packages/core/src/paths.ts` + `packages/test-utils/src/temp-dir.ts`
- 启用前确保 Step 1-5 完成（应零 error）

---

## 不在本方案

- `~/.zhixing/server.log` 无 rotation —— daemon 运维问题，独立处理
- `usage-tracker` flush 失败静默吞错 —— observability 问题，独立处理
- `command-analyzer.ts:285-286` 的 `~` token 检测 —— 是分类逻辑不创建资源
- `core/paths.ts:15` 的 `process.env.HOME ?? USERPROFILE ?? "~"` 实现细节 —— 与 `os.homedir()` 行为差异小，本方案不动

## 设计落地引用

- 模板：[`packages/server/src/paths.ts`](../../../packages/server/src/paths.ts)
- 现有原语：[`packages/core/src/paths.ts`](../../../packages/core/src/paths.ts)
- 现有测试 helper：[`packages/test-utils/src/temp-dir.ts`](../../../packages/test-utils/src/temp-dir.ts)
- 涉及 ADR：[`003-config-system.md`](../architecture/decisions/003-config-system.md) (`ZHIXING_CONFIG_PATH` surface 保留)
