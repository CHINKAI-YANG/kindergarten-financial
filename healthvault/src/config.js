// 健康幣 HealthVault — 系統設定與 FHIR 命名常數
// 所有可調參數皆可由環境變數覆寫（見 .env.example）。
// 經濟模型的預設值取自企劃書〈附錄：規則速查〉與〈6.1 發幣與消費規則〉。

export const config = {
  // 後端服務埠（預設 3100，與幼兒園專案的 3000 區隔，可同時啟動）
  port: Number(process.env.PORT || 3100),

  // 目標 FHIR 伺服器。預設指向慈濟 FHIR 測試伺服器；
  // 在能連外網的電腦執行 `npm start` 即可直接上傳資料。
  fhirBaseUrl: (process.env.FHIR_BASE_URL || 'https://tzuchi-fhir.ddns.net/fhir').replace(/\/+$/, ''),

  // 租戶標記：公開／共用伺服器上以 meta.tag + _tag 過濾，確保只讀寫本平台資料。
  // 多人共用同一伺服器時，請改成獨一無二的字串（例如加上學號）。
  tenantTag: process.env.TENANT_TAG || 'healthvault-demo',

  // 健康幣顯示用單位
  coinUnitLabel: process.env.COIN_UNIT_LABEL || '健康幣',

  // ── 發幣規則（企劃書 6.1 / 附錄）──────────────────────────────
  stepsPerCoin: Number(process.env.STEPS_PER_COIN || 1000), // 1,000 步 = 1 幣（無條件捨去）
  aerobicWeight: Number(process.env.AEROBIC_WEIGHT || 1.2), // 有氧達標加權（上限 1.2）
  aerobicHrMin: Number(process.env.AEROBIC_HR_MIN || 90), // 有氧心率區間下限（bpm）
  aerobicHrMax: Number(process.env.AEROBIC_HR_MAX || 160), // 有氧心率區間上限（bpm）
  dailyEarnCap: Number(process.env.DAILY_EARN_CAP || 50), // 單日發幣上限
  dailySpendCap: Number(process.env.DAILY_SPEND_CAP || 100), // 單日消費上限（靜態載具止損線）

  // ── 防偽門檻 ──────────────────────────────────────────────
  // 單次同步步數 > 15,000 步/小時 視為異常並拒絕（搖手機神器／外掛）
  antiFraudStepsPerHour: Number(process.env.ANTI_FRAUD_STEPS_PER_HOUR || 15000),
  // 即時手機同步未提供時間窗時，保守假設的時間窗（小時）
  defaultSyncWindowHours: Number(process.env.DEFAULT_SYNC_WINDOW_HOURS || 1),

  // 管理／發卡端登入密碼（註冊使用者與總覽需授權；消費者/Kiosk/POS 端為展示方便免登入）
  adminPassword: process.env.ADMIN_PASSWORD || 'health1234',
};

// FHIR 命名系統（identifier / coding / extension 的 system URL）
export const SYSTEMS = {
  tenant: 'http://healthvault.tw/fhir/tenant',
  // 虛擬錢包 UUID：同時掛在 Patient 與 Account 上作為對外識別（關聯阻斷：對商戶只露 UUID）
  walletId: 'http://healthvault.tw/fhir/wallet-id',
  wristband: 'http://healthvault.tw/fhir/wristband-uid', // 無手機長者的手環 UID（Kiosk 代同步用）
  txnType: 'http://healthvault.tw/fhir/txn-type', // 帳本交易類別 earn/spend/adjust
  obsCategory: 'http://healthvault.tw/fhir/observation-category',
  idempotency: 'http://healthvault.tw/fhir/idempotency-key', // 冪等鍵（杜絕重複入帳/重複扣款）
  coin: 'http://healthvault.tw/fhir/coin', // valueQuantity 的健康幣單位 system
  item: 'http://healthvault.tw/fhir/health-item', // 健康物資品項代碼
};

// 自訂 extension（承載快取餘額、每日計數與交易明細）
export const EXT = {
  balance: 'http://healthvault.tw/fhir/ext/balance', // Account 快取餘額（決策一律以帳本重算為準）
  dailyEarned: 'http://healthvault.tw/fhir/ext/daily-earned',
  dailySpent: 'http://healthvault.tw/fhir/ext/daily-spent',
  dailySteps: 'http://healthvault.tw/fhir/ext/daily-steps',
  dailyDate: 'http://healthvault.tw/fhir/ext/daily-date',
  frozenReason: 'http://healthvault.tw/fhir/ext/frozen-reason',
  txnDetail: 'http://healthvault.tw/fhir/ext/txn-detail', // 帳本明細 JSON（商戶/品項/步數/加權）
  stepDetail: 'http://healthvault.tw/fhir/ext/step-detail', // 步數憑證明細 JSON
};

// Observation 分類碼：步數憑證 vs 健康幣帳本（同一 Patient 下以 category 區分）
export const OBS_CATEGORY = {
  step: 'activity', // 標準 observation-category：身體活動（步數心率憑證）
  ledger: 'health-coin-ledger', // 自訂：健康幣帳本流水
};

// 交易類別
export const TXN = { earn: 'earn', spend: 'spend', adjust: 'adjust' };

// LOINC 觀測碼
export const LOINC = {
  steps: '55423-8', // Number of steps in unspecified time Pedometer
  heartRate: '8867-4', // Heart rate
};

// Account 狀態（企劃書情境四：active / on-hold，皆為 FHIR R4 合法值）
export const ACCOUNT_STATUS = { active: 'active', onHold: 'on-hold' };
