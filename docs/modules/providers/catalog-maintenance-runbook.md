# 官方模型目录维护、TUF 可信发布与周期续签手册

本手册规定 `catalog-v1` 官方模型目录通道的托管入口、密钥边界、首次上线根仪式、日常采集审阅发布、6 小时周期续签、离线双阈值根轮换与兼容通道退出流程（对应设计第 4.1、4.2 节）。

## 1. 权威资产与托管布局

| 资产 | 位置 | 职责 |
| --- | --- | --- |
| 单一策展基线（源码与规范 JSON） | `packages/providers/src/catalog/builtin-catalog.ts` ↔ `catalog/v1/curated-catalog.json` | 单一事实源；由 `catalog-maintenance.mjs check-sync` 与单测强制零漂移 |
| 官方上游采集清单 | `catalog/v1/upstream-sources.json` | 声明式公开上游来源（零密钥；可选只读令牌经环境变量传入） |
| 随包官方仓库与引导根 | `packages/providers/src/catalog/tuf/default-repository.ts` | 绑定 `origin/catalog-v1` 静态地址与公开 Ed25519 初始根（不含私钥） |
| 维护与签名 CLI | `scripts/catalog-maintenance.mjs` | `check-sync`、`collect`、`validate`、`diff`、`init-ceremony`、`publish-local`、`renew-local`、`rotate-root-local` |
| 自动化验证与续签工作流 | `.github/workflows/catalog-maintenance.yml` | PR 同步/兼容校验、6 小时周期续签与人工复核发布 |

托管入口（按主 `catalogSchemaVersion` 独立分通道）：

- 静态分支：`https://github.com/Tandem-Agents/zhixing` 孤立分支 `catalog-v1`
- Metadata：`https://raw.githubusercontent.com/Tandem-Agents/zhixing/catalog-v1/metadata`
- Targets：`https://raw.githubusercontent.com/Tandem-Agents/zhixing/catalog-v1/targets/catalog-v1.json`

## 2. 密钥分离原则（TUF 1.0.37 受限四角色）

- **离线根私钥（`root`）**：仅由维护者离线冷存（`root-key.offline.json`），**绝不上传至 Git、CI Secrets 或运行主机**；仅在首次仪式与双阈值根轮换时本机离线使用。
- **在线三角色密钥（`timestamp`、`snapshot`、`targets`）**：存放于 GitHub Actions 受控 Secret `CATALOG_TUF_ONLINE_KEYS_JSON`（`online-keys.ci-secret.json`），用于 6 小时自动续签与经人审批准后的目录签发。

## 3. 首次开通官方 `catalog-v1` 通道（须维护者显式授权推送与配密）

1. **构建并同步单一策展源**：
   ```bash
   pnpm --filter @zhixing-ai/providers... run build
   node scripts/catalog-maintenance.mjs check-sync catalog/v1/curated-catalog.json
   ```
2. **本机离线执行四角色根仪式**（目标目录与密钥目录均放在仓库外临时/加密目录）：
   ```bash
   node scripts/catalog-maintenance.mjs init-ceremony /tmp/zhixing-catalog-v1 /secure/zhixing-tuf-keys --catalog catalog/v1/curated-catalog.json
   ```
3. **更新随包引导根并离线封存根私钥**：
   - 将 `/secure/zhixing-tuf-keys/bootstrap-root.snippet.txt` 完整写入 `packages/providers/src/catalog/tuf/default-repository.ts` 的 `OFFICIAL_BOOTSTRAP_ROOT_JSON`；
   - 离线封存 `/secure/zhixing-tuf-keys/root-key.offline.json`（确认不在任何 Git 工作区中）；
   - 将 `/secure/zhixing-tuf-keys/online-keys.ci-secret.json` 写入仓库 Secret `CATALOG_TUF_ONLINE_KEYS_JSON` 后安全删除临时副本。
4. **经用户显式授权推送 `origin/catalog-v1` 孤立分支**：
   ```bash
   cd /tmp/zhixing-catalog-v1
   git init -b catalog-v1
   git add metadata targets
   git commit -m "chore(catalog-v1): initialize TUF 1.0.37 v1 official catalog repository"
   git remote add origin https://github.com/Tandem-Agents/zhixing.git
   git push origin catalog-v1
   ```
5. **真源上线验签**：运行 `ModelCatalogManager`（默认官方源）确认 `https://raw.githubusercontent.com/Tandem-Agents/zhixing/catalog-v1/metadata/timestamp.json` 返回 HTTP 200 且端到端验签激活成功。

## 4. 日常更新流（事实采集 → 人审差异 → 批准发布）

1. **采集与生成审阅单**（按需设置公开/只读 API 环境变量；无可靠机器列表的服务商如 GLM / MiniMax 有证据地手工维护）：
   ```bash
   node scripts/catalog-maintenance.mjs collect catalog/v1/curated-catalog.json catalog/v1/upstream-sources.json /tmp/catalog-review --revision 2026.12.01-r1
   ```
2. **人工复核**：
   - 审阅 `/tmp/catalog-review/review-diff.md`（事实目录变更与用途推荐变更严格分栏，确认事实更新未顺带改动推荐）与 `compat-report.json`；
   - 将核实后的变更同步更新至 `packages/providers/src/catalog/builtin-catalog.ts` 并运行 `node scripts/catalog-maintenance.mjs export-builtin catalog/v1/curated-catalog.json`、`check-sync` 与单测后合入主干。
3. **批准发布（统一内容绑定合同）**：
   - 生成覆盖全部运行与用户语义字段的审阅单，并计算**绑定实际基线 + 实际候选 + 差异单**的唯一批准摘要 `approvalDigest`（CLI、CI 工作流与本手册共用同一 `computeCatalogReviewBinding` / `verifyCatalogReviewBinding` 合同；基线或候选发生哪怕单个字段变动都会使旧批准摘要失效）：
     ```bash
     node scripts/catalog-maintenance.mjs diff <current-catalog-v1.json> catalog/v1/curated-catalog.json
     node scripts/catalog-maintenance.mjs review <current-catalog-v1.json> catalog/v1/curated-catalog.json
     ```
   - 在 GitHub Actions 手动触发 `catalog-maintenance.yml`（`action=publish`，填入上一步输出的 `binding.approvalDigest` 作为 `review_digest`），或在本机传给 `publish-local --approved-review <digestFile|bindingJson|hex>`；工作流将在核验内容绑定并签发后自动启动本机 HTTP `ModelCatalogManager` 验签冒烟，通过后再推送 `catalog-v1`。
   - 基线约束：对已初始化仓库，`publish-local` 始终以仓库当前实际 `targets/catalog-v1.json` 为唯一真实基线（目标缺失或损坏一律失败关闭）；显式 `--base` 仅作一致性断言，不得取代当前目标绕过基线漂移检查，仅在首次初始化空白仓库时用于指定初始对照基线。

## 5. 6 小时周期续签与异常纠错

- **防冻结续签**：`.github/workflows/catalog-maintenance.yml` 每 6 小时执行 `renew-local --if-due`，仅递增在线 `timestamp/snapshot/targets` 版本与过期时间，**绝不改动 `targets/catalog-v1.json` 原始字节或任何型号的 `verifiedAt` 日期**；续签失败仅阻止接纳新候选，不影响客户端既有本地目录使用。
- **错误内容纠错**：保留正确历史条目，以更高 `catalogRevision` 重新走审阅与发布流程，使已接纳客户端前滚至修复修订。

## 6. 离线双阈值根轮换（vN → vN+1）

当根证书临期、例行轮换或在线密钥泄露需撤销时，由维护者在本机离线执行：

```bash
node scripts/catalog-maintenance.mjs rotate-root-local /tmp/zhixing-catalog-v1 \
  --old-root-key /secure/zhixing-tuf-keys/root-key.offline.json \
  --out-keys /secure/zhixing-tuf-keys-v2
```

- 保留所有历史 `<1..N>.root.json` 不删改，新增由旧根与新根双签的 `<N+1>.root.json`；
- 同步更新 GitHub Secret `CATALOG_TUF_ONLINE_KEYS_JSON` 为 `online-keys-v<N+1>.ci-secret.json`，离线封存新根并推送 `catalog-v1`；
- 旧客户端（即便随包旧根 v1 已过期）可通过 TUF 1.0.37 连续双阈值根链无缝轮换至新根。

## 7. 旧兼容通道三步退出条件

停止维护某旧主 schema 通道（如未来迁至 `catalog-v2`）须满足三步条件：

1. 在发布说明中明示最低支持知行版本与过渡窗口；
2. 在原通道最后一个签名修订中写入可识别的 `upgradeNotice` 字段，告知客户端升级原因与最低版本；
3. 过渡期满后再停止该通道的周期续签（旧客户端停更后仍可安全继续使用本地已接纳缓存或随包基线）。
