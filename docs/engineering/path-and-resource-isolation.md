# 路径解析与资源隔离

## 目的与约束

避免同一数据位置被多处独立拼接，导致配置与运行数据分流、测试写入真实用户目录或资源残留。路径规则必须有唯一归属，临时资源创建必须绑定清理责任；不能仅靠调用方记住约定。

同一领域资源的路径在一处定义，消费者复用该入口。公共数据根与 `~` 展开使用共享原语，领域决定自己的子目录与文件名，不把所有业务路径集中成一个全局目录表。替换重复实现时不留下无必要的兼容包装；必要存储参数不以隐式临时文件兜底。

## 三层职责与当前实现

| 层次 | 职责与实现 |
|---|---|
| 共享原语 | [core/paths.ts](../../packages/core/src/paths.ts)提供 `getZhixingHome`、`expandUserHome` 及目录段编码／还原，避免各处自行解释数据根、家目录与逻辑标识 |
| 领域路径 | [providers/paths.ts](../../packages/providers/src/paths.ts)负责公开配置路径，[server/paths.ts](../../packages/server/src/paths.ts)负责宿主文件路径；多路径按需建立领域 paths 文件，单路径可由所属模块导出，不另建通用包 |
| 防回归 | [biome.json](../../biome.json)集中限制底层路径 API 导入，豁免基础原语与测试目录 helper；不能以逐行抑制代替路径归属 |

`getXxxPath` 表示文件路径，`getXxxDir` 表示容器目录。路径解析与创建资源是不同职责，取得路径不等于目录已存在，也不等于获得访问授权。

当前 `getZhixingHome()` 优先返回 `ZHIXING_HOME`，否则由 `HOME`／`USERPROFILE`／`~` 与 `.zhixing` 拼接；不能将其描述为总是调用 `os.homedir()` 或保证返回规范化绝对路径。`expandUserHome()` 使用 `os.homedir()` 展开 `~`、`~/`、`~\`，其他输入原样返回，包括 `~user`；它不是任意相对路径解析器。

领域入口须贯穿实际消费者。例如 CLI token 写入与 server 连接发现共用 `getDefaultTokenPath()`，不能各自定义同名默认常量。公开配置的显式参数与环境变量优先级由[配置架构](../modules/configuration/architecture.md#来源与路径)唯一说明；秘密已由[设备本地 SecretStore](../modules/secrets/architecture.md)承担，不恢复旧 credentials 文件路径接口。`ZHIXING_CONFIG_PATH` 是配置文件覆盖，不等于自动重定位所有领域数据；测试不能只改这一变量就认定整套运行数据已隔离。

## 测试临时资源

[测试目录 helper](../../packages/test-utils/src/temp-dir.ts)将创建与清理注册绑定，不要求调用方另记一次 cleanup：

| 用途 | API | 生命周期 |
|---|---|---|
| 单测试目录 | `createTempDir(label)` | 创建后通过 `onTestFinished` 注册清理；注册失败时尝试删除已建目录并抛错 |
| 多测试共享目录 | `createDescribeTempDir(label)` | 在 describe 层注册 `beforeAll` 创建、`afterAll` 清理；通过 `getDir()` 访问，尚未创建或已清理时抛错 |

目录位于系统临时目录，统一前缀为 `zhixing-test-{label}-`；label 只接受小写字母、数字与连字符。共享目录使用第二种 API，不把单测试 helper 放进 `beforeAll`。测试还必须将所需数据根或显式存储路径指向隔离目录，创建临时目录本身不会重定向产品默认路径。

自动清理不保证绝无残留：正常清理失败会警告但不使测试失败；注册失败后的补偿删除错误被忽略，进程被强制终止也可能无法执行 hook。文件句柄或子进程必须由其所有者释放，目录 helper 不能代替进程树及业务资源生命周期治理。

## 防回归边界与核对

当前使用 Biome `noRestrictedImports`，不是旧稿中的 ESLint：在配置覆盖的 `packages/**/*.ts` 与 `playground/**/*.ts` 内限制 `node:os` 的 `homedir`／`tmpdir`、`node:fs/promises` 的 `mkdtemp` 和 `node:fs` 的 `mkdtempSync` 导入。规则仅对 `packages/core/src/paths.ts` 与 `packages/test-utils/src/temp-dir.ts` 关闭，根 `lint` 命令包含 `biome check .`。

这是导入约束，不是任意路径表达式或资源泄漏检测器；不能据规则存在宣称所有文件、所有调用形式或运行行为都被强制覆盖。核对本领域时应检查路径定义与读写消费者是否一致、隔离覆盖是否真正传入、临时资源是否绑定正确作用域，以及清理失败是否可见。原语与 helper 的直接用例分别见[路径测试](../../packages/core/src/__tests__/paths.test.ts)和[临时目录测试](../../packages/test-utils/src/__tests__/temp-dir.test.ts)。

日志轮转、业务存储保留策略、授权及进程关闭各归所属模块，路径和临时目录 helper 不承担这些生命周期职责。
