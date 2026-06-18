# 晨光幼兒園 — FHIR 智慧行政：出勤打卡與薪資核銷一體化系統

以 **HL7 FHIR（R4）** 國際醫療資訊標準打造的幼兒園人事出勤與發薪解決方案。
依《FHIR 智慧行政建置計畫書》實作，將「排班 → 打卡 → 結算 → 簽核 → 撥款」全流程數位化，
所有資料皆以標準 FHIR 資源儲存並上傳至 **HAPI 公開測試伺服器** `https://hapi.fhir.org/baseR4/`。

```
員工/會計 ──► 2 個 HTML 操作端 ──► Node.js 後端 ──► HAPI FHIR baseR4
```

## 兩個操作端（HTML）— 對應計畫書「雙系統架構」

| 檔案 | 操作端 | 對應角色 | 說明 |
|------|--------|----------|------|
| `public/clock.html` | 🕒 **員工打卡端** | 員工 | 現場點名簽到/簽退、自動換算十進位工時、查詢本人出勤。**不顯示任何薪資與他人資料（權限分流）。** |
| `public/admin.html` | 📊 **會計室核銷端** | 會計／園長 | 人事、排班、出勤稽核與補登、月底結算、線上簽核、產生核銷清冊與合庫媒體撥款檔。 |

## FHIR 資源模型（七項核心資源）

| 系統模組 | FHIR Resource | 核心防錯機制 |
|----------|---------------|--------------|
| 人事資料 | `Practitioner` | 依本薪自動判定薪資模式（>0 月薪制／=0 純時薪） |
| 可排範圍 | `Schedule` | 定義人員可被排班的時間範圍 |
| 可排時段 | `Slot` | 標記 free/busy，避免重複排班 |
| 排班預約 | `Appointment` | 預約佔用時段 |
| 簽到退打卡 | `Encounter` | 依打卡時間自動換算十進位工時 |
| 會計結算 | `Claim` | 工資必須綁定出勤證據，否則阻斷 |
| 園長發薪 | `ClaimResponse` | 核准後自動生成銀行媒體檔 |

**數位證據鏈**：`Schedule/Slot → Appointment → Encounter → Claim → ClaimResponse → 合庫媒體撥款`，
每筆薪資皆可向上回溯至對應出勤與排班紀錄（透過 FHIR 資源間的 reference 與 `Claim.supportingInfo`）。

## 快速開始

需求：Node.js 18 以上（已用 v22 測試）。

```bash
npm install          # 安裝相依套件（僅 express）
npm start            # 啟動後端，預設 http://localhost:3000
```

開啟瀏覽器：

- 首頁（入口）： <http://localhost:3000/>
- 員工打卡端： <http://localhost:3000/clock.html>
- 會計室核銷端： <http://localhost:3000/admin.html>

### 灌入範例資料（建議）

```bash
npm run seed
```

會在 HAPI 伺服器建立計畫書情境 A／B 的範例（含排班與整月出勤）。
完成後到「會計室核銷端 → 月底結算」即可直接看到：

- 王曉明（月薪制）實發 **NT$43,640**
- 陳小美（純時薪）實發 **NT$8,645**

## 操作流程（對應計畫書四大情境）

1. **人事資料**：新增員工（可按「填入情境A／B」快速套用範例）。本薪填 0 即自動切換純時薪制。
2. **排班**（情境 A）：建立 `Schedule` → 新增 `Slot` → 預約 `Appointment`（時段自動轉 busy）。
3. **打卡**：於員工打卡端選擇姓名與工作類別（正常班／課後延護／行政加班）後簽到、簽退。
4. **出勤稽核**（情境 D）：未簽退者標記為「缺簽退」異常，可一鍵補登簽退，工時自動重算。
5. **月底結算**（情境 A／B）：選人員與期間後結算；**若有缺簽退會阻斷並列出待修正清單**。月薪制／純時薪由系統自動裁決。
6. **簽核發薪**：園長核准 → 建立 `ClaimResponse`；可「列印核銷清冊」（列印時自動隱藏操作按鈕，僅保留財務總表）。
7. **撥款媒體檔**（情境 C）：一鍵下載合作金庫媒體轉帳檔 `salary.txt`（格式：銀行代碼＋帳號＋金額＋姓名）。

## 設定（環境變數，皆有預設值）

複製 `.env.example` 為 `.env` 後可覆寫；或直接以環境變數帶入。

| 變數 | 預設 | 說明 |
|------|------|------|
| `PORT` | `3000` | 後端服務埠 |
| `FHIR_BASE_URL` | `https://hapi.fhir.org/baseR4` | 目標 FHIR 伺服器 |
| `TENANT_TAG` | `morninglight-kg-demo` | 租戶標記（見下） |
| `CURRENCY` | `TWD` | 幣別 |
| `BANK_CODE` | `006` | 合作金庫銀行代碼 |

> **關於公開伺服器與租戶標記**：`hapi.fhir.org` 是全球共用的測試伺服器。
> 本系統將每一筆資源都貼上 `meta.tag`（system 為 `http://morninglight.kindergarten/fhir/tenant`），
> 且所有搜尋都以 `_tag` 過濾，因此只會讀寫「本園」資料。
> 若多人使用相同的 `TENANT_TAG`，會在公開伺服器上看到彼此的資料，
> **建議將 `TENANT_TAG` 改成獨一無二的字串**（例如加上學號或亂數）。

## 測試

```bash
npm test
```

由於部分雲端環境的網路政策會阻擋對外連線，測試會啟動一個**本地端記憶體版 FHIR 伺服器**
（`test/mock-fhir-server.js`，模仿 HAPI 的 CRUD/search），完整跑過
「建檔 → 打卡 → 結算 → 簽核 → 撥款」流程，並驗證：

- 情境 A 月薪制：應發 46,080、扣款 2,440、實發 **43,640**
- 情境 B 純時薪：實發 **8,645**，且勞健保未誤扣
- 情境 D：缺簽退 → 結算阻斷 → 補登 → 工時重算 → 可結算
- 權限分流：打卡端不外洩任何薪資欄位
- 合庫媒體檔 `salary.txt` 格式與匯總列正確

> 目前 28 項斷言全數通過。要對真正的 HAPI 伺服器做整合測試，直接在能連外網的電腦上 `npm start` 與 `npm run seed` 即可。

## 專案結構

```
.
├── server.js                  # Express 後端進入點（靜態檔 + API + 健檢）
├── public/
│   ├── clock.html             # 員工打卡端（自含 CSS/JS）
│   └── admin.html             # 會計室核銷端（自含 CSS/JS）
├── src/
│   ├── config.js              # 設定與 FHIR 命名常數
│   ├── fhirClient.js          # FHIR REST 客戶端（自動貼租戶標記 / _tag 過濾）
│   ├── mappers.js             # domain ↔ FHIR 轉換、工時換算
│   ├── services/
│   │   ├── payroll.js         # 薪資裁決（月薪制／純時薪）
│   │   └── bankfile.js        # 合庫媒體轉帳檔產生器
│   └── routes/
│       ├── clock.js           # /api/clock        員工打卡端（最小揭露）
│       ├── practitioners.js   # /api/practitioners 人事 CRUD
│       ├── scheduling.js      # /api/scheduling    Schedule/Slot/Appointment
│       ├── attendance.js      # /api/attendance    出勤稽核與補登
│       ├── claims.js          # /api/claims        結算與簽核
│       └── payout.js          # /api/payout        撥款媒體檔
├── scripts/seed.js            # 灌入情境 A/B 範例資料
└── test/
    ├── mock-fhir-server.js    # 本地端記憶體版 FHIR（測試用）
    └── run.js                 # 端對端測試
```

## 模型化備註

- 計畫書將「薪資請款/核准」對應到 FHIR 的 `Claim`／`ClaimResponse`。
  本系統以 `Practitioner` 代表受款員工，故 `Claim.patient`／`ClaimResponse.patient` 指向該 `Practitioner`（為符合計畫書「以 Practitioner 為人事主體」之設計選擇）。
- 薪資/保費/銀行等非標準欄位以自訂 `extension` 承載於 `Practitioner`；
  完整薪資明細以 JSON 存於 `Claim`／`ClaimResponse` 的自訂 extension，方便前端原樣呈現與產生媒體檔。
