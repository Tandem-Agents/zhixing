# 首发准备问题（临时草稿）

## 一、待讨论问题

以下事实核对于 2026-11-10，代码基线为 `b277d113`。各项的具体原因、处理必要性与方案待逐项讨论。

1. **工程检查已恢复通过（2026-11-11）。** 原 63 条 S7 结构失败都是没跟上已验收重构的过时断言，没有需要改产品代码的真实违规；Biome 的 51 条也已修复。在不带任何依赖和构建产物的隔离副本里，按锁文件安装依赖、执行 `pnpm lint:prepare` 后，完整 `pnpm lint` 通过。新增的 [质量门禁工作流](../../.github/workflows/quality-gate.yml) 已就绪，尚未在 GitHub 上实际运行。详见首发清单 R01。[检查入口](../../scripts/s7-entry-coverage.mjs)

2. **候选验收与正式推广连在一起。** 发布脚本完成版本、完整性及 `--version`、`--help` 检查后，立即将 CLI 提升为 `latest`，没有候选实际使用验收的停点。[发布脚本](../../scripts/publish-npm.mjs)

3. **正式跨平台制品与验收尚未齐备。** 当前待打包目录只有 Windows x64 制品，其清单标记 `verifiedArchives=false`，不满足正式制品检查；现有五目标交付工作流没有运行记录。已声明支持的 macOS、Linux 等目标仍需对应的发行制品与验收依据。[制品检查](../../scripts/package-check.mjs)、[交付工作流](../../.github/workflows/platform-delivery.yml)、[支持范围](../delivery/releases/0.1.0.md)

4. **私密漏洞反馈入口尚未启用。** 当前 GitHub 私密漏洞报告开关为关闭状态，项目安全政策也未提供其他私密接收渠道；现有首发要求将这一入口列为发布前提。[安全政策](../../SECURITY.md)、[GitHub 当前设置查询](https://api.github.com/repos/Tandem-Agents/zhixing/private-vulnerability-reporting)
