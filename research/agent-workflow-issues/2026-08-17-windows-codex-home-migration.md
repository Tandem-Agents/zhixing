# Windows Codex 状态目录迁移记录

## 一、问题背景

Codex 默认把状态数据存放在系统盘，其中 session 文件 `rollout-2026-07-14T14-49-48-019f5f63-7c8d-73e3-8583-59635a4e58d3.jsonl` 已膨胀至 2.098 GiB 且仍会增长，导致 C 盘容量告急；

因此需要把整个 `.codex` 状态目录迁至非系统盘，保留原路径兼容，并在确认历史数据和新会话均可正常读写后删除旧副本。

## 二、迁移全过程（按时间顺序）

1. **方案评审与只读预检**：核验 Codex 所出方案的前提——源 7709 文件 / 3.65 GiB、目标与备份名未占用、`CODEX_HOME`/`CODEX_SQLITE_HOME` 皆空、E 盘余量充足；判定可行，并自加两项校验：目录数对比、复制后 ACL 对比。
2. **停机确认**：用户退出 Codex，复查无任何 codex/chatgpt 进程后开工（执行者非 Codex，Codex 全程关闭，全程不读凭证与会话正文）。
3. **复制（10:51–10:52）**：`robocopy /E /COPY:DAT /XJ`，7709 文件 3.652 GiB 零失败。关键特征：`/COPY:DAT` 不带 ACL、`/XJ` 跳过 junction，两笔欠账事后补。
4. **ACL 收紧（计划外增补）**：目标继承 E 盘根权限（`Authenticated Users: Modify`、`Users: Read`），比源宽，登录与会话数据对本机所有用户暴露。处置：目标根断继承、按源根重建 4 主体（SYSTEM/Administrators/lenovo FullControl + CodexSandboxUsers RX）、全树 `/reset` 传播、补齐 7 处特殊显式 ACE（`.sandbox` 权限组、`.sandbox-secrets` 的 Deny、3 个 visualization 目录的失效 SID——icacls 解析不了失效 SID，改用 .NET `SecurityIdentifier` 直接授权）；被 `/XJ` 跳过的 junction `chrome\latest` 手工重建并改指 E 盘。终验：全树 11069 项有效 ACL 与源逐项 0 差异。
5. **完整性校验**：SHA-256 清单 7709 文件、目录 3359，两侧完全一致。
6. **切换**：设用户级 `CODEX_HOME=E:\AppData\Codex`（后纠偏为 `E:\App_Data\Codex`），读回注册表确认。
7. **源目录改名受阻（插曲一）**：报 Win32 错误 5。逐层观测排除：树内文件可改名、无 codex 进程、Defender/索引器空闲、Restart Manager 无权限枚举；最终用 `Shell.Application` COM 枚举发现**一个资源管理器窗口停在 `.codex\sessions\...` 目录内**持柄阻挡，优雅关闭该窗口即改名成功（备份名 `.codex.before-migration-20260817`），未强杀任何进程。
8. **路径纠偏（插曲二）**：发现 E 盘本有 `App_Data` 约定目录，计划假定的 `E:\AppData` 系新建撞名。同卷移至 `E:\App_Data\Codex`、更新环境变量、按新路径重建 junction、删空壳；移动后复核（计数、全树 ACL、junction 可达）全过。
9. **重启验收报错（12:03 重启后首开桌面端）**：启动恢复历史对话报 `failed to resolve rollout path 'C:\Users\lenovo\.codex\sessions\...jsonl': file does not exist`，点开任何旧会话皆然。排查：重启后 E 盘新写入 48 个文件、C 旧路径未被重建 → `CODEX_HOME` 已生效，排除"配置没生效"；报错会话文件在 E 盘完好。根因：桌面端状态库 `state_5.sqlite` 的 `threads.rollout_path` 把 **31/31 条历史会话**（副库另 5 条，其中 3 条归档引用迁移前已失效）全部存死旧绝对路径，恢复功能按库找文件——迁移遗留的绝对路径引用，非数据丢失。
10. **报错处置**：三案中选零数据风险方案——建目录联接 `C:\Users\lenovo\.codex` → `E:\App_Data\Codex`（junction ACL 按旧根复制，含 CodexSandboxUsers RX），一处联接覆盖全部 36 条存量引用及未来任何忽略环境变量的组件；验证 31 条会话经旧路径全部可解析。未采纳项：改 sqlite 换前缀（干净但有写库风险）、放任不管（31 条历史全废）。
11. **收尾状态**：迁移完成、功能恢复；回滚副本保留观察，删除须用户再次明确确认。

三条教训：①迁目录不能只对文件内容——ACL、junction、失效 SID 都需逐项补齐，验收标准是"全树有效 ACL 逐项相等"；②**绝对路径是迁移的隐性债务**——状态库存的路径不随 `CODEX_HOME` 自动迁移，junction 是成本最低的兜底；③文件占用受阻时用 Win32 错误码 + COM 枚举逐层观测定位持柄者，不猜、不强杀。

## 三、旧副本清理

迁移验收通过后，旧副本 `C:\Users\lenovo\.codex.before-migration-20260817` 因不再参与运行、也不会继续同步最新状态而被删除，以免继续占用系统盘；删除前先移除其内部指向现用数据的插件缓存 junction，避免递归清理误触 E 盘数据。保留 `E:\App_Data\Codex` 作为唯一真实状态目录，同时保留 `C:\Users\lenovo\.codex` → `E:\App_Data\Codex` 的 junction 作为旧绝对路径的兼容入口；该入口不保存第二份数据，删除它会使仍引用旧路径的历史会话再次无法打开。

## 四、最终效果

`.codex` 下现有及未来新增的历史会话等状态数据均实际存放在 E 盘，不再以实体文件占用 C 盘；C 盘仅保留兼容入口，经该入口产生的新数据仍会写入 E 盘。
