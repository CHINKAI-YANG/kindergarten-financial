# 健康幣 HealthVault — 以 FHIR 打造的封閉型健康點數平台

> 走路賺幣・以運動換健康資產。依《健康幣 HealthVault 專案企劃書 v1.0》實作。

使用者每日步行數據，透過 **HL7 FHIR（R4）** 轉譯為可信的健康憑證（`Observation`），
依固定規則發放「健康幣」；健康幣僅能於特約健康商店核銷營養品、醫療輔具等健康物資，
**不可兌換現金、不可轉讓、僅限白名單健康物資**。所有資料以標準 FHIR 資源儲存並上傳至
FHIR R4 伺服器（預設 `https://tzuchi-fhir.ddns.net/fhir`）。

```
穿戴/手機/手環 ──► 4 個操作端（HTML）──► Node.js 後端（兩子系統）──► FHIR R4 伺服器
                                          健康數據引擎 + 錢包服務
```

## 兩個子系統（對應企劃書 4.3 系統架構）

| 子系統 | 職責 | 對應 API |
|--------|------|----------|
| 🧭 **健康數據引擎** | 抓取步數/心率 → FHIR ETL 轉譯 → 防偽檢核 → 產出 `Observation` 憑證 → 發幣 | `/api/engine/*` |
| 👛 **錢包服務** | 管理健康幣帳戶（`Account`）與交易帳本（Ledger），流水帳先行、不可超扣、不可重複入帳 | `/api/wallet/*`、`/api/pos/*` |

## 四個操作端（HTML，對應企劃書四大情境之載具）

| 檔案 | 操作端 | 對應情境 | 說明 |
|------|--------|----------|------|
| `public/app.html` | 📱 **消費者 App** | 情境一、四 | 數位卡、走路賺幣、出示條碼、交易明細、**家屬一鍵凍結** |
| `public/kiosk.html` | 🏘️ **社區節點 Kiosk** | 情境二 | 無手機長者以**手環 UID 批次同步**，大字＋語音的無障礙回饋 |
| `public/pos.html` | 🏪 **特約店 POS** | 情境三、四 | 掃碼核銷健康物資，內建**風控閘道器**；商戶端**匿名**（只見 walletId） |
| `public/admin.html` | 🗂️ **發卡管理端** | — | 註冊使用者、發給虛擬錢包、錢包總覽（需密碼登入） |

## FHIR 資源模型（核心四資源）

| 模組 | FHIR Resource | 用途與防錯 |
|------|---------------|------------|
| 使用者身分 | `Patient` | 真實身分主體；以虛擬 `walletId`（UUID）對外識別（關聯阻斷） |
| 步數憑證 | `Observation`（category `activity`） | 健康數據引擎產出的可信憑證，含步數與心率 component |
| 健康幣帳本 | `Observation`（category `health-coin-ledger`） | 每筆收/支以**帶號值**記錄，餘額＝帳本即時加總（流水帳先行） |
| 健康幣錢包 | `Account`（status `active`/`on-hold`） | 錢包主體；快取餘額/每日計數；凍結＝`on-hold`（FHIR 合法值） |
| 批次同步 | `Bundle`（transaction） | Kiosk 一次上傳多筆步數憑證 |

**數位證據鏈**：`步數 Observation → 發幣帳本（derivedFrom）→ 餘額`、`核銷帳本 → 餘額`，
每筆健康幣皆可回溯至對應的運動數據憑證。

## 經濟模型與防弊（企劃書 6.1／附錄／第七節）

| 規則 | 值 | 落實方式 |
|------|----|----------|
| 發幣匯率 | 1,000 步 = 1 幣（無條件捨去） | `entitledCoins()` |
| 有氧加權 | ×1.2（需心率落在有氧區間佐證，上限 1.2） | 心率 90–160 bpm 判定 |
| 單日發幣上限 | 50 幣 | 應得封頂 |
| 單日消費上限 | 100 幣 | 風控閘道器（靜態載具止損線） |
| 冪等／快照增量 | 每日累計快照，只發增量 | 「應得 − 今日已發」＋帳本冪等鍵，**杜絕同日重複發幣** |
| 防偽門檻 | 單次同步 > 15,000 步/小時 → 拒絕 | `antiFraudCheck()`，阻擋搖手機/外掛 |
| 交易防護 | 不可超扣、不可重複入帳 | **流水帳先行**＋餘額即時重算＋每筆唯一冪等鍵（`identifier`） |
| 載具止損 | 單日限額＋白名單＋家屬通知＋一鍵凍結 | POS 風控 + `/freeze` |
| 個資保護 | 關聯阻斷 | 商戶端只見 `walletId`，永不回傳真實姓名（系統端可追溯） |

## 快速開始

需求：Node.js 18 以上（內建 `fetch` 與 `crypto.randomUUID`）。

```bash
cd healthvault
npm install        # 僅 express
npm start          # 預設 http://localhost:3100
```

開啟瀏覽器：

- 首頁（四端入口）： <http://localhost:3100/>
- 消費者 App： <http://localhost:3100/app.html>
- 社區節點 Kiosk： <http://localhost:3100/kiosk.html>
- 特約店 POS： <http://localhost:3100/pos.html>
- 發卡管理端： <http://localhost:3100/admin.html>（預設密碼 `health1234`）

### 灌入範例資料（建議）

```bash
npm run seed
```

會建立企劃書情境的範例（小明／林阿公／王阿嬤），完成發幣與一筆核銷，
並印出各自的 `walletId`，於消費者 App 貼上即可操作。

> ⚠ **網路需求**：預設 `FHIR_BASE_URL` 指向 `https://tzuchi-fhir.ddns.net/fhir`。
> 請在**能連線該伺服器的電腦**執行 `npm start` / `npm run seed`。
> 若於受限環境（雲端沙箱等）外連被擋，請改用 `npm test`（內建記憶體版 FHIR 跑完整流程），
> 或將 `FHIR_BASE_URL` 指向可連線的 FHIR R4 伺服器。

## 操作流程（對應四大情境）

1. **情境一・上班族即時**：消費者 App 輸入今日累計步數＋平均心率 → 同步發幣（心率達標享 ×1.2）。
2. **情境二・偏鄉長者**：手機族於 App 同步；無手機長者由社區幹事在 **Kiosk** 以手環 UID 批次同步（以 `Bundle` 上傳，大字＋語音回饋）。
3. **情境三・特約店核銷**：POS 掃 `walletId` → 選白名單健康物資 → 核銷扣款（匿名、不顯示姓名）。
4. **情境四・家屬防禦**：卡片遺失時，App **一鍵凍結**（→ `on-hold`）；POS 對凍結帳戶／非白名單品項／超單日上限**自動攔截並通知家屬**。

## 設定（環境變數，皆有預設值）

複製 `.env.example` 為 `.env` 後可覆寫；或直接以環境變數帶入。

| 變數 | 預設 | 說明 |
|------|------|------|
| `PORT` | `3100` | 後端服務埠 |
| `FHIR_BASE_URL` | `https://tzuchi-fhir.ddns.net/fhir` | 目標 FHIR 伺服器 |
| `TENANT_TAG` | `healthvault-demo` | 租戶標記（多人共用伺服器請改唯一字串） |
| `STEPS_PER_COIN` | `1000` | 發幣匯率 |
| `AEROBIC_WEIGHT` | `1.2` | 有氧加權上限 |
| `AEROBIC_HR_MIN` / `AEROBIC_HR_MAX` | `90` / `160` | 有氧心率區間（bpm） |
| `DAILY_EARN_CAP` | `50` | 單日發幣上限 |
| `DAILY_SPEND_CAP` | `100` | 單日消費上限 |
| `ANTI_FRAUD_STEPS_PER_HOUR` | `15000` | 防偽：步/小時上限 |
| `ADMIN_PASSWORD` | `health1234` | 發卡管理端密碼 |
| `CATALOG_JSON` | （內建白名單） | 自訂健康物資白名單（JSON 陣列） |

> **租戶標記**：共用伺服器上所有資源都貼 `meta.tag`（system 為 `http://healthvault.tw/fhir/tenant`），
> 且所有搜尋都以 `_tag` 過濾，只讀寫本平台資料。多人共用同一伺服器時請改成獨一無二的字串。

## 測試

```bash
npm test
```

由於部分雲端環境會阻擋對外連線，測試會啟動一個**本地端記憶體版 FHIR 伺服器**
（`test/mock-fhir-server.js`，模仿 R4 的 CRUD/search/transaction），完整跑過
「同步發幣 → 批次同步 → 核銷 → 風控 → 凍結」流程，並驗證：

- 情境一：8,500 步＋有氧心率 → **9 幣**；無心率 → 8 幣
- 發幣冪等：相同累計快照重送 → 不重複發幣
- 每日快照增量：同日多次同步只補發增量
- 單日發幣上限：超過 → 封頂 50
- 防偽：> 15,000 步/小時 → 拒絕且不入帳
- 情境二：林阿公 5,000 步 → 5 幣；王阿嬤手環批次 35,000 步 → 35 幣
- 情境三：白名單核銷、商戶端匿名（無姓名）、冪等不重複扣款
- 情境四：非白名單／超單日上限／凍結 → 攔截並通知家屬；一鍵凍結＝`on-hold`
- 帳本一致性：餘額＝帳本帶號加總（流水帳先行）

> 目前 39 項斷言全數通過。要對真正的 FHIR 伺服器整合測試，請在能連外網的電腦
> `npm start` 與 `npm run seed`。

## 專案結構

```
healthvault/
├── server.js                  # Express 後端進入點（兩子系統 API + 四端靜態檔 + 健檢）
├── public/
│   ├── app.html               # 消費者 App
│   ├── kiosk.html             # 社區節點 Kiosk（無障礙）
│   ├── pos.html               # 特約店 POS（匿名 + 風控）
│   └── admin.html             # 發卡管理端
├── src/
│   ├── config.js              # 設定與 FHIR 命名常數、經濟模型參數
│   ├── fhirClient.js          # FHIR REST 客戶端（租戶標記 / _tag / transaction Bundle）
│   ├── mappers.js             # domain ↔ FHIR（Patient/Observation/Account）轉換
│   ├── services/
│   │   ├── minting.js         # 發幣規則（匯率/加權/上限/防偽）
│   │   ├── wallet.js          # 錢包與帳本（流水帳先行、餘額重算、冪等、核銷、凍結）
│   │   ├── catalog.js         # 健康物資白名單
│   │   └── notify.js          # 家屬即時通知
│   └── routes/
│       ├── users.js           # /api/users   發卡與使用者管理（需授權）
│       ├── engine.js          # /api/engine  健康數據引擎（sync / batch-sync）
│       ├── wallet.js          # /api/wallet  錢包查詢 / 凍結 / 通知
│       └── pos.js             # /api/pos     特約店核銷（匿名 + 風控）
├── scripts/seed.js            # 灌入四大情境範例
└── test/
    ├── mock-fhir-server.js    # 本地端記憶體版 FHIR（測試用）
    └── run.js                 # 端對端測試（39 項斷言）
```

## 模型化備註

- 企劃書的「交易帳本（Ledger）」在 FHIR R4 無原生資源；本系統以 `Observation`
  （category `health-coin-ledger`、帶號 `valueQuantity`）逐筆記錄，**餘額一律由帳本即時加總**，
  `Account` 上的 `balance` 僅為顯示快取——決策（核銷、上限）不依賴快取，符合「流水帳先行」。
- 無資料庫列鎖的 FHIR 環境下，以**每筆交易唯一冪等鍵（`identifier`）＋寫入前查重＋餘額即時重算**
  落實「不可重複入帳、不可超扣」。
- 隱私採關聯阻斷：商戶端 API（`/api/pos/*`）一律只回 `walletId` 與餘額/狀態，永不回傳真實姓名。
- 合規定位（封閉型點數）：健康幣無「兌現/轉帳/轉讓」出口，鑄造唯一來源為步數憑證，僅限白名單核銷。
  ⚠ 是否涉及《電子支付機構管理條例》等登記義務，須由法律顧問就實際營運模式確認。
