# @zhixing/test-utils

知行 monorepo 内部测试基础设施 —— 不发布，只被各 package 的 `*.test.ts` 通过 `import { ... } from "@zhixing/test-utils"` 使用。

## API

### `createTempDir(label)`

Fail-safe 临时目录管理：创建一个 `os.tmpdir()/zhixing-test-{label}-XXXXXX` 目录，**测试结束后自动清理**，调用方拿到的只有目录路径。

```ts
import { createTempDir } from "@zhixing/test-utils";

it("某个用例", async () => {
  const dir = await createTempDir("skill");
  // 用 dir 做磁盘 I/O ……
  // 测试结束后 helper 内部已注册 cleanup，无需手写 afterEach
});
```

#### 调用约束

必须在 vitest 测试上下文内（`it` / `test` / `beforeEach` / `afterEach`）调用。

**不能在 `beforeAll` / `afterAll` / `describe` 顶层调用** —— 那些上下文没有"当前 test"概念，`onTestFinished` 没法注册。误用时本函数会主动清理已创建的目录并抛 user-friendly 错误，不会让 helper 自身造成 leak。

跨 test 共享 tmpDir（`beforeAll` 创建一次给所有 it 用）继续使用经典模式：

```ts
let dir: string;
beforeAll(async () => {
  dir = await fs.mkdtemp(/* ... */);
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});
```

`createTempDir` 不试图覆盖该场景。

#### Cleanup 失败语义

`rm` 失败（如 Windows 文件锁）会 `console.warn` 但**不破坏测试通过状态** —— 让开发者看到系统性问题，但偶发失败不会让 CI 红；OS 临时目录回收策略兜底偶发遗留。

## 设计取舍

### Prefix 命名空间

所有临时目录前缀统一为 `zhixing-test-{label}-`：

- 与运行时数据 `~/.zhixing` 的命名空间清晰区分
- 一刀清理友好：`rm -rf $TEMP/zhixing-test-*` 

### `label` 强制 kebab 格式

`label` 必须匹配 `[a-z0-9-]+`，否则立即抛错。这是为了：

- 防止 prefix 风格分裂回到混乱（旧代码有 `zhixing-X-test-` / `X-test-` / `X-` 各种风格）
- 让 grep / 一刀清理等运维操作有可预期的目录命名

## 何时用 `createTempDir` vs 经典模式

| 场景 | 推荐 |
|---|---|
| 新写测试 | 首选 `createTempDir` —— fail-safe，不可能漏 cleanup |
| 已有用 `beforeEach + afterEach + fs.rm` 模式的测试 | 不强迫迁移 —— 功能已正确，迁移收益 < 风险 |
| 跨 test 共享 tmpDir（`beforeAll` 模式） | 继续用经典 `beforeAll + afterAll + fs.rm` |
