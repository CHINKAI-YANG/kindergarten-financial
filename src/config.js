// 系統設定與 FHIR 命名常數
// 所有可調參數皆可由環境變數覆寫（見 .env.example）

export const config = {
  // 後端服務埠
  port: Number(process.env.PORT || 3000),

  // 目標 FHIR 伺服器：預設為 HAPI 公開測試伺服器
  // 在自己的電腦執行 `npm start` 即可直接上傳到此伺服器。
  fhirBaseUrl: (process.env.FHIR_BASE_URL || 'https://hapi.fhir.org/baseR4').replace(/\/+$/, ''),

  // 幣別
  currency: process.env.CURRENCY || 'TWD',

  // 合作金庫銀行代碼（媒體轉帳檔用）
  defaultBankCode: process.env.BANK_CODE || '006',

  // 勞健保「員工自付」有效費率（以投保薪資為基數自動計算代扣金額）。
  // 為簡化版預設值，實務費率請於此調整：
  //   勞保自付 ≈ 2.4%（普通事故 11%×20% + 就保 1%×20%）
  //   健保自付 ≈ 1.55%（一般費率 5.17%×30%，不含眷屬）
  laborInsuranceRate: Number(process.env.LABOR_INS_RATE || 0.024),
  healthInsuranceRate: Number(process.env.HEALTH_INS_RATE || 0.0155),

  // 租戶標記：HAPI 為公眾共用伺服器，所有資源都會貼上這個 meta.tag，
  // 之後搜尋一律以 _tag 過濾，確保只讀寫「本園」的資料。
  // 若多人共用同一公開伺服器，請把 TENANT_TAG 改成獨一無二的字串以免互相干擾。
  tenantTag: process.env.TENANT_TAG || 'morninglight-kg-demo',

  // 會計室核銷端登入密碼。打卡端免密碼（櫃檯公用）；簽核/薪資等管理 API 一律需此密碼。
  // ★ 正式使用請務必改成自己的密碼（設定環境變數 ADMIN_PASSWORD）。
  adminPassword: process.env.ADMIN_PASSWORD || 'admin1234',

  // 寄信設定（忘記簽退提醒）。未設定 SMTP_HOST 時走「乾跑」模式：只記錄不真的寄出，方便展示。
  // 要真的寄信，請設定 SMTP_HOST/PORT/USER/PASS（例如 Gmail 應用程式密碼）與 MAIL_FROM。
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
  },
  mailFrom: process.env.MAIL_FROM || '益民幼兒園 <no-reply@morninglight.kindergarten>',

  // 自動檢查「忘記簽退」並寄提醒的間隔（小時）；設 0 可關閉自動（仍可手動寄送）。
  reminderIntervalHours: Number(process.env.REMINDER_INTERVAL_HOURS ?? 6),
};

// 常見銀行代碼對照（帳號清楚顯示用）
export const BANKS = {
  '004': '臺灣銀行', '005': '土地銀行', '006': '合作金庫', '007': '第一銀行',
  '008': '華南銀行', '009': '彰化銀行', '011': '上海商銀', '012': '台北富邦',
  '013': '國泰世華', '017': '兆豐銀行', '700': '中華郵政', '822': '中國信託',
};

// FHIR 命名系統（identifier / coding / extension 的 system URL）
export const SYSTEMS = {
  tenant: 'http://morninglight.kindergarten/fhir/tenant',
  employeeId: 'http://morninglight.kindergarten/fhir/employee-id',
  workType: 'http://morninglight.kindergarten/fhir/work-type',
  claimId: 'http://morninglight.kindergarten/fhir/settlement-id',
  serial: 'http://morninglight.kindergarten/fhir/serial-no', // 收入流水號
};

// Practitioner 上承載薪資/保費/銀行/裝置資訊的自訂 extension
export const EXT = {
  baseSalary: 'http://morninglight.kindergarten/fhir/ext/base-salary',
  hourlyRate: 'http://morninglight.kindergarten/fhir/ext/hourly-rate',
  afterCareRate: 'http://morninglight.kindergarten/fhir/ext/aftercare-rate',
  overtimeRate: 'http://morninglight.kindergarten/fhir/ext/overtime-rate',
  insuredSalary: 'http://morninglight.kindergarten/fhir/ext/insured-salary', // 投保薪資
  autoInsurance: 'http://morninglight.kindergarten/fhir/ext/auto-insurance', // 是否自動計算勞健保
  laborInsurance: 'http://morninglight.kindergarten/fhir/ext/labor-insurance', // 手動覆寫金額
  healthInsurance: 'http://morninglight.kindergarten/fhir/ext/health-insurance', // 手動覆寫金額
  bankCode: 'http://morninglight.kindergarten/fhir/ext/bank-code',
  bankAccount: 'http://morninglight.kindergarten/fhir/ext/bank-account',
  deviceToken: 'http://morninglight.kindergarten/fhir/ext/device-token', // 打卡綁定之裝置
  bindingOpen: 'http://morninglight.kindergarten/fhir/ext/binding-open', // 會計是否已開放綁定
  reminded: 'http://morninglight.kindergarten/fhir/ext/reminded', // 該出勤已寄過忘記簽退提醒
  payroll: 'http://morninglight.kindergarten/fhir/ext/payroll-detail',
};

// 出勤工作類別（影響月薪制的加給計算）
export const WORK_TYPES = {
  regular: { code: 'regular', display: '正常班' },
  aftercare: { code: 'aftercare', display: '課後延護' },
  overtime: { code: 'overtime', display: '行政加班' },
};
