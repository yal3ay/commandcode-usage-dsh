# commandcode-usage-dsh

**在 DeepSeek Harness 的「設定」對話框裡看 Command Code 方案的使用量。**

把 [commandcode.ai/&lt;user&gt;/settings/usage](https://commandcode.ai) 那張用量卡搬進 DSH：
Host 半每 30 秒讀一次 Command Code 的計費介面，瀏覽器半用官方的
`settings.section` 插槽渲染成一個設定頁（5 小時窗口、每週窗口、每月額度、
重設倒數與方案名稱）。API key 只在 Host 行程內使用，不會經過任何 RPC。

## 功能

| 能力 | 說明 |
| --- | --- |
| 5 小時窗口 | 已用金額 / 上限、已用百分比、重設倒數與進度條 |
| 每週窗口 | 同上，7 天滾動窗口 |
| 每月額度 | 本期已用 / 方案額度、剩餘額度、加購與贈送額度、計費週期結束日 |
| 方案與帳號 | `whoami` 的顯示名稱、email、方案（Go / GOAT / Pro / Max / Team Pro） |
| 雲端沙盒 | 方案含沙盒分鐘數時一併顯示用量 |
| 自動更新 | Host 每 30 秒輪詢；倒數計時另外每 30 秒自行刷新 |
| 手動刷新 | 卡片右上角「刷新」，先叫 Host 立即重讀再取快照 |
| 主題相容 | 全部用行內樣式與 `rgba(128,128,128,…)` 中性色，深/淺色主題皆可讀 |
| 憑證安全 | key 由 `ctx.credentials` 在 Host 端解析，僅百分比 / 金額 / 重設時間過 Remote |

## 資料來源

Host 半打的是官方 CLI `/usage` 用的同一組私有計費路由（`https://api.commandcode.ai`）：

```
GET /alpha/whoami                 → { user, org }
GET /alpha/billing/credits        → { credits, windowLimits, sandboxMinutes }
GET /alpha/billing/subscriptions  → { data: { planId, status, currentPeriodEnd } }
```

- 需要 `user_…` 形式的 Command Code API key（就是 Provider API 用的那把）。
- 只有 `credits` 是必要的；`whoami` 失敗只影響名稱，`subscriptions` 失敗只影響方案列。
- 這是純帳號狀態查詢，不消耗額度。
- 每月額度：優先讀 API 回報的 grant；沒回報時用方案目錄（Go 10 / GOAT 70 /
  Pro 80 / Max 10× 150 / Max 20× 300 / Team Pro 40）換算。

## 前置條件

- DeepSeek Harness 0.2.0-rc.2（Desktop 或 Web profile）。
- 已配置 Command Code 憑證，二選一：
  - DSH 憑證裡有 `COMMANDCODE_API_KEY`（本 profile 就是這樣）；或
  - profile 的 `llm-pi-ai.providers` 有 `commandcode` provider（會一併沿用它的
    `apiKeyEnv` 與 `baseURL` 來源）。
- 本機能連上 `https://api.commandcode.ai`。

## 安裝

從 GitHub 直接安裝（最省事，日後 `dsh plugin update` 也能跟著更新）：

```bash
dsh plugin --profile <profile> add github:yal3ay/commandcode-usage-dsh
```

用 DSH 的外掛頁安裝，或裝本地目錄：

```bash
dsh plugin --profile desktop add /絕對路徑/commandcode-usage-dsh
```

`install_bundle` / `dsh plugin add` 會處理依賴，並把 `commandcode-usage-dsh`
加進 `dsh.profile.bundles`；套件內附的 `cordis.patch.yml` 插入宿主插件行。

重啟該 profile（沒有開 HMR 時），重新載入頁面，打開
**設定 → Command Code 用量**。

若不想改 bundle 清單，也可以只把下面兩行加進
`~/.dsh/profiles/desktop/cordis.patch.yml`：

```yaml
- insert:
    - id: commandcode-usage-dsh
      name: 'commandcode-usage-dsh'
```

## 驗證

```bash
node test/smoke.mjs
```

- Host 半：若環境或 `$DSH_HOME/.credentials.yaml` 有 `COMMANDCODE_API_KEY`，
  會**直接打真實**的 billing 介面並檢查窗口、額度、方案與重置時間；沒有憑證時
  改用樁資料，因此可離線執行。
- 瀏覽器半：在假 `window.__ModuleLoader__` 裡載入 `lib/client.js`，驗證
  `settings.section` 註冊、Remote 讀取、渲染文字與刷新流程。

## 運作原理

```
設定頁 (browser)                        Host 行程
  │                                        │
  ├─ ctx.remote.$mount(descriptors) ───────┤  Typert Remote namespace `commandcodeUsage`
  ├─ namespace.snapshot()  ───────────────▶├─ 30s 輪詢
  ├─ namespace.refresh()   ───────────────▶│   GET https://api.commandcode.ai/alpha/whoami
  │                                        │   GET https://api.commandcode.ai/alpha/billing/credits
  ◀── { user, plan, credits, windows, … } ─┤   GET https://api.commandcode.ai/alpha/billing/subscriptions
```

- 憑證店是非同步載入的，第一次輪詢可能跑在它前面；Host 半會在啟動後
  ~1.2s / ~4s 各補一次輪詢，所以第一畫面就能拿到額度，而不是等 30 秒。
- 進度條顏色：已用 ≤ 60% 綠、61–85% 琥珀、> 85% 紅。

## 解除安裝

```bash
dsh plugin --profile desktop remove commandcode-usage-dsh
```

再從 profile 的 `dsh.profile.bundles` 或 `cordis.patch.yml` 移除對應條目（用 GUI
外掛頁安裝的，在那裡停用／移除即可）。

## 已知限制

- `/alpha/*` 是官方 CLI 自用的私有路由，不是公開的 Provider API 合約；Command Code
  改路徑時本外掛會顯示錯誤訊息（不會退回假資料）。
- 只給金額與百分比，沒有逐模型明細；要明細請開網頁用量頁（設定頁會顯示網址）。
- 目前一次只讀一把 key／一個帳號。
- 此套件為社群外掛，非 DeepSeek 或 Command Code 官方維護。

## 授權

MIT
